/**
 * edit_file AgentTool —— 局部片段替换（old→new），不重写整篇。
 *
 * 匹配以精确为准，唯一容忍弯引号↔直引号（findActualString）；歧义（多处命中）拒绝；
 * 找不到如实报"没找到"。编辑前撞防盲覆盖守卫（op='edit'：读过即可 + 目标在已读范围内）。
 * 只 emit proposal，落盘由 executeFileWriteProposal 执行。
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { readWithMeta, makePatch } from '../../fs/safeWrite';
import { findActualString, preserveQuoteStyle, applyEdit, countMatches } from '../../fs/editMatch';
import { buildFileWriteProposal } from '../../proposals/makeFileWriteProposal';
import {
  checkGuard,
  guardErrorText,
  MAX_TARGET_MOVED_RETRIES,
  retryPausedText,
  targetMovedGate,
} from '../conversationFileState';
import { assertWritableSandbox, SandboxError } from './pathSandbox';
import { proposeOrExecuteFileWrite } from './emitProposal';
import type { StructuredMarkers } from '@shared/agent/structuredMarkers';

const TOOL_DESC = `把文件里的一个片段替换成新内容，只动那一处、不重写整篇。改大文件的一处时首选这个（比 write_file 整篇重写更轻、更不会动坏别处）。

**匹配规则（精确、不猜）**：old_string 按原样精确匹配文件内容；唯一被容忍的差异是弯引号↔直引号（你输不出弯引号时可用直引号，回写会自动保留文件原本的弯引号风格）。除此之外不做任何近似——不忽略空格、大小写、缩进。
- 没精确命中 → 报"没找到"，请重新 read_file 看现状再试，别挑个相近的地方改。
- old_string 在文件里出现多处 → 默认拒绝。要么把 old_string 补上更多上下文锁定唯一一处，要么传 replace_all=true 显式全部替换。

**编辑前必须先 read_file 读过该文件**（整读，或至少读到包含目标片段的那一段）。

入参：path（绝对路径）、old_string（要被替换的原片段）、new_string（替换成什么，可为空=删除该片段）、replace_all（可选，默认 false）。`;

export function makeEditFileTool(): AgentTool {
  return {
    name: 'edit_file',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件绝对路径' },
        old_string: { type: 'string', description: '要被替换的原片段（按原样精确匹配）' },
        new_string: { type: 'string', description: '替换成的新片段（可为空串=删除该片段）' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配（默认 false；多处命中时必须显式传 true）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const { path, old_string, new_string, replace_all } = (input ?? {}) as {
        path?: string;
        old_string?: string;
        new_string?: string;
        replace_all?: boolean;
      };
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { isError: true, text: 'edit_file: path 不能为空' };
      }
      if (!isAbsolute(path)) {
        return { isError: true, text: `edit_file: path 必须是绝对路径，得到 "${path}"` };
      }
      if (typeof old_string !== 'string' || old_string.length === 0) {
        return { isError: true, text: 'edit_file: old_string 不能为空' };
      }
      if (typeof new_string !== 'string') {
        return { isError: true, text: 'edit_file: new_string 必须是字符串（可为空串=删除）' };
      }
      if (old_string === new_string) {
        return { isError: true, text: 'edit_file: old_string 与 new_string 相同，无改动' };
      }

      try {
        await assertWritableSandbox(path, ctx);
      } catch (e) {
        if (e instanceof SandboxError) return { isError: true, text: `edit_file: ${e.message}` };
        throw e;
      }

      if (!existsSync(path)) {
        return { isError: true, text: `edit_file: 文件不存在：${path}。新建文件请用 write_file。` };
      }

      // 守卫（op='edit'：读过即可 + 目标在已读范围内）。先于匹配——能给"先读那段"的精确指引。
      const g = checkGuard(ctx.conversationId, path, 'edit', old_string);
      if (g === 'target-moved') {
        // 用户恰改了目标段：指引重读重试，但带上限——持续改时不无限重试（活锁防线，技术设计 §6/§11.9）
        const gate = targetMovedGate(ctx.conversationId, path);
        if (gate.paused) return { isError: true, text: `edit_file: ${retryPausedText(path)}` };
        return {
          isError: true,
          text: `edit_file: ${guardErrorText(g, path)}（第 ${gate.tries}/${MAX_TARGET_MOVED_RETRIES} 次重试）`,
        };
      }
      if (g !== 'ok') return { isError: true, text: `edit_file: ${guardErrorText(g, path)}` };

      const content = readWithMeta(path).content;

      const actualOld = findActualString(content, old_string);
      if (actualOld === null) {
        return {
          isError: true,
          text: `edit_file: 没找到要替换的片段（已尝试弯引号/直引号等价匹配）。请重新 read_file 看现状，确认 old_string 与文件完全一致再试：${path}`,
        };
      }

      const n = countMatches(content, actualOld);
      if (n > 1 && !replace_all) {
        // 多处命中同样计入 recovery（S02 · G89 review）：用户持续粘贴出重复段时不无限重试，
        // 与 target-moved 共用同一计数（都是「定位不稳」，编辑成功落盘时一并 reset）。
        const gate = targetMovedGate(ctx.conversationId, path);
        if (gate.paused) return { isError: true, text: `edit_file: ${retryPausedText(path)}` };
        return {
          isError: true,
          text: `edit_file: old_string 在文件里出现 ${n} 处。请重新 read_file 看现状，补充更多上下文让它唯一，或传 replace_all=true 显式全部替换：${path}（第 ${gate.tries}/${MAX_TARGET_MOVED_RETRIES} 次重试）`,
        };
      }

      const actualNew = preserveQuoteStyle(old_string, actualOld, new_string);
      const updated = applyEdit(content, actualOld, actualNew, replace_all ?? false);
      const diff = makePatch(content, updated, path);

      const proposal = buildFileWriteProposal({
        conversationId: ctx.conversationId,
        path,
        mode: 'edit',
        oldString: actualOld,
        newString: actualNew,
        replaceAll: replace_all ?? false,
        diff,
      });

      return proposeOrExecuteFileWrite(ctx, proposal, {
        approvalText: `已递交编辑提案：${path}（替换${n > 1 ? ` ${n} 处` : ''}）`,
        // 信任模式：直接落盘，把 diff 作为工具结果返回（chip 展开即见改动）
        resultText: diff,
        structured: { fileChanges: [{ path, op: 'modify' }] } satisfies StructuredMarkers,
      });
    },
  };
}
