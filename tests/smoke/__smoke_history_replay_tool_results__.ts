/**
 * pipeSdkToEvents 流末尾完整 toolCalls 回传 smoke
 *
 * 验证决策 7.6 的关键修复：流式过程中累积的 toolCalls（含 result）在流结束时
 * 整体导出，给 router 落盘到 ChatMessage.toolCalls。这样 history replay 时
 * historyAdapter 能拿到完整的 tool_use + tool_result 配对。
 *
 * 不打 Claude；用模拟 EngineEvent 流喂进 pipeSdkToEvents。
 */
import './__smoke_isolate__';
import type { EngineEvent } from '../../electron/main/engine';
import { pipeSdkToEvents } from '../../electron/main/agent/stream';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function* mockStream(events: EngineEvent[]): AsyncIterable<EngineEvent> {
  for (const ev of events) yield ev;
}

async function main(): Promise<void> {
  console.log('=== history_replay_tool_results smoke ===');

  // case 1: 一次工具调用，结果完整
  const events1: EngineEvent[] = [
    { type: 'session', sessionId: 'sess_xxx' },
    { type: 'assistant_text', text: '我先列项目。' },
    { type: 'tool_use', id: 'tu_1', name: 'list_projects', input: {} },
    { type: 'tool_result', toolUseId: 'tu_1', isError: false, content: '共 1 个项目：foo' },
    { type: 'assistant_text', text: '看起来只有一个 foo。' },
    { type: 'result', resultText: '看起来只有一个 foo。', isError: false },
  ];
  const r1 = await pipeSdkToEvents(mockStream(events1), {
    conversationId: 'cnv_x',
    messageId: 'msg_x',
    ownerId: 'u1',
    agentId: 'twin',
    emit: () => {},
  });
  assert(r1.toolCalls.length === 1, '单 tool 调用：返回 1 个 toolCall', `len=${r1.toolCalls.length}`);
  if (r1.toolCalls.length === 1) {
    const tc = r1.toolCalls[0];
    assert(tc.name === 'list_projects', 'toolCall.name 正确', tc.name);
    assert(tc.status === 'success', 'tool 跑完 status 标 success', tc.status);
    assert(!!tc.result, 'tool 跑完带 result', JSON.stringify(tc.result));
    assert(tc.result?.isError === false, 'result.isError === false', String(tc.result?.isError));
    assert(
      (tc.result?.summary ?? '').includes('共 1 个项目'),
      'result.summary 含工具回执内容',
      tc.result?.summary,
    );
  }

  // case 2: 多个并发 tool（同 assistant 一轮发多个 tool_use）
  const events2: EngineEvent[] = [
    { type: 'session', sessionId: 'sess_2' },
    { type: 'tool_use', id: 'tu_a', name: 'tool_a', input: { x: 1 } },
    { type: 'tool_use', id: 'tu_b', name: 'tool_b', input: { y: 2 } },
    { type: 'tool_result', toolUseId: 'tu_a', isError: false, content: 'a-done' },
    { type: 'tool_result', toolUseId: 'tu_b', isError: false, content: 'b-done' },
    { type: 'result', resultText: 'finished', isError: false },
  ];
  const r2 = await pipeSdkToEvents(mockStream(events2), {
    conversationId: 'cnv_x',
    messageId: 'msg_y',
    ownerId: 'u1',
    agentId: 'twin',
    emit: () => {},
  });
  assert(r2.toolCalls.length === 2, '多 tool：返回 2 个 toolCall', `len=${r2.toolCalls.length}`);
  if (r2.toolCalls.length === 2) {
    const a = r2.toolCalls.find((t) => t.name === 'tool_a');
    const b = r2.toolCalls.find((t) => t.name === 'tool_b');
    assert(!!a?.result && !!b?.result, '两个 tool 都带 result', `a=${!!a?.result} b=${!!b?.result}`);
    assert(
      a?.result?.summary.includes('a-done') === true && b?.result?.summary.includes('b-done') === true,
      '两个 result.summary 各自正确',
      `a=${a?.result?.summary} b=${b?.result?.summary}`,
    );
  }

  // case 3: tool 出错 → status='error', result.isError=true
  const events3: EngineEvent[] = [
    { type: 'tool_use', id: 'tu_e', name: 'tool_err', input: {} },
    { type: 'tool_result', toolUseId: 'tu_e', isError: true, content: 'oops' },
    { type: 'result', resultText: '失败', isError: false },
  ];
  const r3 = await pipeSdkToEvents(mockStream(events3), {
    conversationId: 'cnv_x',
    messageId: 'msg_z',
    ownerId: 'u1',
    agentId: 'twin',
    emit: () => {},
  });
  assert(r3.toolCalls.length === 1, 'tool 出错：仍返回 1 个 toolCall', `len=${r3.toolCalls.length}`);
  if (r3.toolCalls.length === 1) {
    const tc = r3.toolCalls[0];
    assert(tc.status === 'error', 'tool 出错 status === error', tc.status);
    assert(tc.result?.isError === true, 'result.isError === true', String(tc.result?.isError));
  }

  // case 4: 悬空 tool_use（没收到 tool_result）→ result 缺失，status 仍是 running
  const events4: EngineEvent[] = [
    { type: 'tool_use', id: 'tu_orphan', name: 'tool_orphan', input: {} },
    { type: 'result', resultText: '中断', isError: false },
  ];
  const r4 = await pipeSdkToEvents(mockStream(events4), {
    conversationId: 'cnv_x',
    messageId: 'msg_o',
    ownerId: 'u1',
    agentId: 'twin',
    emit: () => {},
  });
  assert(r4.toolCalls.length === 1, '悬空 tool_use：仍返回 1 个 toolCall', `len=${r4.toolCalls.length}`);
  if (r4.toolCalls.length === 1) {
    const tc = r4.toolCalls[0];
    assert(!tc.result, '悬空：result 缺失（historyAdapter 据此识别）', JSON.stringify(tc.result));
    assert(tc.status === 'running', '悬空：status 仍为 running', tc.status);
  }

  // 总结
  const failed = RESULTS.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${RESULTS.length}`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${RESULTS.length} cases`);
}

main().catch((e) => {
  console.error('smoke unhandled error:', e);
  process.exit(1);
});
