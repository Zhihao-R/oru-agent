/**
 * append_file AgentTool —— 往文件末尾追加内容（表格加行的主力）。
 *
 * 它存在的理由是**让正确的路同时是最省的路**。此前"往表尾加一行"这个动作没有对应的原语：
 * write_file 要吐出整张表、edit_file 要精确匹配最后一行，bash + python 只需吐那一行——模型
 * 选 bash 是理性的，而 bash 那条路不过定型，python 的 csv.writer 默认写 CRLF，产出的表在
 * 用户下次打开时被判为不规范（2026-07-26 那次会话的真实产物就是这样）。
 *
 * **追加是独立的一种写，不是 overwrite 的特例**（proposal mode = 'append'）。这不是为省事绕开
 * 覆盖守卫——守卫问的是"你会不会拿过时认知盖掉新内容"，而追加动不了已有内容，这个问题在它身上
 * 不成立，所以它既不需要先读过、也不该强制审批（同 edit）。真正的拼接在执行器的 workfile 锁内做，
 * 审批窗口期别人也往这个文件写过时两笔都不丢。
 *
 * 反过来，它也拿不到整篇覆盖的两项记账：模型只供了尾巴、没见过整篇，所以落盘后 D3 所有权凭据
 * 与"已读"记录一并归零（executeFileWriteProposal 的 forgetAfterBlindWrite）——否则"加一行"会附带
 * 解锁"整篇覆盖免审"，随后的 read_file 也会命中去重 stub 拿不到内容。
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { readWithMeta, makePatch, DIFF_PREVIEW_MAX_BYTES } from '../../fs/safeWrite';
import { joinAppend } from '../../fs/appendText';
import { buildFileWriteProposal } from '../../proposals/makeFileWriteProposal';
import { assertWritableSandbox, SandboxError } from './pathSandbox';
import { proposeOrExecuteFileWrite } from './emitProposal';
import type { StructuredMarkers } from '@shared/agent/structuredMarkers';

const TOOL_DESC = `把内容追加到文件末尾。文件不存在就新建。

**该用**：往 CSV 表尾加一行或几行；往日志/笔记末尾续写。**这是加行的正确路径**——别用 bash 的 >> 重定向或 python 写表，那条路不过 Oru 的表格定型，会写出混合行尾的文件。

**注意**：
- 只追加，绝不改动已有内容。你不必先 read_file——工具自己会读现状。
- .csv 会在追加后整篇定型（摘掉不必要的引号、行尾统一），并保证新内容从新的一行开始；**列顺序要跟表头对上**，不确定就先 read_file 看一眼表头。
- 非 .csv 是逐字面追加，不会替你补换行——要另起一行就自己在 content 开头写 \\n。
- 追加之后你并没有看过这个文件的全文；要整篇覆盖它，仍须先 read_file 整读一遍。

入参：path（绝对路径，须在可写范围内）、content（要追加的内容）。`;

export function makeAppendFileTool(): AgentTool {
  return {
    name: 'append_file',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件绝对路径（不存在会新建，父目录会自动补齐）' },
        content: { type: 'string', description: '要追加到末尾的内容' },
      },
      required: ['path', 'content'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const { path, content: tail } = (input ?? {}) as { path?: string; content?: string };
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { isError: true, text: 'append_file: path 不能为空' };
      }
      if (!isAbsolute(path)) {
        return { isError: true, text: `append_file: path 必须是绝对路径，得到 "${path}"` };
      }
      if (typeof tail !== 'string' || tail.length === 0) {
        return { isError: true, text: 'append_file: content 不能为空（没有要追加的内容）' };
      }

      try {
        await assertWritableSandbox(path, ctx);
      } catch (e) {
        if (e instanceof SandboxError) return { isError: true, text: `append_file: ${e.message}` };
        throw e;
      }

      const exists = existsSync(path);
      if (!exists) {
        // 空文件加一段 = 新建（定型口径与追加同一份 joinAppend，产出不因走哪条分支而不同）
        const content = joinAppend(path, '', tail);
        const proposal = buildFileWriteProposal({
          conversationId: ctx.conversationId,
          path,
          mode: 'create',
          content,
        });
        return proposeOrExecuteFileWrite(ctx, proposal, {
          approvalText: `已递交新建写入提案：${path}`,
          resultText: `已写入新文件：${path}（${Buffer.byteLength(content, 'utf-8')} 字节）`,
          structured: { fileChanges: [{ path, op: 'create' }] } satisfies StructuredMarkers,
        });
      }

      // 卡面预览按此刻磁盘算（真正的拼接在锁内重做一次）：diff 只是给人看的近似，
      // 审批窗口期文件若变过，落盘结果以锁内那次为准——追加不会因此丢字，故不设基线拒写。
      const base = readWithMeta(path).content;
      const preview = joinAppend(path, base, tail);
      const diff =
        base.length <= DIFF_PREVIEW_MAX_BYTES && preview.length <= DIFF_PREVIEW_MAX_BYTES
          ? makePatch(base, preview, path)
          : undefined;

      const proposal = buildFileWriteProposal({
        conversationId: ctx.conversationId,
        path,
        mode: 'append',
        appendText: tail,
        diff,
      });

      return proposeOrExecuteFileWrite(ctx, proposal, {
        approvalText: `已递交追加提案：${path}`,
        resultText: `已追加到 ${path}`,
        structured: { fileChanges: [{ path, op: 'modify' }] } satisfies StructuredMarkers,
      });
    },
  };
}
