// @vitest-environment jsdom

/**
 * editorStore 合约测试 —— 实时自动落盘（草稿机制下线后）+ 多标签按 path 分桶。
 *
 * 把 store 当「动作 + 模拟磁盘 → state」的状态机验证。ws 被 mock 成模拟磁盘：
 * fs.readMd 读 disk、fs.writeMd 写 disk、fs.history.sample / fileHistory.* 按需应答。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useEditorStore, hasOpenConflict } from '@/stores/editorStore';
import { registerEditorView, __clearEditorViewsForTest } from '@/components/editor/editorViewRegistry';
import type { EditorView } from '@codemirror/view';

const S = () => useEditorStore.getState();
const PRJ = 'prj_1';
const PATH = 'a.md';
const file = (path: string) => S().files[path];

// 模拟磁盘：每个 path 一份
let disk: Record<string, string> = {};
function setDisk(path: string, v: string): void {
  disk[path] = v;
}
type WsPayload = {
  type: string;
  projectId?: string;
  path?: string;
  content?: string;
  mark?: string;
  snapshotId?: string;
};
function defaultWs(): void {
  requestMock.mockImplementation((p: WsPayload) => {
    switch (p.type) {
      case 'fs.readMd':
        return Promise.resolve({ type: 'fs.md.content', projectId: p.projectId, path: p.path, content: disk[p.path!] ?? '' });
      case 'fs.writeMd':
        disk[p.path!] = p.content ?? '';
        return Promise.resolve({ type: 'fs.md.saved', projectId: p.projectId, path: p.path });
      case 'fs.history.sample':
        return Promise.resolve({ type: 'ack' });
      case 'fileHistory.restore':
        disk[p.path!] = 'restored';
        return Promise.resolve({ type: 'fileHistory.restored', projectId: p.projectId, path: p.path, content: 'restored' });
      default:
        return Promise.reject(new Error('unexpected ' + p.type));
    }
  });
}
function writeCalls(): WsPayload[] {
  return requestMock.mock.calls.map((c) => c[0] as WsPayload).filter((p) => p.type === 'fs.writeMd');
}

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockReset();
  defaultWs();
  disk = {};
  useEditorStore.setState({ files: {} });
});

afterEach(() => {
  for (const p of Object.keys(S().files)) S().close(p);
  __clearEditorViewsForTest();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('打开 / 实时落盘', () => {
  it('open 读磁盘为 content、lastSynced 一致', async () => {
    setDisk(PATH, 'disk-v1');
    await S().open(PRJ, PATH);
    expect(file(PATH).content).toBe('disk-v1');
    expect(file(PATH).lastSyncedContent).toBe('disk-v1');
  });

  it('重开已加载的同一文件：不重读、保留现场', async () => {
    setDisk(PATH, 'base');
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'local-edit');
    await S().open(PRJ, PATH); // 再次 open（标签重开）
    expect(file(PATH).content).toBe('local-edit'); // 没被磁盘重读覆盖
    const reads = requestMock.mock.calls.map((c) => c[0] as WsPayload).filter((p) => p.type === 'fs.readMd');
    expect(reads).toHaveLength(1); // 只读过一次盘
  });

  it('setContent 后停手 ~0.8s 自动落盘', async () => {
    setDisk(PATH, 'base');
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'typed');
    expect(writeCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(800);
    const w = writeCalls();
    expect(w).toHaveLength(1);
    expect(w[0].content).toBe('typed');
    expect(w[0].mark).toBeUndefined();
    expect(disk[PATH]).toBe('typed');
  });

  it('flush 立即落盘 pending', async () => {
    setDisk(PATH, 'base');
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'mid');
    await S().flush(PATH);
    expect(disk[PATH]).toBe('mid');
    expect(file(PATH).lastSyncedContent).toBe('mid');
  });

  it('manualSnapshot（⌘S）落盘并打 manual 标', async () => {
    setDisk(PATH, 'base');
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'pinned');
    await S().manualSnapshot(PATH);
    const w = writeCalls();
    expect(w).toHaveLength(1);
    expect(w[0].mark).toBe('manual');
    expect(disk[PATH]).toBe('pinned');
  });

  it('⌘S 后立即关标签：manual 留底仍落盘（入队前已捕获快照，P7 回归）', async () => {
    setDisk(PATH, 'base');
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'to-pin');
    const snap = S().manualSnapshot(PATH); // 入队前已捕获 content='to-pin'
    S().close(PATH); // 紧接关标签：同步删桶
    await snap;
    await vi.advanceTimersByTimeAsync(0);
    const manualWrites = writeCalls().filter((w) => w.mark === 'manual' && w.content === 'to-pin');
    expect(manualWrites).toHaveLength(1); // manual 写没因桶被删而丢
  });
});

describe('多标签按 path 分桶（防串回归 §六）', () => {
  it('A、B 两 path 各 setContent 后 flush(A)：只落 A，B 的 pending 不受影响', async () => {
    setDisk('A.md', 'A0');
    setDisk('B.md', 'B0');
    await S().open(PRJ, 'A.md');
    await S().open(PRJ, 'B.md'); // 两个标签同时开着，B 不挤掉 A
    expect(file('A.md').content).toBe('A0');
    expect(file('B.md').content).toBe('B0');

    S().setContent('A.md', 'A-edited');
    S().setContent('B.md', 'B-edited');
    await S().flush('A.md'); // 只 flush A

    expect(disk['A.md']).toBe('A-edited'); // A 落盘
    expect(disk['B.md']).toBe('B0'); // B 还没落（pending 仍在，互不串）
    expect(file('A.md').lastSyncedContent).toBe('A-edited');
    expect(file('B.md').content).toBe('B-edited'); // B 内存改动还在

    await vi.advanceTimersByTimeAsync(800); // B 的 debounce 到点
    expect(disk['B.md']).toBe('B-edited'); // B 各自 debounce 落盘
  });

  it('关闭 A 不影响 B 的桶与 pending', async () => {
    setDisk('A.md', 'A0');
    setDisk('B.md', 'B0');
    await S().open(PRJ, 'A.md');
    await S().open(PRJ, 'B.md');
    S().setContent('B.md', 'B-edited');
    S().close('A.md');
    await vi.advanceTimersByTimeAsync(0);
    expect(file('A.md')).toBeUndefined(); // A 桶销毁
    expect(file('B.md').content).toBe('B-edited'); // B 不受影响
    await vi.advanceTimersByTimeAsync(800);
    expect(disk['B.md']).toBe('B-edited');
  });
});

describe('切回刷新（syncFromDisk）', () => {
  it('本地无改动 + 磁盘被 AI/外部改 → 刷新成磁盘版', async () => {
    setDisk(PATH, 'v1');
    await S().open(PRJ, PATH);
    setDisk(PATH, 'v2-ai');
    await S().syncFromDisk(PATH);
    expect(file(PATH).content).toBe('v2-ai');
    expect(file(PATH).lastSyncedContent).toBe('v2-ai');
  });

  it('本地有未落盘改动 → 本地优先：flush 我的，不被磁盘覆盖', async () => {
    setDisk(PATH, 'base');
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'my-edit');
    setDisk(PATH, 'external');
    await S().syncFromDisk(PATH);
    expect(file(PATH).content).toBe('my-edit');
    expect(disk[PATH]).toBe('my-edit');
  });

  it('自己刚落盘后切回不重复写、不回退', async () => {
    setDisk(PATH, 'base');
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'mine');
    await S().flush(PATH);
    await S().syncFromDisk(PATH);
    expect(file(PATH).content).toBe('mine');
    expect(writeCalls()).toHaveLength(1);
  });
});

describe('找回旧版（restoreFromHistory）', () => {
  it('恢复某快照 → content 更新为恢复后的内容', async () => {
    setDisk(PATH, 'current');
    await S().open(PRJ, PATH);
    await S().restoreFromHistory(PATH, 's001');
    expect(file(PATH).content).toBe('restored');
    expect(file(PATH).lastSyncedContent).toBe('restored');
  });

  it('恢复前先 flush 未落盘编辑（不丢用户刚敲、未落盘的内容）', async () => {
    setDisk(PATH, 'base');
    await S().open(PRJ, PATH);
    S().setContent(PATH, '刚敲还没落盘');
    await S().restoreFromHistory(PATH, 's001');
    expect(writeCalls().some((w) => w.content === '刚敲还没落盘')).toBe(true);
    expect(file(PATH).content).toBe('restored');
  });
});

describe('改名跟随（relocate）', () => {
  it('单文件改名：桶 key 迁移，pending 不落回旧路径', async () => {
    setDisk('old.md', 'X');
    await S().open(PRJ, 'old.md');
    S().setContent('old.md', 'edited'); // pending 在 old.md
    S().relocate('old.md', 'new.md', 'rewritten'); // 改名联动回写
    expect(file('old.md')).toBeUndefined();
    expect(file('new.md').content).toBe('rewritten'); // newContent 原子替换
    await vi.advanceTimersByTimeAsync(800);
    // 旧 pending 已作废（newContent 分支清掉），不应有落到 old.md 的写
    expect(writeCalls().some((w) => w.path === 'old.md')).toBe(false);
  });

  it('目录移动：子树下的桶 key 前缀迁移', async () => {
    setDisk('docs/a.md', 'A');
    await S().open(PRJ, 'docs/a.md');
    S().relocate('docs', 'archive');
    expect(file('docs/a.md')).toBeUndefined();
    expect(file('archive/a.md').content).toBe('A');
  });

  it('移动（无 newContent）有未落盘编辑：autosave 重排到新 path 落盘，不丢、不落旧 path（回归 M-1）', async () => {
    setDisk('a/x.md', 'base');
    await S().open(PRJ, 'a/x.md');
    S().setContent('a/x.md', 'edited'); // pending + timer 在 a/x.md
    S().relocate('a', 'b'); // 移动目录 a→b（无 newContent，timer 闭包原指向旧 path）
    expect(file('b/x.md').content).toBe('edited');
    await vi.advanceTimersByTimeAsync(800); // 重排后的 timer 到点
    expect(disk['b/x.md']).toBe('edited'); // 落到新 path（旧实现会 no-op 丢掉）
    expect(writeCalls().some((w) => w.path === 'a/x.md')).toBe(false); // 没有写回旧 path
  });
});

describe('自写回声 / 落盘竞态（冲突卡误弹回归）', () => {
  // 让 fs.writeMd 首次调用挂起：模拟「落盘 await 期间用户继续打字 / 关掉重开同 path」的并发窗口。
  // 关键：默认 mock 同步 resolve，无法在写盘 await 中插入操作；这里把首次写卡住，露出那个窗口。
  function gateFirstWrite(): { release: () => void; written: Promise<void> } {
    let release!: () => void;
    let onWrite!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const written = new Promise<void>((r) => (onWrite = r));
    let gated = true;
    requestMock.mockImplementation(async (p: WsPayload) => {
      switch (p.type) {
        case 'fs.readMd':
          return { type: 'fs.md.content', projectId: p.projectId, path: p.path, content: disk[p.path!] ?? '' };
        case 'fs.writeMd':
          if (gated) {
            gated = false;
            onWrite();
            await released;
          }
          disk[p.path!] = p.content ?? '';
          return { type: 'fs.md.saved', projectId: p.projectId, path: p.path };
        case 'fs.history.sample':
          return { type: 'ack' };
        default:
          throw new Error('unexpected ' + p.type);
      }
    });
    return { release, written };
  }

  it('落盘 await 期间继续打字：base 推进到已写版本（核心回归——否则自写回声被当外部改动弹卡）', async () => {
    setDisk(PATH, '把控也');
    await S().open(PRJ, PATH);
    const gate = gateFirstWrite();
    S().setContent(PATH, '把控也you'); // 自动保存采样到未上屏的拼音
    const flushP = S().flush(PATH); // 落盘 '把控也you'，卡在写盘 await
    await gate.written; // 确认已进入 writeDisk await（pending 已被消费）
    S().setContent(PATH, '把控也由'); // await 期间用户选定汉字 → 换出新桶对象
    gate.release();
    await flushP;
    // 旧实现：桶对象同一性守卫因「换了新桶」拒绝推进 → base 停在 '把控也'，
    // 随后自写回声 disk='把控也you' 被 diff3 当外部改动 → 误弹冲突卡。
    expect(file(PATH).lastSyncedContent).toBe('把控也you');
    expect(file(PATH).content).toBe('把控也由'); // 本地最新没被破坏
  });

  it('承接：自写回声到达时不弹冲突卡，本地最新不被覆盖、自愈收敛', async () => {
    setDisk(PATH, '把控也');
    await S().open(PRJ, PATH);
    const gate = gateFirstWrite();
    S().setContent(PATH, '把控也you');
    const flushP = S().flush(PATH);
    await gate.written;
    S().setContent(PATH, '把控也由');
    gate.release();
    await flushP;
    // 模拟 writeMd 回声广播 → syncFromDisk（disk='把控也you'、base 已被推进到同值）
    await S().syncFromDisk(PATH);
    expect(hasOpenConflict(PATH)).toBe(false);
    expect(file(PATH).content).toBe('把控也由');
    await vi.advanceTimersByTimeAsync(800); // 排空 '把控也由' 的 autosave
    expect(disk[PATH]).toBe('把控也由'); // 三者收敛到本地最新
    expect(file(PATH).lastSyncedContent).toBe('把控也由');
  });

  it('落盘 await 期间关掉重开同 path：过期写不污染重开会话的 base（reopen 竞态，开桶代际守卫）', async () => {
    setDisk(PATH, 'v0');
    await S().open(PRJ, PATH);
    const gate = gateFirstWrite();
    S().setContent(PATH, 'stale-edit');
    const flushP = S().flush(PATH); // 落盘 'stale-edit'，卡住
    await gate.written;
    S().close(PATH); // 关桶（pending 已被消费，close 的 flush 是 no-op）
    await S().open(PRJ, PATH); // 重开：读盘得 'v0'（过期写未落），新代际，base='v0'
    gate.release();
    await flushP; // 过期写落盘并完成——代际已变，不应推进重开会话的 base
    expect(file(PATH).lastSyncedContent).toBe('v0');
  });

  // 仅 mock editorStore 用到的 view.composing；satisfies 锁住该字段类型（CM 改 composing 语义即编译失败，
  // 不假绿）。注册表需要完整 EditorView，故仅在边界处一次性窄化转换。
  function registerComposingView(path: string): {
    setComposing: (composing: boolean) => void;
    unregister: () => void;
  } {
    const st = { composing: true };
    const view = {
      get composing() {
        return st.composing;
      },
    } satisfies Pick<EditorView, 'composing'>;
    const unregister = registerEditorView(path, view as unknown as EditorView);
    return { setComposing: (c) => (st.composing = c), unregister };
  }

  it('IME 组合中：autosave 只记 pending 不落盘，compositionend 后再排盘（不落半成品拼音）', async () => {
    setDisk(PATH, '把控也');
    await S().open(PRJ, PATH);
    const { setComposing } = registerComposingView(PATH);
    S().setContent(PATH, '把控也you'); // 组合中采样
    await vi.advanceTimersByTimeAsync(800);
    expect(writeCalls()).toHaveLength(0); // 组合中不落盘
    expect(disk[PATH]).toBe('把控也');
    setComposing(false);
    S().noteCompositionEnd(PATH); // 组合结束 → 排盘
    await vi.advanceTimersByTimeAsync(800);
    const w = writeCalls();
    expect(w).toHaveLength(1);
    expect(w[0].content).toBe('把控也you');
    expect(disk[PATH]).toBe('把控也you');
  });

  it('IME 组合中收到外部写：syncFromDisk 推迟，compositionend 后补跑（不打断候选词）', async () => {
    setDisk(PATH, '初始');
    await S().open(PRJ, PATH);
    const { setComposing, unregister } = registerComposingView(PATH);
    setDisk(PATH, 'AI-改动'); // 模拟 Oru 落盘
    await S().syncFromDisk(PATH); // 组合中触发 → 应被推迟、不落入
    expect(file(PATH).content).toBe('初始'); // 候选词未被打断
    setComposing(false);
    unregister(); // 补跑走「无 view 退化」路径（半成品假 view 无 state/dispatch）：applyExternalContent 仍推 content
    S().noteCompositionEnd(PATH); // 组合结束 → 补跑被推迟的同步
    await vi.advanceTimersByTimeAsync(0);
    expect(file(PATH).content).toBe('AI-改动'); // 外部改动现在可见
  });
});

describe('关闭', () => {
  it('close 前 flush pending、销桶', async () => {
    setDisk(PATH, 'base');
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'unsaved-on-close');
    S().close(PATH);
    await vi.advanceTimersByTimeAsync(0);
    expect(disk[PATH]).toBe('unsaved-on-close');
    expect(file(PATH)).toBeUndefined();
  });

  it('closeIfUnder：删目录关掉其下所有桶', async () => {
    setDisk('docs/a.md', 'A');
    setDisk('docs/b.md', 'B');
    setDisk('other.md', 'O');
    await S().open(PRJ, 'docs/a.md');
    await S().open(PRJ, 'docs/b.md');
    await S().open(PRJ, 'other.md');
    S().closeIfUnder('docs');
    await vi.advanceTimersByTimeAsync(0);
    expect(file('docs/a.md')).toBeUndefined();
    expect(file('docs/b.md')).toBeUndefined();
    expect(file('other.md').content).toBe('O'); // 不波及
  });
});
