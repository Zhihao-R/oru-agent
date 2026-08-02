/**
 * incrementCommentCount 行为：
 *   1. 调用一次 → task.commentCount +1 + updatedAt 刷新
 *   2. 多次累加正确
 *   3. task 不存在 → 静默 log 不抛
 *   4. task 已删除 → 静默 log 不抛（append 路径不应因计数失败而崩）
 */
import './__smoke_isolate__';

import { createTask, getTask, incrementCommentCount, softDeleteTask } from '../../electron/main/taskboard/store';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function main() {
  const t1 = await createTask({ title: '测试任务' }, 'you');
  assert(t1.commentCount === 0, 'createTask 默认 commentCount=0');

  // case 1: 单次 +1
  await incrementCommentCount(t1.id);
  const after1 = await getTask(t1.id);
  assert(after1?.commentCount === 1, '一次后 commentCount=1');

  // case 2: 多次累加（避免 updatedAt 撞同一 ms 难以断言；只验 commentCount）
  await incrementCommentCount(t1.id);
  await incrementCommentCount(t1.id);
  await incrementCommentCount(t1.id);
  const after4 = await getTask(t1.id);
  assert(after4?.commentCount === 4, '四次后 commentCount=4');

  // case 3: 不存在的 task → 不抛
  let threw = false;
  try {
    await incrementCommentCount('bt_nonexistent_xxx');
  } catch (e) {
    threw = true;
    console.error('  unexpected throw:', e);
  }
  assert(!threw, 'incrementCommentCount 不存在 task 不抛错');

  // case 4: 已删除 task → 不抛
  await softDeleteTask(t1.id, 'you');
  threw = false;
  try {
    await incrementCommentCount(t1.id);
  } catch (e) {
    threw = true;
    console.error('  unexpected throw:', e);
  }
  assert(!threw, 'incrementCommentCount 已删 task 不抛错');
  const afterDel = await getTask(t1.id);
  assert(afterDel?.commentCount === 4, '已删 task 的 commentCount 不变（保留删除前值）');

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
