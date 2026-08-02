import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── mock 后端 RPC：这三个 store 的 open/close/relocate 会发 fs.* 请求，统一吞掉 ──
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
import { useTableStore, type TableFileState } from '@/stores/tableStore';
import { useHtmlAnnotStore, type HtmlAnnotFileState } from '@/stores/htmlAnnotStore';

beforeEach(() => {
  requestMock.mockClear();
});

// ── editorStore（多标签按 path 分桶）──────────────────────────────────────────
describe('editorStore.relocate / closeIfUnder', () => {
  const ed = () => useEditorStore.getState();
  beforeEach(() => {
    useEditorStore.setState({
      files: {
        'docs/a.md': {
          ref: { kind: 'project', projectId: 'p1', path: 'docs/a.md' },
          content: 'x',
          lastSyncedContent: 'x',
          loading: false,
        },
      },
    });
  });

  it('relocate 命中：path 等于 oldRel → 桶迁到 newRel', () => {
    ed().relocate('docs/a.md', 'docs/b.md');
    expect(ed().files['docs/b.md']).toBeDefined();
    expect(ed().files['docs/a.md']).toBeUndefined();
  });

  it('relocate 子树命中：移动父文件夹 → 前缀替换', () => {
    ed().relocate('docs', 'archive/docs');
    expect(ed().files['archive/docs/a.md']).toBeDefined();
  });

  it('relocate 不命中：什么都不做', () => {
    ed().relocate('other/x.md', 'other/y.md');
    expect(ed().files['docs/a.md']).toBeDefined();
  });

  it('closeIfUnder 命中 → 桶销毁', () => {
    ed().closeIfUnder('docs/a.md');
    expect(ed().files['docs/a.md']).toBeUndefined();
  });

  it('closeIfUnder 子树命中 → 销毁', () => {
    ed().closeIfUnder('docs');
    expect(ed().files['docs/a.md']).toBeUndefined();
  });

  it('closeIfUnder 不命中 → 不关', () => {
    ed().closeIfUnder('other');
    expect(ed().files['docs/a.md']).toBeDefined();
  });
});

// ── tableStore ───────────────────────────────────────────────────────────────
describe('tableStore.relocate / closeIfUnder', () => {
  const tb = () => useTableStore.getState();
  const bucket = (projectId: string): TableFileState => ({
    projectId,
    headers: [],
    rows: [],
    loading: false,
    saving: false,
    overLimit: false,
    previewRows: null,
    totalRows: null,
    provenance: [],
    canonical: true,
    encodingSafe: true,
    encoding: 'utf-8',
    savedText: '',
    baseDiskSha: null,
    mtimeMs: 0,
    dirty: false,
    undoStack: [],
    redoStack: [],
    sort: null,
    filters: new Map(),
    selection: null,
    pendingCanonicalConfirm: false,
  });
  beforeEach(() => {
    useTableStore.setState({ tables: { 'data/t.csv': bucket('p1') } });
  });

  it('relocate 命中：桶迁到 newRel，并重订哨兵（退旧订新）', () => {
    tb().relocate('data/t.csv', 'data/u.csv');
    expect(tb().tables['data/u.csv']).toBeDefined();
    expect(tb().tables['data/t.csv']).toBeUndefined();
    // 哨兵盯父目录：旧 path 退订 off + 新 path 订阅 on
    const watchCalls = requestMock.mock.calls
      .map((c) => c[0] as { type: string; on?: boolean; owner?: string })
      .filter((p) => p.type === 'fs.watch');
    expect(watchCalls).toContainEqual(
      expect.objectContaining({ type: 'fs.watch', on: false, owner: 'table:data/t.csv' }),
    );
    expect(watchCalls).toContainEqual(
      expect.objectContaining({ type: 'fs.watch', on: true, owner: 'table:data/u.csv' }),
    );
  });

  it('relocate 子树命中：移动父文件夹 → 前缀替换', () => {
    tb().relocate('data', 'archive/data');
    expect(tb().tables['archive/data/t.csv']).toBeDefined();
  });

  it('relocate 不命中：桶不变，不发 watch', () => {
    requestMock.mockClear();
    tb().relocate('other/x.csv', 'other/y.csv');
    expect(tb().tables['data/t.csv']).toBeDefined();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('closeIfUnder 命中 → 桶销毁', () => {
    tb().closeIfUnder('data/t.csv');
    expect(tb().tables['data/t.csv']).toBeUndefined();
  });

  it('closeIfUnder 子树命中 → 销毁', () => {
    tb().closeIfUnder('data');
    expect(tb().tables['data/t.csv']).toBeUndefined();
  });

  it('closeIfUnder 不命中 → 不关', () => {
    tb().closeIfUnder('other');
    expect(tb().tables['data/t.csv']).toBeDefined();
  });
});

// ── htmlAnnotStore（多标签按 ref 分桶；absPath 末尾恰是 ref，随之同步迁移）──────────
describe('htmlAnnotStore.relocate / closeIfUnder（桶 key + absPath 同步）', () => {
  const ha = () => useHtmlAnnotStore.getState();
  const bucket = (absPath: string): HtmlAnnotFileState => ({
    absPath,
    annotations: [],
    submission: null,
    compareState: null,
    frameSelectSignal: 0,
    reloadSignal: 0,
  });
  beforeEach(() => {
    useHtmlAnnotStore.setState({ byRef: { 'pages/index.html': bucket('/proj/pages/index.html') } });
  });

  it('relocate 命中：桶 key 迁到 newRel，absPath 同步换', () => {
    ha().relocate('pages/index.html', 'pages/home.html');
    expect(ha().byRef['pages/home.html']).toBeDefined();
    expect(ha().byRef['pages/home.html']!.absPath).toBe('/proj/pages/home.html');
    expect(ha().byRef['pages/index.html']).toBeUndefined();
  });

  it('relocate 子树命中：移动父文件夹 → 前缀替换（key + absPath）', () => {
    ha().relocate('pages', 'static/pages');
    expect(ha().byRef['static/pages/index.html']).toBeDefined();
    expect(ha().byRef['static/pages/index.html']!.absPath).toBe('/proj/static/pages/index.html');
  });

  it('relocate 不命中：什么都不做', () => {
    ha().relocate('other/x.html', 'other/y.html');
    expect(ha().byRef['pages/index.html']).toBeDefined();
  });

  it('closeIfUnder 命中 → 桶销毁', () => {
    ha().closeIfUnder('pages/index.html');
    expect(ha().byRef['pages/index.html']).toBeUndefined();
  });

  it('closeIfUnder 子树命中 → 销毁', () => {
    ha().closeIfUnder('pages');
    expect(ha().byRef['pages/index.html']).toBeUndefined();
  });

  it('closeIfUnder 不命中 → 不关', () => {
    ha().closeIfUnder('other');
    expect(ha().byRef['pages/index.html']).toBeDefined();
  });
});
