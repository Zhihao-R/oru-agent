/**
 * conversations/store.ts 4 处过滤对 'taskboard-comment' kind 的行为：
 *
 * 1. createConversation('taskboard-comment') 落盘后，loadIndex 能读到（getConversation 不抛）
 * 2. listConversations 不返回评论 conv（filter 'sub' 行为保留）
 * 3. deleteConversation 拒绝评论 conv（必须经任务级 softDelete 路径）→ BOARD_COMMENT_CONV_PROTECTED
 * 4. createSubConversation thin wrapper 行为不变（kind='sub'，boardTaskId 不写）
 */
import './__smoke_isolate__';

import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import {
  createConversation,
  createSubConversation,
  deleteConversation,
  getConversation,
  listConversations,
} from '../../electron/main/conversations/store';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function expectThrowCode(f: () => Promise<unknown>, expectedCode: string, name: string): Promise<void> {
  try {
    await f();
    assert(false, name, `expected throw ${expectedCode} but resolved`);
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    assert(code === expectedCode, name, `actual code: ${code}`);
  }
}

async function main() {
  const agent = await ensureDefaultAgent();
  const seedConv = await createSubConversation(agent.id, '新对话');

  // case 1: 创建评论 conv → loadIndex / getConversation 能读到
  const commentConv = await createConversation({
    agentId: agent.id,
    title: '评论 · 测试任务',
    kind: 'taskboard-comment',
    boardTaskId: 'bt_smoke',
  });
  assert(commentConv.kind === 'taskboard-comment', 'createConversation kind=taskboard-comment 落盘');
  assert(commentConv.boardTaskId === 'bt_smoke', 'boardTaskId 写入');

  const round = await getConversation(agent.id, commentConv.id);
  assert(round.kind === 'taskboard-comment', 'getConversation 能读回评论 conv（loadIndex filter 放宽）');
  assert(round.boardTaskId === 'bt_smoke', 'getConversation 还原 boardTaskId');

  // case 2: listConversations 不返回评论 conv（filter sub 行为保留）
  const subConv = await createSubConversation(agent.id, '测试子对话');
  const list = await listConversations(agent.id);
  const ids = new Set(list.map((c) => c.id));
  assert(ids.has(subConv.id), 'listConversations 含子对话');
  assert(!ids.has(commentConv.id), 'listConversations 不含评论 conv（PRD 一致）');
  assert(list.some((c) => c.id === seedConv.id), 'listConversations 含刚建的对话');

  // case 3: deleteConversation 拒评论 conv
  await expectThrowCode(
    () => deleteConversation(agent.id, commentConv.id),
    'BOARD_COMMENT_CONV_PROTECTED',
    'deleteConversation 评论 conv → BOARD_COMMENT_CONV_PROTECTED',
  );

  // case 4: createSubConversation thin wrapper 行为不变
  assert(subConv.kind === 'sub', 'createSubConversation 仍是 kind=sub');
  assert(subConv.boardTaskId === undefined, 'createSubConversation 不写 boardTaskId');

  // 汇总
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
