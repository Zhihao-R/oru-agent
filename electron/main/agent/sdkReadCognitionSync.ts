/**
 * S02 · D2：SDK Read 的认知同步——PostToolUse 钩子把「模型经 SDK Read 看过什么」
 * 补进 conversationFileState，让守卫三对 SDK Read 与自有 read_file 一视同仁
 * （否则 claude-code 主路径每次「SDK Read → 写工具」都撞 never-read、常态多一轮重读）。
 *
 * 不解析 SDK 的 tool_response（形态无契约，会漂移）：按 tool_input 的 file_path/offset/limit
 * 从磁盘重读、模拟 SDK 的返回切片。保守口径——判不准就记部分读（isPartialView=true），
 * 失败方向是「整篇覆盖前多要求一次 read_file 整读」，绝不把模型没看全的文件记成整读。
 *
 * 已知残余窗口：SDK 实际读盘与本钩子重读之间文件被改（毫秒级，协同实时落盘可命中），
 * 这里会记下模型没看过的新内容、其后 G88 基线比对误通过——字节由 overwrite-guard 兜底可找回，
 * 按实施方案接受为残余风险（docs/tech/2026-07-10-s02-ai写入路径收口实施方案.md §3）。
 */
import { existsSync } from 'node:fs';
import type { ToolContext } from '@shared/agent/backend';
import { floorMtime, readWithMetaAsync } from '../fs/safeWrite';
import { recordRead, type FileState } from './conversationFileState';

/**
 * SDK 0.1.77 内置 Read 的截断行为快照（与 SDK_BUILTIN_TOOLS_0_1_77 同一维护模式）：
 * 无 offset/limit 时默认只回前 2000 行；单行超 2000 字符会被截断行内容。
 * ⚠ 这是对 SDK 无契约内部行为的镜像——升级 SDK 时随内置工具清单一并复核（真机读一个
 * 超阈值文件对照），阈值变化只影响保守程度（记 partial 的面变宽/窄），不影响正确性方向。
 */
export const SDK_READ_DEFAULT_LINE_LIMIT_0_1_77 = 2000;
export const SDK_READ_MAX_LINE_CHARS_0_1_77 = 2000;

/**
 * 模拟 SDK Read 对整读内容的切片，返回「模型看到的那一段」的逼近值。
 * 整读判定（isPartialView=false）仅当：未传 offset/limit、全文行数 ≤ 默认截断阈值、
 * 且视野内无超长行——三者任缺即记部分读。
 */
export function emulateSdkReadView(
  fullContent: string,
  offset?: number,
  limit?: number,
): Pick<FileState, 'content' | 'isPartialView' | 'offset' | 'limit'> {
  const lines = fullContent.split('\n');
  const hasExplicitRange = offset !== undefined || limit !== undefined;
  const effOffset = offset ?? 1;
  const effLimit = limit ?? SDK_READ_DEFAULT_LINE_LIMIT_0_1_77;
  const view = lines.slice(effOffset - 1, effOffset - 1 + effLimit);
  const truncatedByLimit = lines.length > effOffset - 1 + effLimit;
  const hasLongLine = view.some((l) => l.length > SDK_READ_MAX_LINE_CHARS_0_1_77);
  const isPartialView = hasExplicitRange || truncatedByLimit || hasLongLine;
  return isPartialView
    ? { content: view.join('\n'), isPartialView: true, offset: effOffset, limit: effLimit }
    : { content: fullContent, isPartialView: false };
}

/**
 * 构造 PostToolUse 观察者：只订阅 SDK 内置 Read，落 recordRead。
 * 钩子绝不抛错（钩子失败 ≠ 回合失败），畸形入参 / 文件不存在一律静默跳过。
 */
export function makeSdkReadRecorder(
  ctx: ToolContext,
): (toolName: string, toolInput: unknown) => Promise<void> {
  return async (toolName, toolInput) => {
    if (toolName !== 'Read') return;
    try {
      const input = toolInput as { file_path?: unknown; offset?: unknown; limit?: unknown } | null;
      const path = input && typeof input.file_path === 'string' ? input.file_path : null;
      if (!path || !existsSync(path)) return;
      const offset = typeof input!.offset === 'number' ? input!.offset : undefined;
      const limit = typeof input!.limit === 'number' ? input!.limit : undefined;
      // readWithMetaAsync：BOM/CRLF 归一——与 read_file / commitWorkfileWrite 同一口径，
      // G88 基线比对不因换行风格误报（OpenRouter 体验约束：守卫零误报）。
      const { content } = await readWithMetaAsync(path);
      const view = emulateSdkReadView(content, offset, limit);
      recordRead(ctx.conversationId, path, { mtime: floorMtime(path), ...view });
    } catch {
      // 静默：认知同步是尽力而为的补充，读盘失败时宁可让守卫按 never-read 要求重读
    }
  };
}
