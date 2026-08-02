/**
 * buildCommentPrompt 行为：
 *   1. 同一 task 多次调 → stable 字符串完全相等
 *   2. 不同 task 调 → stable 仍完全相等（核心不变量：cache 命中关键）
 *   3. dynamic 段含 task.title / task.status / task.assignee
 *   4. task.description undefined → dynamic '(无)'
 *   5. task.projectTag undefined → dynamic '无'
 *   6. stable 段不含任何 task 字段值（防御：保证不变量）
 */
import './__smoke_isolate__';

import type { BoardTask } from '@shared/types';
import { buildCommentPrompt } from '../../electron/main/taskboard/prompt';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

function mkTask(over: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 'bt_test',
    ownerId: 'local-user',
    title: '测试任务',
    description: undefined,
    status: '待办',
    assignee: 'you',
    projectTag: undefined,
    createdAt: 0,
    updatedAt: 0,
    commentCount: 0,
    ...over,
  };
}

async function main() {
  // 用 sentinel 字符串区别 task 字段 vs stable 段固有词
  // 不要用 status 枚举值做 stable 不含检查——stable 指令中明确列举了 4 个状态名
  const t1 = mkTask({
    title: '__SMOKE_TITLE_X1__',
    description: '__SMOKE_DESC_X1__',
    projectTag: '__SMOKE_TAG_X1__',
    status: '进行中',
  });
  const t2 = mkTask({
    title: '__SMOKE_TITLE_X2__',
    description: '__SMOKE_DESC_X2__',
    projectTag: '__SMOKE_TAG_X2__',
    status: '已完成',
  });
  const t3 = mkTask({ title: '__SMOKE_TITLE_X3__' });

  // case 1: 同一 task 多次调 → stable 相等
  const p1a = buildCommentPrompt({ task: t1 });
  const p1b = buildCommentPrompt({ task: t1 });
  assert(p1a.stable === p1b.stable, '同一 task 多次调 stable 相等');
  assert(p1a.dynamic === p1b.dynamic, '同一 task 多次调 dynamic 也相等');

  // case 2: 不同 task → stable 仍相等
  const p2 = buildCommentPrompt({ task: t2 });
  const p3 = buildCommentPrompt({ task: t3 });
  assert(p1a.stable === p2.stable, 't1 vs t2 stable 相等');
  assert(p1a.stable === p3.stable, 't1 vs t3 stable 相等');

  // case 3: dynamic 含 task 字段
  assert(p1a.dynamic.includes('__SMOKE_TITLE_X1__'), 'dynamic 含 t1.title');
  assert(p1a.dynamic.includes('进行中'), 'dynamic 含 t1.status');
  assert(p1a.dynamic.includes('you'), 'dynamic 含 t1.assignee');
  assert(p1a.dynamic.includes('__SMOKE_TAG_X1__'), 'dynamic 含 t1.projectTag');

  // case 4: description undefined → '(无)'
  assert(p3.dynamic.includes('描述：(无)'), 't3.description undefined → "(无)"');

  // case 5: projectTag undefined → '无'
  assert(p3.dynamic.includes('项目 tag：无'), 't3.projectTag undefined → "无"');

  // case 6: stable 不含 task 自由文本字段（title / description / projectTag）
  //   注：status 枚举值（'进行中' / '已完成' 等）合法地出现在 stable 指令文本中
  //   （规则 2 / 7 都举例了状态名），不在本检查范围
  assert(!p1a.stable.includes('__SMOKE_TITLE_X1__'), 'stable 不含 t1.title');
  assert(!p1a.stable.includes('__SMOKE_DESC_X1__'), 'stable 不含 t1.description');
  assert(!p1a.stable.includes('__SMOKE_TAG_X1__'), 'stable 不含 t1.projectTag');

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
