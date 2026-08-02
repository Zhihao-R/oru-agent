/**
 * PR-B smoke：5 个 taskboard agent 工具串通 store + delete_task 自删守卫
 *
 * 11 个 case：
 * 1. list_tasks 串通 store（无 filter 看到全部）
 * 2. list_tasks 过滤组合（status + assignee）
 * 3. list_tasks include_deleted=false 默认排除回收站
 * 4. list_tasks include_deleted=true 看到回收站
 * 5. create_task 工具 → store 落盘
 * 6. create_task 默认 by='oru'（assignee 缺省时 store 取 'oru'）
 * 7. update_task 翻译 project_tag → projectTag
 * 8. update_task 错误路径返 isError（不抛异常）
 * 9. delete_task 自删守卫触发：ctx.boardCurrentTaskId === id → isError；任务实际未删
 * 10. delete_task 主聊天场景（ctx 无 boardCurrentTaskId）→ 删除成功
 * 11. delete_task 跨任务（ctx.boardCurrentTaskId=A, id=B）→ 删除成功
 * 12. restore_task 串通 store
 *
 * 不打 ws、不起 fake server——直接调 tool.execute(input, ctx)；
 * store 的 broadcast 副作用静默无害（ws server 没起）
 */
import './__smoke_isolate__';

import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';
import {
  makeCreateTaskTool,
  makeDeleteTaskTool,
  makeListTasksTool,
  makeRestoreTaskTool,
  makeUpdateTaskTool,
} from '../../electron/main/agent/agentTools/taskboard';
import * as store from '../../electron/main/taskboard/store';
import { createSubConversation } from '../../electron/main/conversations/store';

// 主对话已取消——main() 起始新建一条 sub 对话，承载各 ctx 的 conversationId
let CONV_ID = '';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return makeToolContext({
    conversationId: CONV_ID,
    agentId: 'twin',
    ownerId: 'local-user',
    onProposal: undefined, // 原工厂无 onProposal——taskboard 工具不经审批，保持背景语义
    ...overrides,
  });
}

async function main() {
  CONV_ID = (await createSubConversation('twin', '新对话')).id;
  const listTasks = makeListTasksTool();
  const createTask = makeCreateTaskTool();
  const updateTask = makeUpdateTaskTool();
  const deleteTask = makeDeleteTaskTool();
  const restoreTask = makeRestoreTaskTool();
  const ctx = makeCtx();

  // ─── 用 store 直接建 3 条任务，分布在不同 status / assignee / tag ───
  const a = await store.createTask({ title: '调研竞品', status: '待办', assignee: 'oru', projectTag: '营销' }, 'you');
  const b = await store.createTask({ title: '改 chat 状态机', status: '进行中', assignee: 'oru', projectTag: 'oru' }, 'you');
  const c = await store.createTask({ title: '写营销文案', status: '进行中', assignee: 'you', projectTag: '营销' }, 'you');

  // ─── case 1: list_tasks 无 filter ───
  {
    const r = await listTasks.execute({}, ctx);
    assert(!r.isError, 'case 1 list_tasks 无 filter 不报错');
    assert(r.text.includes(a.id) && r.text.includes(b.id) && r.text.includes(c.id), 'case 1 含 3 条 id');
    assert(r.text.includes('共 3 条'), 'case 1 含总数');
  }

  // ─── case 2: list_tasks 过滤 status + assignee ───
  {
    const r = await listTasks.execute({ status: ['进行中'], assignee: 'oru' }, ctx);
    assert(!r.isError, 'case 2 不报错');
    assert(r.text.includes(b.id), 'case 2 命中 b（进行中 + oru）');
    assert(!r.text.includes(a.id) && !r.text.includes(c.id), 'case 2 不含 a/c');
  }

  // ─── case 3: include_deleted 默认 false ───
  await store.softDeleteTask(a.id, 'you');
  {
    const r = await listTasks.execute({}, ctx);
    assert(!r.text.includes(a.id), 'case 3 默认不含已删 a');
    assert(r.text.includes(b.id), 'case 3 仍含 b');
  }

  // ─── case 4: include_deleted=true ───
  {
    const r = await listTasks.execute({ include_deleted: true }, ctx);
    assert(r.text.includes(a.id), 'case 4 显式 true 时含已删 a');
    assert(r.text.includes('回收站'), 'case 4 输出含"回收站"分组标签');
  }

  // ─── case 5: create_task → store 落盘 ───
  {
    const r = await createTask.execute({ title: '新建测试 X', assignee: 'you', project_tag: '测试' }, ctx);
    assert(!r.isError, 'case 5 不报错');
    const m = r.text.match(/\[([^\]]+)\]/);
    assert(m != null, 'case 5 text 含新 id');
    if (m) {
      const newId = m[1];
      const t = await store.getTask(newId);
      assert(t != null && t.title === '新建测试 X' && t.assignee === 'you' && t.projectTag === '测试',
        'case 5 store 落盘正确（含 project_tag → projectTag 翻译）');
    }
  }

  // ─── case 6: create_task 默认 by='you'（不传 assignee 时归用户做，PRD §四主场景）───
  {
    const r = await createTask.execute({ title: '默认归属测试' }, ctx);
    const m = r.text.match(/\[([^\]]+)\]/);
    if (m) {
      const t = await store.getTask(m[1]);
      assert(t?.assignee === 'you', 'case 6 不传 assignee 时 store.assignee === "you"（默认归用户做）');
    }
  }

  // ─── case 7: update_task 翻译 project_tag → projectTag ───
  {
    const r = await updateTask.execute({ id: b.id, fields: { project_tag: '研发' } }, ctx);
    assert(!r.isError, 'case 7 不报错');
    const t = await store.getTask(b.id);
    assert(t?.projectTag === '研发', 'case 7 store.projectTag 已翻译并写入');
  }

  // ─── case 8: update_task 错误路径返 isError（不抛）───
  {
    let threw = false;
    let r;
    try {
      r = await updateTask.execute({ id: 'bt_does_not_exist', fields: { title: 'x' } }, ctx);
    } catch (e) {
      threw = true;
    }
    assert(!threw, 'case 8 工具不抛异常出执行体');
    assert(r?.isError === true, 'case 8 返 isError=true');
    assert(r?.text.includes('BOARD_TASK_NOT_FOUND') === true, 'case 8 text 含错误码');
  }

  // ─── case 9: delete_task 自删守卫 ───
  {
    const ctxWithCurrent = makeCtx({ boardCurrentTaskId: c.id });
    const r = await deleteTask.execute({ id: c.id }, ctxWithCurrent);
    assert(r.isError === true, 'case 9 自删守卫触发 isError');
    assert(r.text.includes('破坏当前评论线') || r.text.includes('当前评论线'),
      'case 9 text 含破坏评论线提示');
    const t = await store.getTask(c.id);
    assert(t?.deletedAt === undefined, 'case 9 任务未真删');
  }

  // ─── case 10: delete_task 主聊天场景（ctx 无 boardCurrentTaskId）───
  {
    const r = await deleteTask.execute({ id: c.id }, ctx);
    assert(!r.isError, 'case 10 主聊天场景删除成功');
    const t = await store.getTask(c.id);
    assert(typeof t?.deletedAt === 'number', 'case 10 任务实际进入回收站');
  }

  // ─── case 11: delete_task 跨任务（ctx.boardCurrentTaskId=A, id=B 不同）───
  {
    // 新建一个目标和一个"当前评论线"任务
    const target = await store.createTask({ title: '待删目标' }, 'oru');
    const currentLine = await store.createTask({ title: '当前评论线挂的任务' }, 'oru');
    const ctxCross = makeCtx({ boardCurrentTaskId: currentLine.id });
    const r = await deleteTask.execute({ id: target.id }, ctxCross);
    assert(!r.isError, 'case 11 跨任务删除不被守卫拦');
    const t = await store.getTask(target.id);
    assert(typeof t?.deletedAt === 'number', 'case 11 target 实际删除');
    const cl = await store.getTask(currentLine.id);
    assert(cl?.deletedAt === undefined, 'case 11 当前评论线任务未受影响');
  }

  // ─── case 11.5: 自删守卫的异常注入值不触发拦截（review 反馈：truthy 校验）───
  {
    const target = await store.createTask({ title: '守卫异常值测试' }, 'oru');
    // 空串 boardCurrentTaskId
    const ctxEmpty = makeCtx({ boardCurrentTaskId: '' });
    const r1 = await deleteTask.execute({ id: target.id }, ctxEmpty);
    assert(!r1.isError, 'case 11.5a boardCurrentTaskId="" 不触发守卫');
    // 恢复以便下一步测
    await store.restoreTask(target.id);
    // 双方都是空串也不触发（truthy 校验拦截）
    const ctxEmpty2 = makeCtx({ boardCurrentTaskId: '' });
    const r2 = await deleteTask.execute({ id: '' }, ctxEmpty2);
    // id="" 会让 store.softDeleteTask 报 BOARD_TASK_NOT_FOUND——这是 store 层正确行为；
    // 关键是守卫**没**拦截（拦截的话错误会是"破坏评论线"，不是 NOT_FOUND）
    assert(r2.isError === true, 'case 11.5b 双方空串：返 isError（store 层 NOT_FOUND）');
    assert(r2.text.includes('NOT_FOUND') === true || r2.text.includes('不存在') === true,
      'case 11.5b 错误来自 store 层（NOT_FOUND），不是守卫拦截');
  }

  // ─── case 12: restore_task 串通 ───
  {
    const r = await restoreTask.execute({ id: c.id }, ctx);
    assert(!r.isError, 'case 12 restore 不报错');
    const t = await store.getTask(c.id);
    assert(t?.deletedAt === undefined, 'case 12 任务回主视图');
  }

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
