import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import { parseCsv } from '@shared/csv';

// ── mock 后端 RPC：用内存 existing 集模拟磁盘存在性，createFile/mkdir 撞名回 conflict ──
const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
  },
}));

import { useFsStore } from '@/stores/fsStore';

const S = () => useFsStore.getState();
const PRJ = 'prj_1';

let existing: Set<string>;

type CreatePayload = { type: string; projectId: string; path: string; content?: string };

function defaultWs(): void {
  requestMock.mockImplementation((payload: CreatePayload) => {
    switch (payload.type) {
      case 'fs.list':
        return Promise.resolve({ type: 'fs.list.result', projectId: payload.projectId, path: payload.path, entries: [] });
      case 'fs.watch':
        return Promise.resolve({ type: 'ack' });
      case 'fs.createFile':
      case 'fs.mkdir': {
        if (existing.has(payload.path))
          return Promise.resolve({ type: 'fs.create.result', projectId: payload.projectId, path: payload.path, status: 'conflict' });
        existing.add(payload.path);
        return Promise.resolve({ type: 'fs.create.result', projectId: payload.projectId, path: payload.path, status: 'ok' });
      }
      default:
        return Promise.reject(new Error('unexpected ' + payload.type));
    }
  });
}

/** 取所有 createFile/mkdir 请求的 payload（按调用序） */
function createCalls(): CreatePayload[] {
  return requestMock.mock.calls
    .map((c) => c[0] as CreatePayload)
    .filter((p) => p.type === 'fs.createFile' || p.type === 'fs.mkdir');
}

function setTree(entries: Record<string, FileNode[]>, selectedPath: string | null): void {
  useFsStore.setState({
    childrenByDir: new Map(Object.entries(entries)),
    expanded: new Set(Object.keys(entries).filter((k) => k !== '')),
    selectedPath,
  });
}

beforeEach(() => {
  existing = new Set();
  requestMock.mockReset();
  defaultWs();
  useFsStore.setState({
    childrenByDir: new Map(),
    truncatedByDir: new Map(),
    expanded: new Set(),
    loadingDir: new Set(),
    selectedPath: null,
    currentProjectId: PRJ,
    pendingNew: null,
  });
});

afterEach(() => {
  vi.clearAllTimers();
});

describe('落点：beginNew 按 selectedPath 派生 parentDir', () => {
  it('选中目录 → 建在它里面', () => {
    setTree({ '': [{ name: 'docs', path: 'docs', isDirectory: true }] }, 'docs');
    S().beginNew('md');
    expect(S().pendingNew?.parentDir).toBe('docs');
  });

  it('选中文件 → 建在同级目录', () => {
    setTree(
      {
        '': [{ name: 'docs', path: 'docs', isDirectory: true }],
        docs: [{ name: 'a.md', path: 'docs/a.md', isDirectory: false }],
      },
      'docs/a.md',
    );
    S().beginNew('md');
    expect(S().pendingNew?.parentDir).toBe('docs');
  });

  it('无选中 → 建在项目根', () => {
    setTree({ '': [] }, null);
    S().beginNew('md');
    expect(S().pendingNew?.parentDir).toBe('');
  });
});

describe('commitNew：提交永远产出文件，成功返回待打开路径', () => {
  it('名字非空 → 用输入名建，返回其路径（交 UI 层打开）', async () => {
    S().beginNew('md');
    S().updateNewName('readme');
    const opened = await S().commitNew();
    expect(createCalls()).toEqual([
      { type: 'fs.createFile', projectId: PRJ, path: 'readme.md', content: '' },
    ]);
    expect(opened).toBe('readme.md');
    expect(S().selectedPath).toBe('readme.md'); // 选中停在新文件
    expect(S().pendingNew).toBeNull(); // 起名行已清
  });

  it('名字留空 → 用默认名建，不让用户白点一下', async () => {
    S().beginNew('md');
    const opened = await S().commitNew();
    expect(createCalls()[0].path).toBe('未命名.md');
    expect(opened).toBe('未命名.md');
  });

  it('后缀归一：手输 foo.md 不叠成 foo.md.md', async () => {
    S().beginNew('md');
    S().updateNewName('foo.md');
    await S().commitNew();
    expect(createCalls()[0].path).toBe('foo.md');
  });

  it('CSV：建的是起步骨架（serializeCsv 生成、列数 ≥ 1），不是空串', async () => {
    S().beginNew('csv');
    const opened = await S().commitNew();
    const call = createCalls()[0];
    expect(call.type).toBe('fs.createFile');
    expect(call.path).toBe('未命名表格.csv');
    expect(call.content).not.toBe('');
    const table = parseCsv(call.content!);
    expect(table.headers.length).toBeGreaterThanOrEqual(1);
    expect(opened).toBe('未命名表格.csv');
  });

  it('文件夹 → 走 fs.mkdir，不进右栏（返回 null），展开它自己', async () => {
    S().beginNew('folder');
    S().updateNewName('归档');
    const opened = await S().commitNew();
    expect(createCalls()).toEqual([{ type: 'fs.mkdir', projectId: PRJ, path: '归档' }]);
    expect(opened).toBeNull(); // 文件夹不打开右栏
    expect(S().expanded.has('归档')).toBe(true); // 文件夹自己被展开
  });
});

describe('撞名分流（谁有机会重输谁让路）', () => {
  it('默认名撞名 → 自动加序号另存（未命名 2.md），不打断', async () => {
    existing.add('未命名.md');
    S().beginNew('md');
    const opened = await S().commitNew();
    const paths = createCalls().map((c) => c.path);
    expect(paths).toEqual(['未命名.md', '未命名 2.md']); // 先撞、再 +1
    expect(opened).toBe('未命名 2.md');
    expect(S().pendingNew).toBeNull();
  });

  it('用户亲手输的名字撞名 → 保持编辑态、置 error=已存在、不再让路落盘', async () => {
    existing.add('readme.md');
    S().beginNew('md');
    S().updateNewName('readme');
    const opened = await S().commitNew();
    expect(createCalls()).toHaveLength(1); // 只试了一次，不自动加序号
    expect(opened).toBeNull(); // 没建成、不打开
    expect(S().pendingNew?.error).toBe('已存在');
    expect(S().pendingNew?.name).toBe('readme'); // 行还在，名字还在
  });

  it('文件夹默认名撞名 → 走 mkdir 自动加序号；同样不打断', async () => {
    existing.add('未命名文件夹');
    S().beginNew('folder');
    await S().commitNew();
    const calls = createCalls();
    expect(calls.every((c) => c.type === 'fs.mkdir')).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['未命名文件夹', '未命名文件夹 2']);
  });
});

describe('二次提交守卫（Enter 提交后失焦再触发 onCommit）', () => {
  it('同一次起名并发两次 commitNew → 只建一个默认名文件，不会多建未命名 2', async () => {
    S().beginNew('md');
    const a = S().commitNew(); // Enter
    const b = S().commitNew(); // 第一次 await 未回时失焦再触发
    const [ra, rb] = await Promise.all([a, b]);
    expect(createCalls().map((c) => c.path)).toEqual(['未命名.md']); // 只此一个
    // 一个拿到打开路径，另一个被守卫拦下返回 null
    expect([ra, rb].filter((r) => r === '未命名.md')).toHaveLength(1);
    expect([ra, rb].filter((r) => r === null)).toHaveLength(1);
  });
});

describe('非法字符', () => {
  it('名字含 / → 不提交，保持编辑态并置 error', async () => {
    S().beginNew('md');
    S().updateNewName('a/b');
    const opened = await S().commitNew();
    expect(createCalls()).toHaveLength(0);
    expect(opened).toBeNull();
    expect(S().pendingNew?.error).toBeTruthy();
  });

  it('纯空白名 trim 后视同留空 → 走默认名', async () => {
    S().beginNew('md');
    S().updateNewName('   ');
    await S().commitNew();
    expect(createCalls()[0].path).toBe('未命名.md');
  });
});

describe('commitNew 并发重检（await 写盘期间被取消/切项目）', () => {
  it('await 写盘返回前 Esc 取消 → 不返回打开路径、不复活起名行', async () => {
    let resolveCreate!: (v: unknown) => void;
    requestMock.mockImplementation((payload: CreatePayload) => {
      if (payload.type === 'fs.createFile') return new Promise((res) => (resolveCreate = res));
      if (payload.type === 'fs.list') return Promise.resolve({ type: 'fs.list.result', projectId: PRJ, path: payload.path, entries: [] });
      return Promise.resolve({ type: 'ack' });
    });

    S().beginNew('md');
    S().updateNewName('x');
    const p = S().commitNew();
    S().cancelNew(); // await 期间用户按了 Esc
    resolveCreate({ type: 'fs.create.result', projectId: PRJ, path: 'x.md', status: 'ok' });
    const opened = await p;

    expect(opened).toBeNull();
    expect(S().pendingNew).toBeNull();
  });

  it('await 写盘返回前切到别的项目 → 不返回打开路径', async () => {
    let resolveCreate!: (v: unknown) => void;
    requestMock.mockImplementation((payload: CreatePayload) => {
      if (payload.type === 'fs.createFile') return new Promise((res) => (resolveCreate = res));
      if (payload.type === 'fs.list') return Promise.resolve({ type: 'fs.list.result', projectId: PRJ, path: payload.path, entries: [] });
      return Promise.resolve({ type: 'ack' });
    });

    S().beginNew('md');
    S().updateNewName('x');
    const p = S().commitNew();
    useFsStore.setState({ currentProjectId: 'prj_2', pendingNew: null }); // 切项目
    resolveCreate({ type: 'fs.create.result', projectId: PRJ, path: 'x.md', status: 'ok' });
    const opened = await p;

    expect(opened).toBeNull();
  });
});
