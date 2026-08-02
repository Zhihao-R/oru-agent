// @vitest-environment jsdom

/**
 * 编辑器半受控迁移（头号风险，tech §3.2）——外部内容（AI 落盘 / 恢复历史）经 view.dispatch
 * 最小变更集落入，而非受控 value 整篇替换：原地更新、光标/滚动随 changeset 自动映射不被打断。
 * 桶 content 与 base（lastSyncedContent）随之原子推进；无注册 view（非活跃标签）退化为仅更新桶。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
let subscriber: ((ev: unknown) => void) | null = null;
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: (cb: (ev: unknown) => void) => {
      subscriber = cb;
      return () => {
        subscriber = null;
      };
    },
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { diff3 } from '@shared/diff3';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  useEditorStore,
  bindEditorAutoSync,
  __resetEditorAutoSyncForTest,
  __resetConflictStateForTest,
  hasOpenConflict,
} from '@/stores/editorStore';
import { registerEditorView, __clearEditorViewsForTest } from '@/components/editor/editorViewRegistry';
import { conflictCards } from '@/components/editor/conflictCard';
import { recentChangeHighlight } from '@/components/editor/recentChangeHighlight';

const S = () => useEditorStore.getState();
const PRJ = 'prj';
const PATH = 'a.md';
let disk: Record<string, string> = {};

/**
 * 忠实模拟主进程 commitWorkfileWrite（S27 锁内机械合并）：mergeOnStale+baseline 时磁盘现状 !== baseline →
 * diff3 合并（不同段 result:'merged' 携合并产物、同段 result:'discarded' 磁盘一字未动）。测试端把「合并落
 * 在锁内」这条契约建模进 mock，别再把主进程当哑磁盘（否则测不到真实换入/开卡行为）。
 */
function simulateWriteMd(p: {
  projectId?: string;
  path?: string;
  content?: string;
  baseline?: { content: string };
  mergeOnStale?: boolean;
}): { type: 'fs.md.saved'; projectId?: string; path?: string; result: 'written' | 'merged' | 'discarded'; content?: string } {
  const path = p.path!;
  const cur = disk[path] ?? '';
  const mine = p.content ?? '';
  if (p.mergeOnStale && p.baseline && cur !== p.baseline.content) {
    const { merged, conflicts } = diff3(p.baseline.content, mine, cur);
    if (conflicts.length > 0) {
      return { type: 'fs.md.saved', projectId: p.projectId, path, result: 'discarded' };
    }
    disk[path] = merged;
    return { type: 'fs.md.saved', projectId: p.projectId, path, result: 'merged', content: merged };
  }
  disk[path] = mine;
  return { type: 'fs.md.saved', projectId: p.projectId, path, result: 'written' };
}

function defaultWs(): void {
  requestMock.mockImplementation((p: { type: string; projectId?: string; path?: string; content?: string; baseline?: { content: string }; mergeOnStale?: boolean }) => {
    switch (p.type) {
      case 'fs.readMd':
        return Promise.resolve({ type: 'fs.md.content', projectId: p.projectId, path: p.path, content: disk[p.path!] ?? '' });
      case 'fs.writeMd':
        return Promise.resolve(simulateWriteMd(p));
      case 'fs.history.sample':
        return Promise.resolve({ type: 'ack' });
      case 'fileHistory.recordDiscarded': // S29·G90⑤ 弃写降级入历史
        return Promise.resolve({ type: 'ack' });
      case 'conflictCard.opened': // S29·G90① 开卡双方版本入历史
        return Promise.resolve({ type: 'conflictCard.opened.result', mineId: 's1', theirsId: 's2' });
      case 'conflictCard.resolved': // S29·G90②③ 收起补标 + 交回
        return Promise.resolve({ type: 'ack' });
      default:
        return Promise.reject(new Error('unexpected ' + p.type));
    }
  });
}

function makeView(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc, extensions: [recentChangeHighlight()] }), parent });
}

function makeConflictView(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc, extensions: [conflictCards()] }), parent });
}

function clickAction(view: EditorView, label: string): void {
  const btn = Array.from(view.dom.querySelectorAll<HTMLButtonElement>('.oru-conflict-btn')).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`找不到动作按钮：${label}`);
  btn.click();
}

beforeEach(() => {
  requestMock.mockReset();
  defaultWs();
  disk = {};
  useEditorStore.setState({ files: {} });
});

afterEach(() => {
  for (const p of Object.keys(S().files)) S().close(p);
  document.body.innerHTML = '';
  __resetEditorAutoSyncForTest(); // 解订阅 + 清模块级 guard，杜绝跨用例订阅泄漏
  __resetConflictStateForTest(); // 清协同冲突态
  __clearEditorViewsForTest(); // 清 view 注册表
});

describe('外部内容经半受控 view dispatch 落入', () => {
  it('外部在尾部追加：view 原地更新到磁盘版，前面的光标停在原处', async () => {
    disk[PATH] = 'AAA\nBBB';
    await S().open(PRJ, PATH);
    const view = makeView('AAA\nBBB');
    registerEditorView(PATH, view);
    view.dispatch({ selection: { anchor: 1 } }); // 光标在第一行 AAA 内

    disk[PATH] = 'AAA\nBBB\nCCC'; // 外部（AI）在尾部追加
    await S().syncFromDisk(PATH);

    expect(view.state.doc.toString()).toBe('AAA\nBBB\nCCC'); // view 已更新到最新
    expect(view.state.selection.main.anchor).toBe(1); // 尾部改动不挪前面的光标（changeset 映射）
    expect(S().files[PATH].content).toBe('AAA\nBBB\nCCC'); // 桶 content 同步
    expect(S().files[PATH].lastSyncedContent).toBe('AAA\nBBB\nCCC'); // base 推进
    expect(view.dom.querySelectorAll('.oru-recent-change').length).toBeGreaterThan(0); // Oru 刚改过的段落淡高亮（场景一）
  });

  it('外部在前部插入：光标随 changeset 后移，保持指向原来的字符', async () => {
    disk[PATH] = 'world';
    await S().open(PRJ, PATH);
    const view = makeView('world');
    registerEditorView(PATH, view);
    view.dispatch({ selection: { anchor: 5 } }); // 光标在 'world' 末尾

    disk[PATH] = 'hello world'; // 外部在前面插入 'hello '
    await S().syncFromDisk(PATH);

    expect(view.state.doc.toString()).toBe('hello world');
    expect(view.state.selection.main.anchor).toBe(11); // 原末尾随插入后移 6（仍指向 world 末尾）
  });

  it('无注册 view（非活跃标签未挂载）：退化为仅更新桶，不报错', async () => {
    disk[PATH] = 'v1';
    await S().open(PRJ, PATH);
    disk[PATH] = 'v2';
    await S().syncFromDisk(PATH);
    expect(S().files[PATH].content).toBe('v2');
    expect(S().files[PATH].lastSyncedContent).toBe('v2');
  });

  it('场景二·不同段各改 → 三方合并：你的编辑与 AI 的改动都保留、写盘、base 推进', async () => {
    disk[PATH] = 'a\nb\nc\n';
    await S().open(PRJ, PATH);
    const view = makeView('a\nb\nc\n');
    registerEditorView(PATH, view);
    S().setContent(PATH, 'MINE\nb\nc\n'); // 你改第一行（未落盘）
    disk[PATH] = 'a\nb\nTHEIRS\n'; // AI 改第三行落盘
    await S().syncFromDisk(PATH);
    expect(S().files[PATH].content).toBe('MINE\nb\nTHEIRS\n'); // 两边都保留
    expect(view.state.doc.toString()).toBe('MINE\nb\nTHEIRS\n'); // view 原地呈现合并结果
    expect(disk[PATH]).toBe('MINE\nb\nTHEIRS\n'); // merged 写盘
    expect(S().files[PATH].lastSyncedContent).toBe('MINE\nb\nTHEIRS\n'); // base 推进到合并结果
  });

  it('同段冲突·无挂载 view（非活跃标签）→ S29⑤ 弃写降级：AI 版留磁盘、你的版本进历史可找回', async () => {
    disk[PATH] = 'a\nb\nc\n';
    await S().open(PRJ, PATH); // 不注册 view
    S().setContent(PATH, 'a\nMINE\nc\n'); // 你改第二行
    disk[PATH] = 'a\nTHEIRS\nc\n'; // AI 也改第二行 → 冲突
    await S().syncFromDisk(PATH);
    // S29 改本地优先为弃写降级：没有消费者开不了卡，但字不能没——AI 版留磁盘，你的在途版降级入历史
    expect(disk[PATH]).toBe('a\nTHEIRS\nc\n'); // AI 版不被 last-writer-wins 盖掉
    expect(S().files[PATH].content).toBe('a\nTHEIRS\nc\n'); // base 推进到磁盘 AI 版，下次不再撞同段
    expect(hasOpenConflict(PATH)).toBe(false); // 无 view 不起卡
    // 你的在途版走 recordDiscarded 进历史（可找回）
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fileHistory.recordDiscarded', content: 'a\nMINE\nc\n' }),
    );
  });

  it('同段冲突·有挂载 view → 进入对照卡：base 冻结、卡出现、view 留 mine 版（验收5）', async () => {
    disk[PATH] = 'a\nb\nc\n';
    await S().open(PRJ, PATH);
    const view = makeConflictView('a\nb\nc\n');
    registerEditorView(PATH, view);
    S().setContent(PATH, 'a\nMINE\nc\n');
    disk[PATH] = 'a\nTHEIRS\nc\n';
    await S().syncFromDisk(PATH);

    expect(hasOpenConflict(PATH)).toBe(true);
    expect(view.dom.querySelectorAll('.oru-conflict-card')).toHaveLength(1); // 原地展开对照卡
    expect(view.state.doc.toString()).toBe('a\nMINE\nc\n'); // 冲突段留你的版本
    expect(S().files[PATH].lastSyncedContent).toBe('a\nb\nc\n'); // base 冻结、未推进
  });

  it('开卡簿记 WS 往返期间关标签 → 不泄漏主进程登记、不留孤儿冲突态（C-1 回归）', async () => {
    disk[PATH] = 'a\nb\nc\n';
    await S().open(PRJ, PATH);
    const view = makeConflictView('a\nb\nc\n');
    registerEditorView(PATH, view);
    S().setContent(PATH, 'a\nMINE\nc\n');
    disk[PATH] = 'a\nTHEIRS\nc\n'; // AI 也改第二行 → 同段冲突

    // 让 conflictCard.opened 挂起（受控 deferred），模拟主进程磁盘 IO 往返窗口
    let releaseOpened!: () => void;
    const resolvedCalls: Array<{ outcome?: string }> = [];
    requestMock.mockImplementation((p: { type: string; projectId?: string; path?: string; outcome?: string; baseline?: { content: string }; mergeOnStale?: boolean; content?: string }) => {
      switch (p.type) {
        case 'fs.readMd':
          return Promise.resolve({ type: 'fs.md.content', projectId: p.projectId, path: p.path, content: disk[p.path!] ?? '' });
        case 'fs.writeMd':
          return Promise.resolve(simulateWriteMd(p));
        case 'conflictCard.opened':
          return new Promise((res) => {
            releaseOpened = () => res({ type: 'conflictCard.opened.result', mineId: 's1', theirsId: 's2' });
          });
        case 'conflictCard.resolved':
          resolvedCalls.push(p);
          return Promise.resolve({ type: 'ack' });
        default:
          return Promise.resolve({ type: 'ack' });
      }
    });

    const syncP = S().syncFromDisk(PATH); // 触发开卡，卡在 conflictCard.opened await（此刻 conflictState 尚无本 path）
    await new Promise((r) => setTimeout(r, 0)); // 刷到 await 点
    S().close(PATH); // 关标签：conflictState 无入口 → 跳过撤登记（正是泄漏窗口）
    releaseOpened(); // WS 回来，openConflictCard 恢复
    await syncP;
    await new Promise((r) => setTimeout(r, 0));

    expect(hasOpenConflict(PATH)).toBe(false); // 无孤儿 conflictState（否则重开即永久冻结）
    // await 后重检发现桶已销 → 补发 cancelled 撤主进程登记（否则该文件 AI 写入永久 defer）
    expect(resolvedCalls.some((c) => c.outcome === 'cancelled')).toBe(true);
  });

  it('对照卡点「用 Oru 的」→ 落定 theirs、卡消失、base 推进、落盘（验收5）', async () => {
    disk[PATH] = 'a\nb\nc\n';
    await S().open(PRJ, PATH);
    const view = makeConflictView('a\nb\nc\n');
    registerEditorView(PATH, view);
    S().setContent(PATH, 'a\nMINE\nc\n');
    disk[PATH] = 'a\nTHEIRS\nc\n';
    await S().syncFromDisk(PATH);

    clickAction(view, '用 Oru 的');
    await new Promise((r) => setTimeout(r, 0)); // 刷净解决收尾的 enqueue 链

    expect(view.state.doc.toString()).toBe('a\nTHEIRS\nc\n'); // 落定为 Oru 版
    expect(hasOpenConflict(PATH)).toBe(false); // 卡消失、解冻
    expect(S().files[PATH].lastSyncedContent).toBe('a\nTHEIRS\nc\n'); // base 推进到落定结果
    expect(disk[PATH]).toBe('a\nTHEIRS\nc\n'); // 落盘
  });

  it('对照卡点「两个都留」→ mine 顺次接 theirs，落定+推进 base', async () => {
    disk[PATH] = 'a\nb\nc\n';
    await S().open(PRJ, PATH);
    const view = makeConflictView('a\nb\nc\n');
    registerEditorView(PATH, view);
    S().setContent(PATH, 'a\nMINE\nc\n');
    disk[PATH] = 'a\nTHEIRS\nc\n';
    await S().syncFromDisk(PATH);

    clickAction(view, '两个都留');
    await new Promise((r) => setTimeout(r, 0));

    expect(view.state.doc.toString()).toBe('a\nMINE\nTHEIRS\nc\n'); // 两段顺次保留
    expect(S().files[PATH].lastSyncedContent).toBe('a\nMINE\nTHEIRS\nc\n');
  });

  it('冲突卡展开期间 Oru 改了不相邻段 → 排队、不替换卡；解决后基于旧 base 自动并入（验收6/§4.3）', async () => {
    disk[PATH] = 'a\nb\nc\nd\ne\n';
    await S().open(PRJ, PATH);
    const view = makeConflictView('a\nb\nc\nd\ne\n');
    registerEditorView(PATH, view);
    S().setContent(PATH, 'a\nMINE\nc\nd\ne\n'); // 你改第二行
    disk[PATH] = 'a\nTHEIRS\nc\nd\ne\n'; // Oru 也改第二行 → 冲突
    await S().syncFromDisk(PATH); // 进入冲突卡

    // 展开期间 Oru 又改了不相邻的第四行（d→D，与冲突段隔着第三行）
    disk[PATH] = 'a\nTHEIRS\nc\nD\ne\n';
    await S().syncFromDisk(PATH); // 排队，不替换卡
    expect(view.dom.querySelectorAll('.oru-conflict-card')).toHaveLength(1); // 卡未被替换

    clickAction(view, '用 Oru 的'); // 落定冲突段为 THEIRS
    await new Promise((r) => setTimeout(r, 0)); // 解决收尾 + pendingTheirs 重合

    // 落定后基于旧 base 与最新磁盘重合 → 第二行两边同为 THEIRS（一致取之）、第四行 D 自动并入
    expect(S().files[PATH].content).toBe('a\nTHEIRS\nc\nD\ne\n');
    expect(hasOpenConflict(PATH)).toBe(false);
  });

  it('解决期间 Oru 又改你刚解决的同一段 → 重新起卡让你再决定（不静默盖掉你的选择，§4.3/绝不改错）', async () => {
    disk[PATH] = 'a\nb\nc\n';
    await S().open(PRJ, PATH);
    const view = makeConflictView('a\nb\nc\n');
    registerEditorView(PATH, view);
    S().setContent(PATH, 'a\nMINE\nc\n');
    disk[PATH] = 'a\nTHEIRS1\nc\n'; // Oru 改第二行 → 冲突
    await S().syncFromDisk(PATH); // 进卡

    disk[PATH] = 'a\nTHEIRS2\nc\n'; // 展开期间 Oru 又把同一段改成别的
    await S().syncFromDisk(PATH); // 排队、不替换卡

    clickAction(view, '用我的'); // 你选保留 MINE
    await new Promise((r) => setTimeout(r, 0)); // 解决收尾 + pendingTheirs 基于旧 base 重合

    // 你选 MINE，但 Oru 又把同段改成 THEIRS2 → diff3 重判冲突、重新起卡，绝不静默变成 THEIRS2
    expect(hasOpenConflict(PATH)).toBe(true);
    expect(view.dom.querySelectorAll('.oru-conflict-card')).toHaveLength(1);
    expect(view.state.doc.toString()).toBe('a\nMINE\nc\n'); // 冲突段仍保留你的版本
  });

  it('读盘 await 期间用户开始打字 → 同段冲突无 view → S29⑤ 弃写降级（await 后用 fresh cur 算合并，输入不丢字）', async () => {
    // 不注册 view：同段冲突无处展卡 → 走弃写降级（验证 await 后用 fresh cur='my-typing' 算合并、撞同段、降级入历史）
    disk[PATH] = 'base';
    await S().open(PRJ, PATH);
    disk[PATH] = 'ai-version';
    // 让 fs.readMd 在「读盘 await 窗口」里模拟用户打字（同步 setContent 入 pending），再返回磁盘版
    let typedDuringRead = false;
    requestMock.mockImplementation((p: { type: string; projectId?: string; path?: string; content?: string; baseline?: { content: string }; mergeOnStale?: boolean }) => {
      if (p.type === 'fs.readMd') {
        if (!typedDuringRead) {
          typedDuringRead = true;
          S().setContent(PATH, 'my-typing'); // await 窗口内的本地输入
        }
        return Promise.resolve({ type: 'fs.md.content', projectId: p.projectId, path: p.path, content: disk[p.path!] ?? '' });
      }
      if (p.type === 'fs.writeMd') {
        return Promise.resolve(simulateWriteMd(p));
      }
      return Promise.resolve({ type: 'ack' });
    });

    await S().syncFromDisk(PATH);

    // await 后重检拿到 fresh cur='my-typing'，与磁盘 'ai-version' 撞同段 → 弃写降级（不静默丢字）：
    // 用户输入走 recordDiscarded 入历史可找回，磁盘保留 AI 版、base 推进到它。
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fileHistory.recordDiscarded', content: 'my-typing' }),
    );
    expect(disk[PATH]).toBe('ai-version'); // AI 版不被盖
    expect(S().files[PATH].content).toBe('ai-version'); // base 推进到磁盘 AI 版
  });
});

describe('bindEditorAutoSync：fs.changed(filePath) → 命中桶即时同步', () => {
  it('AI 落盘广播命中打开文档 → view 原地更新到磁盘最新', async () => {
    bindEditorAutoSync();
    disk[PATH] = 'base';
    await S().open(PRJ, PATH);
    const view = makeView('base');
    registerEditorView(PATH, view);

    disk[PATH] = 'base+ai'; // AI 落盘
    subscriber?.({ type: 'fs.changed', projectId: PRJ, path: '', filePath: PATH });
    await new Promise((r) => setTimeout(r, 0)); // 刷净 enqueue 链 + 读盘 await

    expect(view.state.doc.toString()).toBe('base+ai');
    expect(S().files[PATH].content).toBe('base+ai');
  });

  it('filePath 不命中任何打开桶 → 不同步、不报错', async () => {
    bindEditorAutoSync();
    disk[PATH] = 'base';
    await S().open(PRJ, PATH);
    disk[PATH] = 'changed';
    subscriber?.({ type: 'fs.changed', projectId: PRJ, path: '', filePath: 'other.md' });
    await Promise.resolve();
    expect(S().files[PATH].content).toBe('base'); // 未被无关文件的广播触动
  });

  it('树操作广播（无 filePath）→ 编辑器不反应', async () => {
    bindEditorAutoSync();
    disk[PATH] = 'base';
    await S().open(PRJ, PATH);
    disk[PATH] = 'changed';
    subscriber?.({ type: 'fs.changed', projectId: PRJ, path: 'somedir' });
    await Promise.resolve();
    expect(S().files[PATH].content).toBe('base');
  });
});
