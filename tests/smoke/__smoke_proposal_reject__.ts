/**
 * v0.6 proposal.reject smoke：
 * 1. writeRejectionSystemEvent 落一条 kind='system-event' 的 user 消息进 conv history
 * 2. 消息文本含 proposalId
 * 3. ChatMessage.kind === 'system-event'
 */
import './__smoke_isolate__';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function main() {
  // 准备一个 agent + conv（writeRejectionSystemEvent 内部走 listAgents().activeId）
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  const { createSubConversation, readHistory } = await import('../../electron/main/conversations/store');
  const { writeRejectionSystemEvent } = await import('../../electron/main/proposals/systemEvent');

  const agent = await ensureDefaultAgent();
  const conv = await createSubConversation(agent.id, '新对话');

  // 执行
  await writeRejectionSystemEvent(conv.id, 'prp_test_001');

  // 验证：以 `（系统记：` 开头的 user 消息（LLM 通过该约定识别为系统旁白）
  const history = await readHistory(agent.id, conv.id);
  const sysNotes = history.filter(
    (m) => m.role === 'user' && m.text.startsWith('（系统记：'),
  );
  assert(sysNotes.length === 1, `落了 1 条系统旁白，实际: ${sysNotes.length}`);
  const ev = sysNotes[0];
  assert(ev?.kind === undefined, `kind === undefined（已删 system-event 伪装）`);
  assert(
    ev?.text.includes('prp_test_001'),
    `内容含 proposalId，实际: ${ev?.text.slice(0, 80)}`,
  );
  assert(
    ev?.text.includes('用户在 UI 上拒绝'),
    `内容含拒绝模板，实际: ${ev?.text.slice(0, 80)}`,
  );

  // ─── 汇总 ───
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
