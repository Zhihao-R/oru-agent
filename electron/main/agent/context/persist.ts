/**
 * 工具结果源头落盘（v0.4）
 *
 * 单条 tool result detail 超阈值（2k token 估算）时由 stream.ts 调用：
 *   1. 写盘到 ~/.oru/users/<uid>/conversations/<agentId>/<convId>-tool-cache/<callId>.<ext>
 *   2. 返回路径 → 由调用方填 ToolResult.persistedRef = { path, totalChars, preview }
 *   3. historyAdapter 看到 persistedRef 时把 preview 发给 LLM（detail 仍留 JSONL 给 UI）
 *
 * 设计取舍见 docs/tech/2026-05-15-tool-result-persist-tech-design.md。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool } from '@shared/agent/backend';
import { conversationToolCacheDir } from '../../runtime/paths';
import { estimateTokens } from './tokenEstimate';

/** 单条 tool result detail 超此 token 估算 → 走落盘 */
export const PERSIST_TOKEN_THRESHOLD = 2000;

/** 落盘后给 LLM 看的预览前缀长度（字符） */
export const PREVIEW_CHAR_LIMIT = 1500;

/**
 * 判断给定工具的 detail 是否需要落盘。
 *
 * - persistPolicy='never'：永不落盘
 * - persistPolicy='always'：永远落盘
 * - persistPolicy='auto' / undefined / tool=undefined：detail 估算超阈值才落
 */
export function shouldPersist(tool: AgentTool | undefined, detail: string): boolean {
  const policy = tool?.persistPolicy ?? 'auto';
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  return estimateTokens(detail) > PERSIST_TOKEN_THRESHOLD;
}

/**
 * 把工具结果 detail 写到 .tool-cache/<callId>.<ext>，返回绝对路径。
 * 父目录不存在自动创建。
 *
 * 安全：callId / ext 来自 backend——Anthropic 是 UUID 风格安全，OpenAI 兼容下 LLM 自己生成
 * function call.id 不可控。强制白名单校验：拒绝任何含路径分隔符 / `..` / 非常规字符的 id，
 * 防止 LLM 通过工具调用 id 把文件写到沙盒外（CWE-22 路径遍历）。
 */
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EXT_PATTERN = /^[A-Za-z0-9]{1,8}$/;

export async function writeToolCacheFile(args: {
  ownerId: string;
  agentId: string;
  conversationId: string;
  callId: string;
  ext: string;
  content: string;
}): Promise<string> {
  if (!CALL_ID_PATTERN.test(args.callId)) {
    throw new Error(`[persist] invalid callId for cache filename: ${JSON.stringify(args.callId)}`);
  }
  if (!EXT_PATTERN.test(args.ext)) {
    throw new Error(`[persist] invalid ext for cache filename: ${JSON.stringify(args.ext)}`);
  }
  const dir = conversationToolCacheDir(args.ownerId, args.agentId, args.conversationId);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${args.callId}.${args.ext}`);
  await fs.writeFile(path, args.content, 'utf-8');
  return path;
}

/**
 * 落盘结果的 read_file 取回引导句——buildPreview 的提示行与折叠占位（applyTier1Folding）
 * 共用这一句，措辞一处定义、日后改一处两处同变（G65）。JSON.stringify 兜住含引号的路径。
 */
export function readFileHint(path: string): string {
  return `调用 read_file({ path: ${JSON.stringify(path)} }) 取全文`;
}

/**
 * 构造给 LLM 看的预览文本：前 PREVIEW_CHAR_LIMIT 字 + 引用提示行。
 *
 * 短文本（≤ PREVIEW_CHAR_LIMIT 字）也加引用提示——这样 Twin 总能拿到路径调 read_file，
 * 不需要分支逻辑判断"预览是否完整"。
 */
export function buildPreview(detail: string, path: string): string {
  const totalChars = detail.length;
  if (totalChars <= PREVIEW_CHAR_LIMIT) {
    return detail + `\n\n[内容已落盘；全文 ${totalChars} 字符，${readFileHint(path)}]`;
  }
  const head = detail.slice(0, PREVIEW_CHAR_LIMIT);
  return head + `\n\n[内容已截断；全文 ${totalChars} 字符，${readFileHint(path)}]`;
}

/**
 * 清理对话的 .tool-cache/ 目录。clearConversation / deleteConversation 时调。
 * 目录不存在静默通过。
 */
export async function clearToolCacheForConversation(args: {
  ownerId: string;
  agentId: string;
  conversationId: string;
}): Promise<void> {
  const dir = conversationToolCacheDir(args.ownerId, args.agentId, args.conversationId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // 静默——目录不存在或一并清失败都不阻塞 clear/delete 主流程
  }
}
