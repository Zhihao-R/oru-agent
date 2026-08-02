/**
 * debug derive FSM smoke
 *
 * 验证 StreamDeriver 的三种核心场景：
 * 1. 串行：assistant_text → tool_use(A) → tool_result(A) → assistant_text → result
 * 2. 并行：assistant_text → tool_use(A,B,C) → tool_result(A,C,B) → result
 * 3. 错误：tool_result.isError=true → round_done.hadError=true
 */
import './__smoke_isolate__';

import { StreamDeriver } from '../../electron/main/debug/derive';
import type { DebugRecord, DebugEventType } from '@shared/debug/types';
import type { ConversationEvent } from '@shared/agent/backend';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function newDeriver(): { records: DebugRecord[]; deriver: StreamDeriver } {
  const records: DebugRecord[] = [];
  const meta = {
    roundId: 'r1',
    conversationId: 'c1',
    ownerId: 'local-user',
    agentId: 'a1',
    agentName: '小研',
    backendType: 'anthropic' as const,
    modelId: 'claude-sonnet-4-6',
    providerId: 'p1',
  };
  const deriver = new StreamDeriver(meta, (rec) => records.push(rec), Date.now(), 0);
  return { records, deriver };
}

function typesOf(records: DebugRecord[]): DebugEventType[] {
  return records.map((r) => r.type);
}

console.log('=== debug_derive smoke ===');

// ─── case 1: 串行（模拟 anthropic/openaiCompat：每次 LLM stream 结束发 llm_usage） ──
{
  const { records, deriver } = newDeriver();
  const evs: ConversationEvent[] = [
    { type: 'assistant_text', text: '我先看下文件。' },
    { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'foo.ts' } },
    // backend 在 stream 末发 llm_usage（含本次 LLM 的 tokens）；derive 据此 emit llm_call_done
    { type: 'llm_usage', inputTokens: 500, outputTokens: 30 },
    { type: 'tool_result', toolUseId: 't1', isError: false, content: 'file contents' },
    { type: 'assistant_text', text: '看完了，结论是……' },
    // 第二次 LLM stream 结束（无工具）的 llm_usage
    { type: 'llm_usage', inputTokens: 600, outputTokens: 80 },
    { type: 'result', resultText: '看完了，结论是……', isError: false },
  ];
  for (const ev of evs) deriver.feed(ev);
  deriver.finishRound(false);

  const types = typesOf(records);
  // 事件物理顺序：tool_use 来时立刻开 group，llm_usage 后才 emit llm_call_done——
  // 所以 llm_call_done 出现在 parallel_group_start / tool_call_start 之后。
  // 前端 buildTimelineModel 把 llm_call_done 重排到顶层（跨过 group），不在这里重排。
  const expected: DebugEventType[] = [
    'llm_call_start',
    'parallel_group_start',
    'tool_call_start',
    'llm_call_done',
    'tool_call_done',
    'parallel_group_done',
    'llm_call_start',
    'llm_call_done',
    'final_answer',
    'round_done',
  ];
  assert(
    JSON.stringify(types) === JSON.stringify(expected),
    '串行：事件序列正确',
    `actual=${JSON.stringify(types)}`,
  );

  const llmDones = records.filter((r) => r.type === 'llm_call_done') as DebugRecord<'llm_call_done'>[];
  assert(typeof llmDones[0].payload.firstTokenMs === 'number', '串行：LLM #1 含 firstTokenMs');
  assert(llmDones[0].payload.outputText === '我先看下文件。', '串行：LLM #1 outputText 正确');
  // 单次 token 来自 llm_usage：
  assert(llmDones[0].payload.inputTokens === 500, '串行：LLM #1 inputTokens=500');
  assert(llmDones[0].payload.outputTokens === 30, '串行：LLM #1 outputTokens=30');
  assert(llmDones[1].payload.inputTokens === 600, '串行：LLM #2 inputTokens=600');
  assert(llmDones[1].payload.outputTokens === 80, '串行：LLM #2 outputTokens=80');

  const roundDone = records.find((r) => r.type === 'round_done')! as DebugRecord<'round_done'>;
  assert(roundDone.payload.llmCallCount === 2, '串行：llmCallCount=2');
  assert(roundDone.payload.toolCallCount === 1, '串行：toolCallCount=1');
  assert(roundDone.payload.hadError === false, '串行：hadError=false');
}

// ─── case 2: 并行（3 个工具同组） ─────────────────────────
{
  const { records, deriver } = newDeriver();
  const evs: ConversationEvent[] = [
    { type: 'assistant_text', text: '同时跑 3 个工具。' },
    { type: 'tool_use', id: 'tA', name: 'read_file', input: { path: 'a.ts' } },
    { type: 'tool_use', id: 'tB', name: 'grep', input: { pattern: 'TODO' } },
    { type: 'tool_use', id: 'tC', name: 'list_directory', input: { path: 'src/' } },
    // 第一次 LLM stream 结束（出了 3 个 tool_use）
    { type: 'llm_usage', inputTokens: 800, outputTokens: 50 },
    { type: 'tool_result', toolUseId: 'tA', isError: false, content: 'A done' },
    { type: 'tool_result', toolUseId: 'tC', isError: false, content: 'C done' },
    { type: 'tool_result', toolUseId: 'tB', isError: false, content: 'B done' },
    // 第二次 LLM stream 结束（最后一次，无工具）
    { type: 'llm_usage', inputTokens: 1200, outputTokens: 100 },
    { type: 'result', resultText: '都跑完了', isError: false },
  ];
  for (const ev of evs) deriver.feed(ev);
  deriver.finishRound(false);

  // 期望：1 个 parallel_group 包 3 个 tool_call
  const groupStarts = records.filter((r) => r.type === 'parallel_group_start');
  const groupDones = records.filter((r) => r.type === 'parallel_group_done');
  const toolStarts = records.filter((r) => r.type === 'tool_call_start');
  const toolDones = records.filter((r) => r.type === 'tool_call_done');

  assert(groupStarts.length === 1, '并行：1 个 parallel_group_start');
  assert(groupDones.length === 1, '并行：1 个 parallel_group_done');
  assert(toolStarts.length === 3, '并行：3 个 tool_call_start');
  assert(toolDones.length === 3, '并行：3 个 tool_call_done');

  // 3 个 tool 都在同一个 group
  const groupId = (groupStarts[0] as DebugRecord<'parallel_group_start'>).payload.groupId;
  const allInGroup = toolStarts.every(
    (r) => (r as DebugRecord<'tool_call_start'>).payload.parallelGroupId === groupId,
  );
  assert(allInGroup, '并行：3 个 tool 共享同一 groupId');

  // group_done 的 llmCallIndex = 1（第一次 LLM 输出的产物）
  const gDone = groupDones[0] as DebugRecord<'parallel_group_done'>;
  assert(gDone.payload.llmCallIndex === 1, '并行：groupDone.llmCallIndex=1');

  // 序列里 group_done 在第三个 tool_call_done（B）之后
  const seqs = records.map((r) => r.type);
  const lastToolDoneIdx = seqs.lastIndexOf('tool_call_done');
  const groupDoneIdx = seqs.lastIndexOf('parallel_group_done');
  assert(groupDoneIdx > lastToolDoneIdx, '并行：group_done 在最后一个 tool_done 之后', `lastToolDoneIdx=${lastToolDoneIdx} groupDoneIdx=${groupDoneIdx}`);

  // round_done
  const roundDone = records.find((r) => r.type === 'round_done')! as DebugRecord<'round_done'>;
  assert(roundDone.payload.toolCallCount === 3, '并行：toolCallCount=3');
}

// ─── case 3: 错误 + claudeCode 兜底（不发 llm_usage）─────
// 模拟 ClaudeCodeBackend 路径——SDK 不暴露单次 token usage，所以不发 llm_usage 事件。
// derive 必须用 result 兜底 endLlmCall，inputTokens/outputTokens 留 undefined。
{
  const { records, deriver } = newDeriver();
  const evs: ConversationEvent[] = [
    { type: 'assistant_text', text: '尝试读文件。' },
    { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'missing.ts' } },
    { type: 'tool_result', toolUseId: 't1', isError: true, content: 'ENOENT' },
    { type: 'result', resultText: '失败了', isError: true },
  ];
  for (const ev of evs) deriver.feed(ev);
  deriver.finishRound(true); // runner 看到 isError=true 时传 true

  const toolDone = records.find((r) => r.type === 'tool_call_done')! as DebugRecord<'tool_call_done'>;
  assert(toolDone.payload.isError === true, '错误：tool_call_done.isError=true');

  const roundDone = records.find((r) => r.type === 'round_done')! as DebugRecord<'round_done'>;
  assert(roundDone.payload.hadError === true, '错误：round_done.hadError=true');

  // claudeCode 兜底：每个 LLM 调用都有 llm_call_done，token 字段缺失但不抛错
  const llmDones = records.filter((r) => r.type === 'llm_call_done') as DebugRecord<'llm_call_done'>[];
  assert(llmDones.length >= 1, '兜底：claudeCode 路径仍 emit llm_call_done');
  assert(llmDones[0].payload.inputTokens === undefined, '兜底：无 llm_usage 时 inputTokens=undefined');
  assert(llmDones[0].payload.outputTokens === undefined, '兜底：无 llm_usage 时 outputTokens=undefined');
}

// ─── case 4: usage 累加 ────────────────────────────────
{
  const { records, deriver } = newDeriver();
  const evs: ConversationEvent[] = [
    { type: 'assistant_text', text: 'hi' },
    {
      type: 'result',
      resultText: 'hi',
      isError: false,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        actualModel: 'claude-sonnet-4-6',
        extended: { cacheReadTokens: 50 },
      },
    },
  ];
  for (const ev of evs) deriver.feed(ev);
  deriver.finishRound(false);

  const finalAns = records.find((r) => r.type === 'final_answer')! as DebugRecord<'final_answer'>;
  assert(finalAns.payload.totalInputTokens === 100, 'usage：totalInputTokens=100');
  assert(finalAns.payload.totalOutputTokens === 20, 'usage：totalOutputTokens=20');
  assert(finalAns.payload.finalModel === 'claude-sonnet-4-6', 'usage：finalModel=claude-sonnet-4-6');
}

// ─── 汇总 ──────────────────────────────────────────────
const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(1);
}
