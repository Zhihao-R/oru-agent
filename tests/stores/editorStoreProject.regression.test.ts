// @vitest-environment jsdom

/**
 * editorStore 项目后端回归测试——重构 DocRef 泛化前应 PASS，重构后同样应 PASS。
 * 覆盖：open(projectId,path) + setContent(path) + flush(path) + manualSnapshot(path)
 *       + bindEditorAutoSync 收到 fs.changed 时按 projectId+path 匹配触发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
const subscribeMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: (...args: unknown[]) => subscribeMock(...args),
    onStatus: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import {
  useEditorStore,
  bindEditorAutoSync,
  __resetEditorAutoSyncForTest,
} from '@/stores/editorStore';
import type { ServerEvent } from '@shared/protocol';

const S = () => useEditorStore.getState();
const PRJ = 'prj_reg';
const PATH = 'notes/hello.md';

// 模拟磁盘：按 path 存内容
let disk: Record<string, string> = {};

type WsPayload = {
  type: string;
  projectId?: string;
  path?: string;
  content?: string;
  mark?: string;
  baseline?: unknown;
  mergeOnStale?: boolean;
  on?: boolean;
};

function setupDefaultWs(): void {
  requestMock.mockImplementation((p: WsPayload) => {
    switch (p.type) {
      case 'fs.readMd':
        return Promise.resolve({
          type: 'fs.md.content',
          projectId: p.projectId,
          path: p.path,
          content: disk[p.path!] ?? '',
        });
      case 'fs.writeMd':
        disk[p.path!] = p.content ?? '';
        return Promise.resolve({
          type: 'fs.md.saved',
          projectId: p.projectId,
          path: p.path,
          result: 'written' as const,
        });
      case 'fs.history.sample':
        return Promise.resolve({ type: 'ack' });
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
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {}); // subscribe 默认返回 unsub noop
  setupDefaultWs();
  disk = {};
  useEditorStore.setState({ files: {} });
  __resetEditorAutoSyncForTest();
});

afterEach(() => {
  __resetEditorAutoSyncForTest();
  for (const p of Object.keys(S().files)) S().close(p);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('项目后端回归：open + setContent + flush', () => {
  it('open(projectId, path) 读磁盘成功后桶 content/lastSyncedContent 一致', async () => {
    disk[PATH] = 'init-content';
    await S().open(PRJ, PATH);

    const f = S().files[PATH];
    expect(f).toBeDefined();
    expect(f.content).toBe('init-content');
    expect(f.lastSyncedContent).toBe('init-content');
    expect(f.loading).toBe(false);
  });

  it('setContent(path) + flush(path) 发 fs.writeMd（含 projectId, path, content）', async () => {
    disk[PATH] = 'base';
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'new-content');
    await S().flush(PATH);

    const writes = writeCalls();
    expect(writes).toHaveLength(1);
    expect(writes[0].projectId).toBe(PRJ);
    expect(writes[0].path).toBe(PATH);
    expect(writes[0].content).toBe('new-content');
    expect(disk[PATH]).toBe('new-content');
    expect(S().files[PATH].lastSyncedContent).toBe('new-content');
  });

  it('setContent(path) debounce 800ms 后自动发 fs.writeMd（含 projectId）', async () => {
    disk[PATH] = 'base';
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'typed-later');
    expect(writeCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(800);

    const writes = writeCalls();
    expect(writes).toHaveLength(1);
    expect(writes[0].content).toBe('typed-later');
    expect(writes[0].projectId).toBe(PRJ);
    expect(writes[0].path).toBe(PATH);
  });
});

describe('项目后端回归：manualSnapshot', () => {
  it('manualSnapshot(path) 发 fs.writeMd 且 mark === "manual"', async () => {
    disk[PATH] = 'base';
    await S().open(PRJ, PATH);
    S().setContent(PATH, 'snapshot-me');
    await S().manualSnapshot(PATH);

    const writes = writeCalls();
    expect(writes).toHaveLength(1);
    expect(writes[0].mark).toBe('manual');
    expect(writes[0].content).toBe('snapshot-me');
    expect(writes[0].projectId).toBe(PRJ);
    expect(writes[0].path).toBe(PATH);
    expect(disk[PATH]).toBe('snapshot-me');
  });
});

describe('项目后端回归：bindEditorAutoSync 匹配 projectId+path', () => {
  it('收到 fs.changed{projectId, filePath} 命中打开桶时触发 syncFromDisk', async () => {
    disk[PATH] = 'v1';
    await S().open(PRJ, PATH);

    // 捕获 subscribe 注册的回调
    let serverEventHandler: ((ev: ServerEvent) => void) | undefined;
    subscribeMock.mockImplementation((handler: (ev: ServerEvent) => void) => {
      serverEventHandler = handler;
      return () => {};
    });

    bindEditorAutoSync();
    expect(serverEventHandler).toBeDefined();

    // 模拟外部改动落盘后广播
    disk[PATH] = 'v2-external';
    serverEventHandler!({
      type: 'fs.changed',
      projectId: PRJ,
      filePath: PATH,
    } as ServerEvent);

    await vi.advanceTimersByTimeAsync(0);

    // 无本地编辑 → 读盘刷新
    expect(S().files[PATH].content).toBe('v2-external');
    expect(S().files[PATH].lastSyncedContent).toBe('v2-external');
  });

  it('收到 fs.changed 但 projectId 不匹配：不触发 syncFromDisk', async () => {
    disk[PATH] = 'v1';
    await S().open(PRJ, PATH);

    let serverEventHandler: ((ev: ServerEvent) => void) | undefined;
    subscribeMock.mockImplementation((handler: (ev: ServerEvent) => void) => {
      serverEventHandler = handler;
      return () => {};
    });

    bindEditorAutoSync();

    // 另一个项目发来的 changed
    disk[PATH] = 'v2-other';
    serverEventHandler!({
      type: 'fs.changed',
      projectId: 'other_prj',
      filePath: PATH,
    } as ServerEvent);

    await vi.advanceTimersByTimeAsync(0);
    // projectId 不匹配，不应触发刷新
    expect(S().files[PATH].content).toBe('v1');
  });

  it('收到 fs.changed 但 filePath 不匹配：不触发 syncFromDisk', async () => {
    disk[PATH] = 'v1';
    await S().open(PRJ, PATH);

    let serverEventHandler: ((ev: ServerEvent) => void) | undefined;
    subscribeMock.mockImplementation((handler: (ev: ServerEvent) => void) => {
      serverEventHandler = handler;
      return () => {};
    });

    bindEditorAutoSync();

    serverEventHandler!({
      type: 'fs.changed',
      projectId: PRJ,
      filePath: 'other/file.md',
    } as ServerEvent);

    await vi.advanceTimersByTimeAsync(0);
    // filePath 不命中桶，不触发刷新
    expect(S().files[PATH].content).toBe('v1');
  });
});

describe('跨项目竞态：syncFromDisk 读盘 await 期间换项目（docId 守卫）', () => {
  const PRJ_A = 'prj_A';
  const PRJ_B = 'prj_B';

  it('prjA 读盘在途时同 path 换成 prjB 桶 → prjA 磁盘内容不污染 prjB 桶', async () => {
    // prjA 打开 a.md（磁盘旧内容），prjB 尚未介入
    disk[PATH] = 'A-disk-old';
    await S().open(PRJ_A, PATH);
    expect(S().files[PATH].ref).toEqual({ kind: 'project', projectId: PRJ_A, path: PATH });

    // 让下一次 fs.readMd 卡住不 resolve——模拟 prjA 读盘在途
    let releaseReadA: (content: string) => void = () => {};
    const readAInFlight = new Promise<string>((res) => {
      releaseReadA = res;
    });
    requestMock.mockImplementation((p: WsPayload) => {
      switch (p.type) {
        case 'fs.readMd':
          return readAInFlight.then((content) => ({
            type: 'fs.md.content',
            projectId: p.projectId,
            path: p.path,
            content,
          }));
        case 'fs.writeMd':
          disk[p.path!] = p.content ?? '';
          return Promise.resolve({ type: 'fs.md.saved', projectId: p.projectId, path: p.path, result: 'written' as const });
        case 'fs.history.sample':
          return Promise.resolve({ type: 'ack' });
        default:
          return Promise.reject(new Error('unexpected ' + p.type));
      }
    });

    // 触发 prjA 的 syncFromDisk（无本地编辑 → 走读盘刷新支），此时读盘卡在 readAInFlight
    let serverEventHandler: ((ev: ServerEvent) => void) | undefined;
    subscribeMock.mockImplementation((handler: (ev: ServerEvent) => void) => {
      serverEventHandler = handler;
      return () => {};
    });
    bindEditorAutoSync();
    serverEventHandler!({ type: 'fs.changed', projectId: PRJ_A, filePath: PATH } as ServerEvent);
    await vi.advanceTimersByTimeAsync(0); // 进入 syncFromDisk，停在 await readDisk

    // 用户在 await 期间关掉 prjA 的 a.md、用 prjB 重开同 path——桶被 prjB 替换（同 refKey=path）
    useEditorStore.setState({
      files: {
        [PATH]: {
          ref: { kind: 'project', projectId: PRJ_B, path: PATH },
          content: 'B-content',
          lastSyncedContent: 'B-content',
          loading: false,
        },
      },
    });

    // 现在放行 prjA 的读盘，返回 prjA 的磁盘内容
    releaseReadA('A-disk-old');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    // docId 守卫（projectId 维度）应挡住：prjB 桶内容不被 prjA 磁盘内容污染
    expect(S().files[PATH].ref).toEqual({ kind: 'project', projectId: PRJ_B, path: PATH });
    expect(S().files[PATH].content).toBe('B-content');
    expect(S().files[PATH].lastSyncedContent).toBe('B-content');
  });
});
