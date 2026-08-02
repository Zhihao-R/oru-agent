/**
 * isContextOverflowError smoke
 *
 * 验证撞墙错误识别覆盖三家 backend 的常见信号：
 * - Anthropic SDK：error.error.type / error.message
 * - OpenAI 兼容：HTTP 错误的 message 文本 / code 字段
 * - Claude Code SDK：抛出的 Error.message 含关键字
 *
 * 不打任何 LLM。
 */
import './__smoke_isolate__';
import { isContextOverflowError } from '../../electron/main/agent/backends/overflow';

const RESULTS: Array<{ name: string; ok: boolean }> = [];
function assert(cond: boolean, name: string): void {
  RESULTS.push({ name, ok: cond });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
}

console.log('=== overflow_detector smoke ===');

// ─── 应识别为 overflow ────────────────────────────────────
assert(
  isContextOverflowError(new Error('prompt is too long: 250000 tokens')),
  'Anthropic prompt too long',
);
assert(
  isContextOverflowError(new Error("This model's maximum context length is 200000 tokens")),
  'OpenAI maximum context length',
);
assert(
  isContextOverflowError(new Error('context_length_exceeded')),
  'OpenAI context_length_exceeded',
);
assert(
  isContextOverflowError({ code: 'context_length_exceeded', message: 'token limit' }),
  '结构化错误：code=context_length_exceeded',
);
assert(
  isContextOverflowError({
    error: { type: 'invalid_request_error', message: 'Prompt is too long for the model' },
  }),
  '嵌套错误：error.message',
);
assert(
  isContextOverflowError(new Error('Please reduce the length of the messages')),
  'OpenAI reduce length suggestion',
);
assert(
  isContextOverflowError('input is too long, please shorten it'),
  '裸字符串错误也能识别',
);
assert(
  isContextOverflowError(new Error('context window exceeded')),
  '"context window exceeded" 形态',
);

// ─── 不应识别为 overflow ──────────────────────────────────
assert(!isContextOverflowError(null), 'null 不是 overflow');
assert(!isContextOverflowError(undefined), 'undefined 不是 overflow');
assert(!isContextOverflowError(new Error('rate limit exceeded')), 'rate limit 不是 overflow');
assert(
  !isContextOverflowError(new Error('Authentication failed: invalid API key')),
  '鉴权失败不是 overflow',
);
assert(!isContextOverflowError({ status: 500 }), '裸 500 错误不是 overflow');
assert(!isContextOverflowError(new Error('Connection timeout')), '连接超时不是 overflow');

const passed = RESULTS.filter((r) => r.ok).length;
const total = RESULTS.length;
if (passed === total) {
  console.log(`\nPASS: all ${total} cases`);
  process.exit(0);
} else {
  console.log(`\nFAIL: ${passed}/${total} cases`);
  process.exit(1);
}
