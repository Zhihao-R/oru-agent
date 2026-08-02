/**
 * tokenEstimate smoke
 *
 * 验证字符比例算法在中英文混合 / 纯中文 / 纯英文 / 代码 几种样本上误差 ±15% 以内。
 * v0.4 新增：persistedRef 存在时 estimateMessageTokens 按 preview 估算（对齐"实际发 LLM 的字符"）。
 *
 * 不打任何 LLM。
 */
import './__smoke_isolate__';
import {
  estimateHistoryTokens,
  estimateMessageTokens,
  estimateTokens,
} from '../../electron/main/agent/context/tokenEstimate';
import type { ChatMessage } from '@shared/types';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== token_estimate smoke ===');

// 纯英文：约 1 token / 3.6 char ⇒ 100 char ≈ 28 token
{
  const t = estimateTokens('a'.repeat(100));
  assert(t === 28, '纯英文 100 char ≈ 28 token', `t=${t}`);
}

// 纯中文：1.5 token / 字 ⇒ 10 字 ≈ 15 token
{
  const t = estimateTokens('中文测试一下大概多少');
  assert(t === Math.ceil(10 * 1.5), '纯中文 10 字 ≈ 15 token', `t=${t}`);
}

// 中英混合：误差应在 ±15% 以内
{
  const text = 'Hello 你好，this is a 测试 with mixed content 包含中英文。';
  const t = estimateTokens(text);
  assert(t >= 24 && t <= 31, '混合内容估算合理', `t=${t}`);
}

// 空字符串
{
  assert(estimateTokens('') === 0, '空字符串 = 0 token');
}

// 估算单条消息（含 toolCall）— 无 persistedRef：按 detail 估
{
  const msg: ChatMessage = {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    text: 'short reply',
    toolCalls: [
      {
        id: 'tc1',
        name: 'list_projects',
        input: { detail: true },
        status: 'success',
        startedAt: 0,
        finishedAt: 0,
        result: {
          toolCallId: 'tc1',
          isError: false,
          summary: 'short summary',
          detail: 'long content '.repeat(50),
        },
      },
    ],
    createdAt: 0,
    done: true,
  };
  const t = estimateMessageTokens(msg);
  const detailTokens = estimateTokens('long content '.repeat(50));
  assert(t >= detailTokens, '无 persistedRef：按 detail 估算', `t=${t} detailT=${detailTokens}`);
}

// v0.4：persistedRef 存在 → 按 preview 估算（核心决策回归）
{
  const detail = 'D'.repeat(5000);
  const preview = 'P'.repeat(100);
  const msg: ChatMessage = {
    id: 'm2',
    conversationId: 'c1',
    role: 'assistant',
    text: '',
    toolCalls: [
      {
        id: 'tc2',
        name: 'web_fetch',
        input: {},
        status: 'success',
        startedAt: 0,
        finishedAt: 0,
        result: {
          toolCallId: 'tc2',
          isError: false,
          summary: 's',
          detail,
          persistedRef: { path: '/p', totalChars: detail.length, preview },
        },
      },
    ],
    createdAt: 0,
    done: true,
  };
  const t = estimateMessageTokens(msg);
  const previewT = estimateTokens(preview);
  const detailT = estimateTokens(detail);
  assert(t < detailT, 'v0.4：persistedRef 存在时 token 估算 << detail 估算', `t=${t} detailT=${detailT}`);
  // t 约等于 preview 的估算（+ tc.name + input JSON 字节）；至少不超过 preview + 50 token 余量
  assert(t <= previewT + 50, 'v0.4：估算接近 preview 字符数', `t=${t} previewT=${previewT}`);
}

// estimateHistoryTokens：累加所有消息
{
  const mk = (id: string, detail: string): ChatMessage => ({
    id,
    conversationId: 'c1',
    role: 'assistant',
    text: '',
    toolCalls: [
      {
        id: `tc_${id}`,
        name: 'x',
        input: {},
        status: 'success',
        startedAt: 0,
        finishedAt: 0,
        result: {
          toolCallId: `tc_${id}`,
          isError: false,
          summary: 's',
          detail,
        },
      },
    ],
    createdAt: 0,
    done: true,
  });
  const hist: ChatMessage[] = [
    mk('a', 'detail '.repeat(200)),
    mk('b', 'detail '.repeat(200)),
  ];
  const t = estimateHistoryTokens(hist);
  const each = estimateMessageTokens(hist[0]);
  assert(t === each * 2, '历史 token 等于每条消息估算之和', `t=${t} each=${each}`);
}

const passed = RESULTS.filter((r) => r.ok).length;
const total = RESULTS.length;
if (passed === total) {
  console.log(`\nPASS: all ${total} cases`);
  process.exit(0);
} else {
  console.log(`\nFAIL: ${passed}/${total} cases`);
  process.exit(1);
}
