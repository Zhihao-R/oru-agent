/**
 * dropOldestTurns smoke
 *
 * 验证撞墙重试时的"丢老消息"算法：
 * - 锚定 user 消息分轮
 * - 永远保留最后一条 user（本轮不能丢）
 * - 夹在两条 user 之间的 assistant / system / memory-record 跟着前一轮一起丢
 *
 * 不打任何 LLM。
 */
import './__smoke_isolate__';
import type { ChatMessage } from '@shared/types';
import { dropOldestTurns } from '../../electron/main/agent/runner';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

function mk(role: 'user' | 'assistant' | 'system', text: string): ChatMessage {
  return {
    id: text,
    conversationId: 'cnv',
    role,
    text,
    toolCalls: [],
    createdAt: 0,
    done: true,
  };
}

console.log('=== drop_oldest_turns smoke ===');

const h = [
  mk('user', 'u1'),
  mk('assistant', 'a1'),
  mk('system', '[abort terminator]'),
  mk('user', 'u2'),
  mk('assistant', 'a2'),
  mk('user', 'u3'), // 当前轮
];

// n=0：原样返回
{
  const r = dropOldestTurns(h, 0);
  assert(r.length === 6, 'n=0 不变', `len=${r.length}`);
}

// n=1：丢 u1 + a1 + system_terminator，留 u2 / a2 / u3
{
  const r = dropOldestTurns(h, 1);
  assert(r.length === 3, 'n=1 剩 3 条', `len=${r.length}`);
  assert(r[0].text === 'u2' && r[1].text === 'a2' && r[2].text === 'u3', 'n=1 顺序对', JSON.stringify(r.map((m) => m.text)));
}

// n=2：丢 u1/a1/sys/u2/a2，只留 u3
{
  const r = dropOldestTurns(h, 2);
  assert(r.length === 1, 'n=2 剩 1 条', `len=${r.length}`);
  assert(r[0].text === 'u3', 'n=2 留本轮', r[0].text);
}

// n=3：超出可丢轮数，仍至少保留本轮 user
{
  const r = dropOldestTurns(h, 3);
  assert(r.length === 1 && r[0].text === 'u3', 'n=3 兜底保留本轮', r[0].text);
}

// 边界：空数组
{
  const r = dropOldestTurns([], 1);
  assert(r.length === 0, '空数组 n=1 → 空', `len=${r.length}`);
}

// 边界：只有 1 条 user 消息（首轮新对话）
{
  const r = dropOldestTurns([mk('user', 'u1')], 1);
  assert(r.length === 1 && r[0].text === 'u1', '只有 1 条 user 时 n>=1 不丢', r[0].text);
}

// 边界：只有 system / assistant，没 user（异常但不应崩）
{
  const r = dropOldestTurns([mk('system', 's1'), mk('assistant', 'a1')], 5);
  assert(r.length === 2, '没 user 时按原样返回（无锚点）', `len=${r.length}`);
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
