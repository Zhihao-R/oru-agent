/**
 * ensureCommentConversation 行为：
 *   1. 第一次调 → 创建评论 conv + task.commentConversationId 写入
 *   2. 第二次调 → 返回同一 conv（不重建）
 *   3. 已删任务 → 抛 BOARD_TASK_DELETED
 *   4. 不存在任务 → 抛 BOARD_TASK_NOT_FOUND
 */
import './__smoke_isolate__';

import {
  createTask,
  ensureCommentConversation,
  getTask,
  softDeleteTask,
} from '../../electron/main/taskboard/store';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
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
  // case 1: 第一次创建
  const t1 = await createTask({ title: '评论基础测试 1' }, 'you');
  const r1 = await ensureCommentConversation(t1.id);
  assert(r1.conv.kind === 'taskboard-comment', '创建出 kind=taskboard-comment 的 conv');
  assert(r1.conv.boardTaskId === t1.id, 'conv.boardTaskId 指向 task');
  assert(r1.task.commentConversationId === r1.conv.id, 'task.commentConversationId 写回成功');

  // 验证 BoardTask 已落盘
  const fresh = await getTask(t1.id);
  assert(fresh?.commentConversationId === r1.conv.id, 'BoardTask 持久化 commentConversationId');

  // case 2: 第二次返回同一 conv
  const r2 = await ensureCommentConversation(t1.id);
  assert(r2.conv.id === r1.conv.id, '第二次调返回同一 conv（不重建）');

  // case 3: 已删任务
  const t2 = await createTask({ title: '评论基础测试 2' }, 'you');
  await softDeleteTask(t2.id, 'you');
  await expectThrowCode(
    () => ensureCommentConversation(t2.id),
    'BOARD_TASK_DELETED',
    '已删任务 → BOARD_TASK_DELETED',
  );

  // case 4: 不存在任务
  await expectThrowCode(
    () => ensureCommentConversation('bt_nonexistent_xxx'),
    'BOARD_TASK_NOT_FOUND',
    '不存在任务 → BOARD_TASK_NOT_FOUND',
  );

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
