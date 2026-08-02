/**
 * taskboard store 状态机与不变量单测——此前全押 smoke。用 ORU_DIR 沙箱 + 动态 import 范式
 * （tests/helpers/oruDirSandbox）真实落盘验，钉住 report 标记的欠覆盖点：completedAt 跨态维护、
 * commentCount floor(0)、软删/恢复的 deletedAt·preDeleteStatus、已删任务拒改。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sandboxOruDir } from '../helpers/oruDirSandbox';

sandboxOruDir('taskboard-store');

type Store = typeof import('../../electron/main/taskboard/store');
let store: Store;
beforeAll(async () => {
  store = await import('../../electron/main/taskboard/store');
});

describe('createTask 默认值', () => {
  it('status=待办、commentCount=0、assignee 回落 by、completedAt 未设', async () => {
    const t = await store.createTask({ title: '调研' }, 'you');
    expect(t.id.startsWith('bt_')).toBe(true);
    expect(t.status).toBe('待办');
    expect(t.commentCount).toBe(0);
    expect(t.assignee).toBe('you');
    expect(t.completedAt).toBeUndefined();
  });
});

describe('completedAt 跨态维护', () => {
  it('跨入 已完成 → 打 completedAt；跨出 → 清空；同态改字段 → 不变', async () => {
    const t = await store.createTask({ title: 'x' }, 'you');

    const done = await store.updateTask(t.id, { status: '已完成' });
    expect(done.completedAt).toBeGreaterThan(0);

    // 同态（已完成→已完成）改别的字段：completedAt 不变
    const renamed = await store.updateTask(t.id, { title: 'x2' });
    expect(renamed.completedAt).toBe(done.completedAt);

    // 跨出 已完成 → 清空
    const reopened = await store.updateTask(t.id, { status: '进行中' });
    expect(reopened.completedAt).toBeUndefined();
  });
});

describe('commentCount 边界', () => {
  it('increment 累加；decrement 到 0 后不为负（floor）', async () => {
    const t = await store.createTask({ title: 'c' }, 'you');
    await store.incrementCommentCount(t.id);
    await store.incrementCommentCount(t.id);
    expect((await store.getTask(t.id))!.commentCount).toBe(2);

    await store.decrementCommentCount(t.id);
    await store.decrementCommentCount(t.id);
    await store.decrementCommentCount(t.id); // 多减一次：floor 0，不负
    expect((await store.getTask(t.id))!.commentCount).toBe(0);
  });
});

describe('软删 / 恢复不变量', () => {
  it('softDelete 记 deletedAt + preDeleteStatus；已删任务 updateTask 抛错；restore 清标记', async () => {
    const t = await store.createTask({ title: 'd', status: '进行中' }, 'you');

    const deleted = await store.softDeleteTask(t.id, 'you');
    expect(deleted.deletedAt).toBeGreaterThan(0);
    expect(deleted.preDeleteStatus).toBe('进行中');

    await expect(store.updateTask(t.id, { title: 'nope' })).rejects.toThrow();

    const restored = await store.restoreTask(t.id);
    expect(restored.deletedAt).toBeUndefined();
    // 恢复后可正常改
    const ok = await store.updateTask(t.id, { title: 'ok' });
    expect(ok.title).toBe('ok');
  });
});

describe('ensureCommentConversation 不刷 updatedAt（回归：点开任务详情跳列表顶部）', () => {
  it('首次创建评论会话写回 commentConversationId，但 updatedAt 保持原值', async () => {
    const t = await store.createTask({ title: '点开看一眼' }, 'you');
    await new Promise((r) => setTimeout(r, 5)); // 保证若被 bump 一定能测出毫秒差

    const { task } = await store.ensureCommentConversation(t.id);
    expect(task.commentConversationId).toBeTruthy();
    expect(task.updatedAt).toBe(t.updatedAt);

    // 落盘的也一致（不是只有返回值没 bump）
    const onDisk = await store.getTask(t.id);
    expect(onDisk!.updatedAt).toBe(t.updatedAt);
  });
});
