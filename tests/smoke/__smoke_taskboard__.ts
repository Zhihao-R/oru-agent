/**
 * 任务 BoardTask store smoke——验证：
 * 1. createTask + listTasks 基础路径
 * 2. listTasks 全套 filter（status / projectTag / assignee / includeDeleted / q）
 * 3. q 搜描述（标题命中 + 描述命中合并；不重复）
 * 4. updateTask 字段白名单（系统字段不可越界写）
 * 5. updateTask 跨入 '已完成' 设 completedAt；跨离清空
 * 6. softDeleteTask 后默认 list 看不到；includeDeleted=true 看得到
 * 7. restoreTask 后回主视图；幂等
 * 8. 不存在任务的 update / delete / restore 抛 BOARD_TASK_NOT_FOUND
 * 9. 已删除任务的 update 抛 BOARD_TASK_DELETED
 *
 * 不打 ws；不依赖网络。
 */
import './__smoke_isolate__';

import {
  createTask,
  listTasks,
  getTask,
  updateTask,
  softDeleteTask,
  restoreTask,
} from '../../electron/main/taskboard/store';

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
    const err = e as { code?: string; message?: string };
    assert(err?.code === expectedCode, name, `actual code: ${err?.code}, message: ${err?.message}`);
  }
}

async function main() {
  // ─── case 1: create + list 基础 ───
  const t1 = await createTask({ title: '调研竞品定价', projectTag: '营销' }, 'you');
  assert(t1.id.startsWith('bt_'), 'createTask 返回的 id 是 bt_ 前缀');
  assert(t1.commentCount === 0, 'createTask 默认 commentCount=0');
  assert(t1.status === '待办', 'createTask 默认 status=待办');
  assert(t1.assignee === 'you', 'createTask 默认 assignee 用 by 参数');

  const t2 = await createTask({ title: '改 chat 状态机', assignee: 'oru', projectTag: 'oru' }, 'you');
  const t3 = await createTask({ title: '写 PRD', description: '新功能调研报告', projectTag: '营销' }, 'you');

  const all = await listTasks();
  assert(all.length === 3, 'listTasks 返回 3 条', `actual: ${all.length}`);
  assert(!all.some(t => 'description' in t), 'listTasks 返回的 meta 不含 description');

  // ─── case 2: filter ───
  const byStatus = await listTasks({ status: ['待办'] });
  assert(byStatus.length === 3, 'filter status=[待办] 返回 3 条（全 todo）');

  const byTag = await listTasks({ projectTag: '营销' });
  assert(byTag.length === 2 && byTag.every(t => t.projectTag === '营销'), 'filter projectTag=营销 返回 2 条');

  const byAssignee = await listTasks({ assignee: 'oru' });
  assert(byAssignee.length === 1 && byAssignee[0].assignee === 'oru', 'filter assignee=oru 返回 1 条');

  // ─── case 3: q 搜描述 ───
  // 此刻：t1 title="调研竞品定价" / t2 title="改 chat 状态机" / t3 title="写 PRD" desc="新功能调研报告"
  // q="调研" 同时命中 t1 标题 + t3 描述，结果应是 2 条（合并去重）
  const qResearch = await listTasks({ q: '调研' });
  const qResearchIds = qResearch.map(t => t.id).sort();
  assert(qResearchIds.length === 2 && qResearchIds.includes(t1.id) && qResearchIds.includes(t3.id),
    'q="调研" 同时命中 t1 标题 + t3 描述',
    `got ${qResearch.length}: ${qResearch.map(t => t.title).join(',')}`);

  // q="调研报告" 只命中 t3 描述（t1 / t2 的标题/描述都不含这个词）
  const qByDesc = await listTasks({ q: '调研报告' });
  assert(qByDesc.length === 1 && qByDesc[0].id === t3.id, 'q="调研报告" 命中描述（标题没这个词）');

  // q="改" 只命中 t2 标题（t1/t3 的标题/描述都不含"改"）
  const qChange = await listTasks({ q: '改' });
  assert(qChange.length === 1 && qChange[0].id === t2.id, 'q="改" 只命中 t2 标题');

  // ─── case 4: updateTask 字段白名单 ───
  await updateTask(t1.id, { title: '调研竞品定价（深入版）' });
  const t1After = await getTask(t1.id);
  assert(t1After?.title === '调研竞品定价（深入版）', 'updateTask 改 title 生效');

  // 越界改 commentCount —— 类型层就拒绝；运行时也忽略（不在 ALLOWED_PATCH_FIELDS）
  // @ts-expect-error 故意越界测试 runtime 守卫
  await updateTask(t1.id, { commentCount: 999 });
  const t1AfterBypass = await getTask(t1.id);
  assert(t1AfterBypass?.commentCount === 0, '越界字段 commentCount 不被 patch 写入');

  // 危险系统字段也必须被守卫（id / ownerId / createdAt / deletedAt 等）——
  // 模拟攻击者通过类型 hole（如 ws 协议没校验）塞进危险字段
  const beforeId = t1AfterBypass!.id;
  const beforeOwner = t1AfterBypass!.ownerId;
  const beforeCreated = t1AfterBypass!.createdAt;
  // 用 cast 整体绕过 TS 类型检查，模拟运行时收到非法 patch
  await updateTask(t1.id, {
    id: 'bt_hacker',
    ownerId: 'hacker',
    createdAt: 0,
    deletedAt: 1,
  } as unknown as Parameters<typeof updateTask>[1]);
  const t1Hardened = await getTask(t1.id);
  assert(t1Hardened?.id === beforeId, 'updateTask 不能改 id');
  assert(t1Hardened?.ownerId === beforeOwner, 'updateTask 不能改 ownerId');
  assert(t1Hardened?.createdAt === beforeCreated, 'updateTask 不能改 createdAt');
  assert(t1Hardened?.deletedAt === undefined, 'updateTask 不能注入 deletedAt（避免假删除）');

  // ─── case 5: completedAt 维护 ───
  await updateTask(t2.id, { status: '已完成' });
  const t2Done = await getTask(t2.id);
  assert(typeof t2Done?.completedAt === 'number', 'status=已完成 后打了 completedAt');

  const completedAtFirst = t2Done?.completedAt;
  // 等待几 ms 后改描述，确认 completedAt 不被刷新（同时 updatedAt 应该会刷）
  await new Promise(r => setTimeout(r, 5));
  await updateTask(t2.id, { description: '改个描述' });
  const t2DescChanged = await getTask(t2.id);
  assert(t2DescChanged?.completedAt === completedAtFirst, '已完成状态下改 description 不动 completedAt');

  await updateTask(t2.id, { status: '进行中' });
  const t2Reopened = await getTask(t2.id);
  assert(t2Reopened?.completedAt === undefined, '从已完成跳出后清空 completedAt');

  // ─── case 6: softDelete + restore ───
  await softDeleteTask(t3.id, 'you');
  const afterDelete = await listTasks();
  assert(!afterDelete.some(t => t.id === t3.id), '默认 list 看不到已删除任务');

  const withDeleted = await listTasks({ includeDeleted: true });
  const t3Meta = withDeleted.find(t => t.id === t3.id);
  assert(t3Meta != null && typeof t3Meta.deletedAt === 'number', 'includeDeleted=true 看得到回收站，且带 deletedAt');
  assert(t3Meta?.preDeleteStatus === '待办', 'preDeleteStatus 记录删除前的状态');

  await restoreTask(t3.id);
  const afterRestore = await listTasks();
  assert(afterRestore.some(t => t.id === t3.id), '恢复后回主视图');
  const t3Restored = await getTask(t3.id);
  assert(t3Restored?.deletedAt === undefined, 'restoreTask 清空 deletedAt');
  assert(t3Restored?.preDeleteStatus === undefined, 'restoreTask 清空 preDeleteStatus');

  // restore 幂等
  await restoreTask(t3.id);
  assert(true, 'restoreTask 对未删除任务幂等不报错');

  // ─── case 7: 错误路径 ───
  await expectThrowCode(
    () => updateTask('bt_nonexistent', { title: 'x' }),
    'BOARD_TASK_NOT_FOUND',
    'update 不存在任务抛 BOARD_TASK_NOT_FOUND',
  );
  await expectThrowCode(
    () => softDeleteTask('bt_nonexistent', 'you'),
    'BOARD_TASK_NOT_FOUND',
    'delete 不存在任务抛 BOARD_TASK_NOT_FOUND',
  );
  await expectThrowCode(
    () => restoreTask('bt_nonexistent'),
    'BOARD_TASK_NOT_FOUND',
    'restore 不存在任务抛 BOARD_TASK_NOT_FOUND',
  );

  // 已删除任务的 update
  await softDeleteTask(t1.id, 'you');
  await expectThrowCode(
    () => updateTask(t1.id, { title: 'x' }),
    'BOARD_TASK_DELETED',
    'update 已删除任务抛 BOARD_TASK_DELETED',
  );

  // ─── 汇总 ───
  const failed = RESULTS.filter(r => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(2);
});
