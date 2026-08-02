/**
 * convert_csv_encoding AgentTool —— 把 GBK / 带 BOM 的 CSV 转成 UTF-8 规范格式。
 *
 * 存在理由是「被闸门拦下的一方必须有一条它自己能走的路」：出口闸门（tableGate）遇到非 UTF-8 的
 * CSV 会拦下 write_file / edit_file / bash，此前给的出路是让用户去弹窗里点按钮——agent 按不了，
 * 于是它删掉原文件重建（2026-07-26 那次内容缩水且用户不知情）。本工具就是那条它能走的路。
 *
 * 为什么不是 write_file 的一个参数：转换的内容**全部来自磁盘现状**，模型一个字都不该供——
 * 它读 GBK 文件本就会读成乱码，让它复述整张表既贵又必然改坏字。这里读字节、解码、定型、写回，
 * 中间不经过模型。
 *
 * 两个 mode 对应两种不可逆性：
 *   - convert：原地重写全文件字节，原编码回不来 → 随覆盖同口径弹审批卡，caution 置位作卡面
 *     不可逆警示（2026-07-30 决策 7：并入 {overwrite} 整类授权——默认问，用户授权「覆盖既有
 *     内容」后免卡；原版进修改历史兜底）。
 *   - copy：另存一份规范副本，原件一个字节不动 → 建新文件语义，不强制审批。
 *
 * 它是全仓唯一一条不经 executeFileWriteProposal 的 file.write 落盘（理由见下面 execute 里的注释）。
 * 绕开统一执行器就得逐项接回它做的每一件事，不能整体绕过——已逐条判过：
 *   - 出口闸门的**草稿检查**：接回（下面显式调 assertTableGate）。守卫独立于审批，danger 挡不弹卡
 *     也要查，否则会盖掉编辑器里还没落盘的草稿（FileHistory 兜不到从未落盘的内容）。
 *   - 出口闸门的**编码检查**：跳过。本工具就是那道闸的出口，且整文件转码产不出混合编码。
 *   - **锁内基线**：接回（baseline = 提案发出那刻的磁盘字节）。审批可能分钟级，中途被改过要退回。
 *   - **防盲覆盖守卫**：不适用。它问的是"你会不会拿过时认知盖掉新内容"，而这里写出去的内容
 *     完全来自磁盘现状、模型一个字没供，基线已经把"现状变了"这件事挡住了。
 *   - **D3 所有权凭据**：不建立。模型没写过这份内容，不该因此获得整篇覆盖免审。
 *   - **冲突卡 defer**：不适用。冲突卡是协同编辑对 md 文本段的裁决，非 UTF-8 CSV 不进那条动线。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import type { StructuredMarkers } from '@shared/agent/structuredMarkers';
import { canonicalizeCsvText, decodeCsvBytes, isEncodingSafe } from '@shared/csv';
import { buildFileWriteProposal } from '../../proposals/makeFileWriteProposal';
import { commitWorkfileWrite } from '../../fs/workfileWrite';
import { readWithMeta } from '../../fs/safeWrite';
import { broadcastFileChanged } from '../../fs/fsChanged';
import { assertTableGate } from '../../proposals/tableGate';
import { assertWritableSandbox, SandboxError } from './pathSandbox';
import { proposeOrExecute } from './emitProposal';

const TOOL_DESC = `把 GBK 或带 BOM 的 CSV 转成 UTF-8 规范格式。表格内容一个字不变，只改文件的编码与引号/行尾风格。

**该用**：动手改某张表时被拦下、提示它不是 UTF-8 编码。这是那条拦截唯一的出路——不要试图删掉原文件重建，那会丢内容。

**mode**：
- 'convert'（默认）：原地转换。会重写整个文件的字节、原编码回不来，因此默认会弹卡让用户确认（用户已对「覆盖既有内容」点过始终允许则免卡直转）。
- 'copy'：另存一份规范副本（同目录，文件名后缀 -规范），原件一个字节不动。用户不愿意动原件时用这个，之后对副本操作。

转换完成后，重试刚才被拦下的那一步。文件本来就是 UTF-8 时会直接告诉你无需转换。

入参：path（CSV 的绝对路径）、mode（'convert' | 'copy'，默认 'convert'）。`;

/** 同目录下第一个没被占用的 `<原名>-规范[-n].csv`。 */
function pickCopyPath(absCsv: string): string {
  const stem = absCsv.replace(/\.csv$/i, '');
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? `${stem}-规范.csv` : `${stem}-规范-${i + 1}.csv`;
    if (!existsSync(candidate)) return candidate;
  }
}

export function makeConvertCsvEncodingTool(): AgentTool {
  return {
    name: 'convert_csv_encoding',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要转换的 CSV 绝对路径' },
        mode: {
          type: 'string',
          enum: ['convert', 'copy'],
          description: "convert=原地转换（弹卡确认，不可逆）；copy=另存规范副本、原件不动。默认 convert",
        },
      },
      required: ['path'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const { path, mode = 'convert' } = (input ?? {}) as { path?: string; mode?: string };
      if (typeof path !== 'string' || !isAbsolute(path)) {
        return { isError: true, text: `convert_csv_encoding: path 必须是绝对路径，得到 "${path}"` };
      }
      if (!path.toLowerCase().endsWith('.csv')) {
        return { isError: true, text: `convert_csv_encoding: 只处理 .csv，得到 "${path}"` };
      }
      if (mode !== 'convert' && mode !== 'copy') {
        return { isError: true, text: `convert_csv_encoding: mode 须为 convert/copy，得到 "${mode}"` };
      }

      try {
        await assertWritableSandbox(path, ctx);
      } catch (e) {
        if (e instanceof SandboxError) return { isError: true, text: `convert_csv_encoding: ${e.message}` };
        throw e;
      }

      let bytes: Buffer;
      try {
        bytes = await fs.readFile(path);
      } catch {
        return { isError: true, text: `convert_csv_encoding: 文件不存在或读不了：${path}` };
      }
      if (isEncodingSafe(new Uint8Array(bytes))) {
        return { text: `${path} 已经是 UTF-8 编码，不需要转换——直接继续你刚才的操作。` };
      }

      // 解码 + 定型：认不出结构的表（分号 / tab 分隔等）由 canonicalizeCsvText 的安全阀原样退回，
      // 只有编码被转到位，行列结构一个字不动。
      let content: string;
      try {
        content = canonicalizeCsvText(decodeCsvBytes(new Uint8Array(bytes)).text);
      } catch (e) {
        return {
          isError: true,
          text: `convert_csv_encoding: ${path} 的编码认不出来（既不是 UTF-8 也不是 GBK），没有转换。${e instanceof Error ? e.message : ''}`,
        };
      }

      // 草稿闸（守卫独立于审批：danger 挡不弹卡也要查）。只查草稿那半——编码那半本工具就是它的出口。
      // 闸门查询超时依赖 DEFAULT_TIMEOUT_MS=2000 默认；渲染端 dirtyFiles 的应答 cap=1200 严格小于它
      // （2026-08-02 闸门修复）。不要给这里传更小的 timeoutMs，除非同步收紧渲染端 cap。
      try {
        await assertTableGate([path], { cwd: dirname(path), skipEncodingCheck: true });
      } catch (e) {
        return { isError: true, text: `convert_csv_encoding: ${e instanceof Error ? e.message : String(e)}` };
      }

      if (mode === 'copy') {
        const target = pickCopyPath(path);
        const proposal = buildFileWriteProposal({
          conversationId: ctx.conversationId,
          path: target,
          mode: 'create',
          content,
        });
        return proposeOrExecute(ctx, proposal, {
          approvalText: `已递交另存规范副本提案：${target}`,
          execute: async () => {
            const r = await commitWorkfileWrite({ absPath: target, content, by: 'ai', expectAbsent: true });
            if (r.status === 'rejected') {
              return { isError: true, text: `convert_csv_encoding: ${target} 刚被占用，没有写入——重试一次。` };
            }
            await broadcastFileChanged(target, 'ai');
            return {
              text:
                `已另存规范副本：${target}（原件 ${basename(path)} 一个字节没动）。` +
                `务必告诉用户你换用了副本，并说清原表还在——否则他会盯着原表等数据。后续请对副本操作。`,
              structured: { fileChanges: [{ path: target, op: 'create' }] } satisfies StructuredMarkers,
            };
          },
        });
      }

      const proposal = buildFileWriteProposal({
        conversationId: ctx.conversationId,
        path,
        mode: 'overwrite',
        content,
        caution: 'encoding-conversion',
      });
      // 基线 = 提案发出这一刻的磁盘字节（与锁内读取同一口径：readWithMeta 的归一文本）。
      // 审批可能分钟级，中途文件被改过就拒写退回——转换是整篇重写，没有基线就是纯 last-writer-wins。
      const baseline = readWithMeta(path).content;
      return proposeOrExecute(ctx, proposal, {
        approvalText: `已递交编码转换提案：${path}（转 UTF-8 规范格式，需用户确认）`,
        execute: async () => {
          // 不走 executeFileWriteProposal：那条路要过防盲覆盖守卫（模型没读过这份内容、也读不了），
          // 还会再撞一次编码闸门——本工具正是那道闸门的出路，不能被它拦住自己。
          // 它做的其余每一件事都在文件头逐条判过、该接的已接回。
          const r = await commitWorkfileWrite({
            absPath: path,
            content,
            by: 'ai',
            mark: 'ai',
            baseline: { content: baseline },
          });
          if (r.status === 'rejected') {
            return {
              isError: true,
              text: `convert_csv_encoding: ${path} 在你等确认的这段时间里被改动过，转换已取消（没写一个字节）。重新调一次本工具即可。`,
            };
          }
          await broadcastFileChanged(path, 'ai');
          return {
            // 转换重写了全文件字节：模型此前若读过这张表，它手上那份认知已经过期，
            // 直说要重读，别让它撞一句「在你读过之后被改动过」再回头猜是谁改的。
            text: `已转为 UTF-8 规范格式：${path}。重新 read_file 看一眼现状，再重试刚才被拦下的那一步。`,
            structured: { fileChanges: [{ path, op: 'modify' }] } satisfies StructuredMarkers,
          };
        },
      });
    },
  };
}
