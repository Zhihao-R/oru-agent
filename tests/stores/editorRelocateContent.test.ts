import { beforeEach, describe, expect, it, vi } from 'vitest';

// mock 后端 RPC：editorStore 的 flush→writeMd 会发 fs.* 请求，统一记录下来断言。
const requestMock = vi.fn(() => Promise.resolve({ type: 'ack' }));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useEditorStore } from '@/stores/editorStore';

const ed = () => useEditorStore.getState();
const OLD = 'docs/架构.md';

beforeEach(() => {
  requestMock.mockClear();
  useEditorStore.setState({
    files: {
      [OLD]: {
        ref: { kind: 'project', projectId: 'p1', path: OLD },
        content: '![](架构.assets/图.png)',
        lastSyncedContent: '![](架构.assets/图.png)',
        loading: false,
      },
    },
  });
});

/**
 * relocate 带回写后新内容（§十一 C-1 承重）：改名导致「内存含旧引用」与「磁盘已回写」分叉，
 * relocate 必须携带新内容重置该桶、并清掉 pending——否则 pending autosave 把旧引用写回、盖掉回写、图全断。
 */
describe('editorStore.relocate 携带回写后内容（C-1）', () => {
  it('relocate(old,new,newContent)：桶 key / content / lastSyncedContent 一次原子重置', () => {
    ed().relocate(OLD, 'docs/方案.md', '![](方案.assets/图.png)');
    const f = ed().files['docs/方案.md'];
    expect(ed().files[OLD]).toBeUndefined();
    expect(f.content).toBe('![](方案.assets/图.png)');
    expect(f.lastSyncedContent).toBe('![](方案.assets/图.png)');
  });

  it('回归：改名前有 pending 编辑，relocate 带新内容后 flush 不再把旧引用写回（C-1 目标问题本身）', async () => {
    // 1. 用户在改名前编辑过（pending 持旧引用的内存内容）
    ed().setContent(OLD, '![](架构.assets/图.png)\n用户刚加的一行');
    // 2. 主进程锁内回写 + 改名，relocate 带回回写后的新内容（引用已是 方案.assets）
    ed().relocate(OLD, 'docs/方案.md', '![](方案.assets/图.png)\n用户刚加的一行');
    requestMock.mockClear();
    // 3. 触发所有 pending 落盘
    await ed().flushAll();

    // 断言：没有任何 writeMd 把「旧引用 / 旧路径」写回磁盘——pending 已被 relocate 清掉
    const writes = requestMock.mock.calls
      .map((c) => c[0] as { type?: string; path?: string; content?: string })
      .filter((p) => p?.type === 'fs.writeMd');
    expect(writes.every((w) => !w.content?.includes('架构.assets'))).toBe(true);
    expect(writes.every((w) => w.path !== OLD)).toBe(true);
    // 内存仍是回写版
    expect(ed().files['docs/方案.md'].content).toContain('方案.assets');
  });

  it('不带 newContent（move 场景）：只迁桶 key，content 不动（向后兼容）', () => {
    ed().relocate(OLD, 'sub/架构.md');
    const f = ed().files['sub/架构.md'];
    expect(ed().files[OLD]).toBeUndefined();
    expect(f.content).toBe('![](架构.assets/图.png)'); // 未变
  });
});
