/**
 * 识别 backend 抛出的"上下文超长"错误（context overflow / context length exceeded）
 *
 * 各家信号不同，集中匹配。新发现的错误形态加进 PATTERNS。
 *
 * - Anthropic：HTTP 400，error.type='invalid_request_error'，message 含 'prompt is too long' / 'maximum context length'
 * - OpenAI 兼容：HTTP 400 / 413，code='context_length_exceeded'，message 含 'maximum context length' / 'token limit'
 * - Claude Code SDK：抛错，message 类似 'prompt too long' / 'context window'
 */

const PATTERNS: ReadonlyArray<RegExp> = [
  /context.{0,5}(length|window).{0,5}(exceeded|too.{0,5}long)/i,
  /prompt.{0,5}is.{0,5}too.{0,5}long/i,
  /prompt.{0,5}too.{0,5}long/i,
  /maximum.{0,5}context.{0,5}length/i,
  /token.{0,5}limit/i,
  /input.{0,5}is.{0,5}too.{0,5}long/i,
  /reduce.{0,15}length.{0,15}messages/i,
  /context_length_exceeded/i,
];

export function isContextOverflowError(err: unknown): boolean {
  if (!err) return false;

  // 优先看可能存在的结构化错误码
  const e = err as { code?: unknown; status?: unknown; type?: unknown; error?: unknown };
  if (typeof e.code === 'string' && /context_length_exceeded/i.test(e.code)) return true;
  if (e.error && typeof e.error === 'object') {
    const inner = e.error as { code?: unknown; type?: unknown; message?: unknown };
    if (typeof inner.code === 'string' && /context_length_exceeded/i.test(inner.code)) return true;
    if (typeof inner.message === 'string' && matchPatterns(inner.message)) return true;
  }

  const msg = extractMessage(err);
  if (msg && matchPatterns(msg)) return true;
  return false;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function matchPatterns(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}
