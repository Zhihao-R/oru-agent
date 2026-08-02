/**
 * write_file AgentTool —— 新建 / 覆盖文件，自动补父目录。
 *
 * 只 emit FileWriteProposal（决策 1：工具只构造 proposal，审批分叉收敛在 router）。
 * 覆盖前撞防盲覆盖守卫（决策 2，独立于审批）：必须本对话整读过且未被外部改动。
 * 落盘由 executeFileWriteProposal 执行（含落盘前守卫复检）。
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { canonicalizeCsvText } from '@shared/csv';
import { readWithMeta, makePatch, DIFF_PREVIEW_MAX_BYTES } from '../../fs/safeWrite';
import { buildFileWriteProposal } from '../../proposals/makeFileWriteProposal';
import { isAskOverridden } from '../../proposals/behaviorPolicy/store';
import {
  checkGuard,
  guardErrorText,
  isOwnedVersion,
  MAX_TARGET_MOVED_RETRIES,
  retryPausedText,
  targetMovedGate,
} from '../conversationFileState';
import { assertWritableSandbox, SandboxError } from './pathSandbox';
import { proposeOrExecuteFileWrite } from './emitProposal';
import type { StructuredMarkers } from '@shared/agent/structuredMarkers';

const TOOL_DESC = `新建文件并写入内容，或覆盖已存在的文件。父目录不存在会自动补齐。

**该用**：把整理好的内容存成文件；整篇重写一个文件。

**覆盖的硬规则**：覆盖已存在的文件前，必须本对话内先 read_file **整读**过它（不带 offset/limit）且它没被外部改动——否则会拒绝并要你先读。这是为了绝不拿过时认知盖掉新内容。只想改文件里一处，用 edit_file（更轻、不会动到别处），别用 write_file 整篇重写。

入参：path（绝对路径，须在可写范围内）、content（完整文件内容）。

落盘后会反馈完整路径。失败时按 isError 文案如实告诉用户（越界 / 守卫拒绝等）。`;

export function makeWriteFileTool(): AgentTool {
  return {
    name: 'write_file',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件绝对路径（父目录不存在会自动补齐）' },
        content: { type: 'string', description: '要写入的完整文件内容' },
      },
      required: ['path', 'content'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const { path, content: rawContent } = (input ?? {}) as { path?: string; content?: string };
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { isError: true, text: 'write_file: path 不能为空' };
      }
      if (!isAbsolute(path)) {
        return { isError: true, text: `write_file: path 必须是绝对路径，得到 "${path}"` };
      }
      if (typeof rawContent !== 'string') {
        return { isError: true, text: 'write_file: content 必须是字符串（可为空串）' };
      }
      // 表格的字节形态由 Oru 定义：整篇产出在这里一次定型（摘掉不必要的引号——模型爱给长文本
      // 裹引号，那会让文件不合「仅必要引号」的规范格式，用户随后保存时被问一句他无从判断的话）。
      // 定型必须发生在算 diff 之前：审批卡预览、回执字节数、落盘内容此后共用这一个 content，
      // 「所见即所批」才成立。canonicalizeCsvText 自带安全阀，认不出的表原样退回、绝不改坏。
      const content = path.toLowerCase().endsWith('.csv') ? canonicalizeCsvText(rawContent) : rawContent;

      try {
        await assertWritableSandbox(path, ctx);
      } catch (e) {
        if (e instanceof SandboxError) return { isError: true, text: `write_file: ${e.message}` };
        throw e;
      }

      // 覆盖前整读一次现状，三处共用（守卫基线比对 / D3 免审判定 / 小文件 diff）——
      // 大文件（deck HTML 等）正是迭代覆盖的主场，emit 路径只读这一次。
      const exists = existsSync(path);
      const currentContent = exists ? readWithMeta(path).content : undefined;
      if (exists) {
        const g = checkGuard(ctx.conversationId, path, 'overwrite', undefined, currentContent);
        if (g === 'baseline-moved') {
          // 读后被外部改动：指引重读重试，带上限——用户持续编辑时不无限重试（与 edit_file 同一道活锁防线）
          const gate = targetMovedGate(ctx.conversationId, path);
          if (gate.paused) return { isError: true, text: `write_file: ${retryPausedText(path)}` };
          return {
            isError: true,
            text: `write_file: ${guardErrorText(g, path)}（第 ${gate.tries}/${MAX_TARGET_MOVED_RETRIES} 次重试）`,
          };
        }
        if (g !== 'ok') return { isError: true, text: `write_file: ${guardErrorText(g, path)}` };
      }

      // D3 免审（磁盘是否仍是 AI 自己整篇产出的版本）+ 小文件顺带算 diff（大文件省略预览）。
      // 收紧覆盖（2026-07-31 策略表双向开关）：用户把「覆盖 Oru 自己的产出」拨成「每次问」→ D3 免审关闭。
      let diff: string | undefined;
      let ownedOverwrite = false;
      if (exists && currentContent !== undefined) {
        ownedOverwrite =
          isOwnedVersion(ctx.conversationId, path, currentContent) &&
          !(await isAskOverridden('aiOwned'));
        const oldBytes = statSync(path).size;
        const newBytes = Buffer.byteLength(content, 'utf-8');
        diff =
          oldBytes <= DIFF_PREVIEW_MAX_BYTES && newBytes <= DIFF_PREVIEW_MAX_BYTES
            ? makePatch(currentContent, content, path)
            : `（文件较大，省略 diff 预览：${oldBytes} → ${newBytes} 字节）`;
      }

      const proposal = buildFileWriteProposal({
        conversationId: ctx.conversationId,
        path,
        mode: exists ? 'overwrite' : 'create',
        content,
        diff,
        ownedOverwrite,
      });

      return proposeOrExecuteFileWrite(ctx, proposal, {
        approvalText: `已递交${exists ? '覆盖' : '新建'}写入提案：${path}`,
        // 信任模式：直接落盘。覆盖返回 diff（chip 展开即见改动），新建返回写入确认。
        resultText: exists
          ? (diff ?? `已覆盖：${path}`)
          : `已写入新文件：${path}（${Buffer.byteLength(content, 'utf-8')} 字节）`,
        structured: {
          fileChanges: [{ path, op: exists ? 'modify' : 'create' }],
        } satisfies StructuredMarkers,
      });
    },
  };
}
