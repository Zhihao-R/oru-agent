/**
 * BrowserSession 活页面会话（S33 浏览器操控 · §5）。
 *
 * 验六件承重事：
 *  1. 会话按 conversationId 分桶：同对话复用一个窗口，异对话各开各的、不串页。
 *  2. 无痕（PM 拍板「不持久化、每次干净无痕」）：partition 无 persist: 前缀（内存 session）、
 *     sandbox/contextIsolation 开、权限请求一律拒。
 *  3. closeBrowserSession：debugger detach + 窗口销毁 + 出桶（再取新建）——副作用成对清理。
 *  4. 闲置超时自动回收；每次操作重置计时。
 *  5. await 后重检：navigate 换页后旧快照的 uid 过期，click 拒绝并要求重新快照。
 *  6. 交互走 CDP：click 按 box 中心派发鼠标事件；type 聚焦后 insertText、submit 补回车；
 *     navigate 拒非 http/https。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CdpCall = { method: string; params?: Record<string, unknown> };

const H = vi.hoisted(() => {
  const state = {
    spawned: [] as FakeBrowserWindow[],
    axNodes: [] as unknown[],
    /** DOM.describeNode 返回的 nodeName（OPTION 特判路径用） */
    nodeName: 'A',
    /** DOM.scrollIntoViewIfNeeded 抛错（模拟节点已被移除） */
    domThrow: false,
    /** 这些 CDP method 永不返回（模拟真机上离屏页面无响应——S33 playtest 实测的整轮挂死） */
    hangCommands: new Set<string>(),
    /** 对这些 URL 前缀的 loadURL 抛错（模拟站点不可达 / SSL 重置——S33 playtest 第 3 轮 google 被墙） */
    loadRejectFor: null as string | null,
  };

  class FakeWebContentsSession {
    permissionHandler: unknown = null;
    listeners = new Map<string, Set<(...a: unknown[]) => void>>();
    setPermissionRequestHandler(fn: unknown) {
      this.permissionHandler = fn;
    }
    on(ev: string, cb: (...a: unknown[]) => void) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
      this.listeners.get(ev)!.add(cb);
      return this;
    }
  }

  class FakeDebugger {
    attached = false;
    calls: CdpCall[] = [];
    attach(_v?: string) {
      this.attached = true;
    }
    detach() {
      this.attached = false;
    }
    isAttached() {
      return this.attached;
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      this.calls.push({ method, params });
      if (state.hangCommands.has(method)) return new Promise(() => {}); // 永不 settle
      if (method === 'Accessibility.getFullAXTree') return { nodes: state.axNodes };
      if (method === 'DOM.describeNode') return { node: { nodeName: state.nodeName } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj_1' } };
      if (method === 'DOM.scrollIntoViewIfNeeded' && state.domThrow)
        throw new Error('No node with given id found');
      if (method === 'DOM.getBoxModel')
        return { model: { content: [10, 10, 30, 10, 30, 20, 10, 20] } };
      return {};
    }
  }

  class FakeWebContents {
    debugger = new FakeDebugger();
    session = new FakeWebContentsSession();
    listeners = new Map<string, Set<(...a: unknown[]) => void>>();
    executedJs: string[] = [];
    windowOpenHandler: unknown = null;
    url = '';
    canGoBackFlag = false;
    navigationHistory = {
      canGoBack: () => this.canGoBackFlag,
      goBack: () => {
        this.emit('did-navigate');
        this.emit('did-finish-load');
      },
      // 真实 Electron：clear() 抹掉导航历史 → canGoBack 归 false（会话初始化清 about:blank 占位用）
      clear: () => {
        this.canGoBackFlag = false;
      },
    };
    on(ev: string, cb: (...a: unknown[]) => void) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
      this.listeners.get(ev)!.add(cb);
      return this;
    }
    once(ev: string, cb: (...a: unknown[]) => void) {
      const wrap = (...a: unknown[]) => {
        this.listeners.get(ev)?.delete(wrap);
        cb(...a);
      };
      return this.on(ev, wrap);
    }
    removeListener(ev: string, cb: (...a: unknown[]) => void) {
      this.listeners.get(ev)?.delete(cb);
      return this;
    }
    emit(ev: string, ...a: unknown[]) {
      for (const cb of [...(this.listeners.get(ev) ?? [])]) cb(...a);
    }
    async loadURL(url: string) {
      // 站点不可达 / SSL 重置：loadURL 拒绝，页面 URL 不变（不落到目标页）——真实 Electron 语义
      if (state.loadRejectFor && url.startsWith(state.loadRejectFor)) {
        throw new Error(`ERR_ABORTED (-3) loading '${url}'`);
      }
      this.url = url;
      this.canGoBackFlag = true;
      this.emit('did-navigate');
      this.emit('did-finish-load');
    }
    async executeJavaScript(code: string) {
      this.executedJs.push(code);
      return undefined;
    }
    setFrameRate(_n: number) {}
    setWindowOpenHandler(fn: unknown) {
      this.windowOpenHandler = fn;
    }
    stop() {}
    getTitle() {
      return 'Fake Title';
    }
    getURL() {
      return this.url;
    }
  }

  class FakeBrowserWindow {
    static instances = state.spawned;
    opts: Record<string, unknown>;
    webContents = new FakeWebContents();
    destroyed = false;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      state.spawned.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
  }

  return { state, FakeBrowserWindow };
});

vi.mock('electron', () => ({ BrowserWindow: H.FakeBrowserWindow }));

import {
  getOrCreateSession,
  closeBrowserSession,
  closeAllBrowserSessions,
  BROWSER_IDLE_MS,
} from '../../electron/main/browser/session';

/** 默认树：root + 一个可点 link（uid 将是 1/2 中 link 的那个） */
function defaultAxNodes() {
  return [
    {
      nodeId: '1',
      ignored: false,
      role: { value: 'RootWebArea' },
      name: { value: 'Page' },
      childIds: ['2'],
    },
    {
      nodeId: '2',
      parentId: '1',
      ignored: false,
      role: { value: 'link' },
      name: { value: 'Go' },
      backendDOMNodeId: 42,
    },
  ];
}

beforeEach(() => {
  H.state.spawned.length = 0;
  H.state.axNodes = defaultAxNodes();
  H.state.nodeName = 'A';
  H.state.domThrow = false;
  H.state.hangCommands.clear();
  H.state.loadRejectFor = null;
});

afterEach(() => {
  closeAllBrowserSessions();
  vi.useRealTimers();
});

describe('会话分桶与无痕', () => {
  it('同对话复用一个窗口，异对话各开各的', async () => {
    const a1 = await getOrCreateSession('conv_a');
    const a2 = await getOrCreateSession('conv_a');
    const b = await getOrCreateSession('conv_b');
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(H.state.spawned).toHaveLength(2);
  });

  it('并发建同一会话（await 后重检）：两边拿到同一个会话，不留孤儿窗口', async () => {
    const [a, b] = await Promise.all([getOrCreateSession('conv_x'), getOrCreateSession('conv_x')]);
    expect(a).toBe(b);
    // 后到者销毁自己那套窗口：存活窗口恰一个、且 debugger 无悬空 attach
    const alive = H.state.spawned.filter((w) => !w.destroyed);
    expect(alive).toHaveLength(1);
    for (const w of H.state.spawned.filter((x) => x.destroyed)) {
      expect(w.webContents.debugger.isAttached()).toBe(false);
    }
  });

  it('无痕窗口：内存 partition（无 persist: 前缀）、sandbox + contextIsolation、权限一律拒', async () => {
    await getOrCreateSession('conv_a');
    const win = H.state.spawned[0]!;
    const prefs = win.opts.webPreferences as Record<string, unknown>;
    expect(String(prefs.partition)).not.toMatch(/^persist:/);
    expect(String(prefs.partition).length).toBeGreaterThan(0);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(win.opts.show).toBe(false);
    // 锁真机验证过的窗口配置（playtest 2026-07-13 第 3 轮全链路通过）：普通隐藏窗口不用
    // offscreen（本会话不截图、离屏无收益），关后台节流保交互响应
    expect(prefs.offscreen).toBeUndefined();
    expect(prefs.backgroundThrottling).toBe(false);
    // 权限请求处理器已挂（geolocation / camera 等一律拒）
    expect(win.webContents.session.permissionHandler).toBeTruthy();
  });
});

describe('清理（副作用成对）', () => {
  it('closeBrowserSession：detach + destroy + 出桶（再取新建新窗口）', async () => {
    await getOrCreateSession('conv_a');
    const win = H.state.spawned[0]!;
    expect(win.webContents.debugger.isAttached()).toBe(true);
    closeBrowserSession('conv_a');
    expect(win.webContents.debugger.isAttached()).toBe(false);
    expect(win.destroyed).toBe(true);
    await getOrCreateSession('conv_a');
    expect(H.state.spawned).toHaveLength(2);
  });

  it('闲置超时自动回收；每次操作重置计时', async () => {
    vi.useFakeTimers();
    const s = await getOrCreateSession('conv_a');
    const win = H.state.spawned[0]!;
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS - 1000);
    const nav = s.navigate('https://example.com'); // 操作重置计时（内部 settle 延时靠推进时钟走完）
    await vi.advanceTimersByTimeAsync(500);
    await nav;
    await vi.advanceTimersByTimeAsync(BROWSER_IDLE_MS - 1000);
    expect(win.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(win.destroyed).toBe(true);
  });
});

describe('导航与 await 后重检', () => {
  it('navigate 拒非 http/https（file:// 不能借浏览器绕过文件沙箱）', async () => {
    const s = await getOrCreateSession('conv_a');
    await expect(s.navigate('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(s.navigate('javascript:alert(1)')).rejects.toThrow(/http/);
  });

  it('navigate 到不可达站点：loadURL 拒绝且没落到任何页 → 抛可读错误、不挂死（S33 第 3 轮 google 被墙）', async () => {
    // 修复前：loadURL 的 reject 被吞、race 交给 20s timeout 空等，真机上被 SSL 持续重置的站点整轮挂住。
    // 修复后：reject 即结束等待；仍停在初始 about:blank（没落到目标页）→ 抛「打不开」引导换站。
    H.state.loadRejectFor = 'https://blocked.example';
    const s = await getOrCreateSession('conv_a');
    await expect(s.navigate('https://blocked.example/x')).rejects.toThrow(/打不开/);
  });

  it('navigate 换页后旧快照 uid 过期：click 拒绝并要求重新快照', async () => {
    const s = await getOrCreateSession('conv_a');
    await s.navigate('https://example.com');
    const snap = await s.snapshot();
    expect(snap.text).toContain('[uid=');
    await s.navigate('https://example.com/other'); // 页面已换（did-navigate → epoch++）
    await expect(s.click(1)).rejects.toThrow(/快照/);
  });

  it('未知 uid 拒绝（不猜元素——绝不改错的同族纪律）', async () => {
    const s = await getOrCreateSession('conv_a');
    await s.navigate('https://example.com');
    await s.snapshot();
    await expect(s.click(999)).rejects.toThrow(/uid/);
  });
});

describe('页面内交互走 CDP', () => {
  it('click：滚入视野 + 按 box 中心派发 mousePressed/mouseReleased', async () => {
    const s = await getOrCreateSession('conv_a');
    await s.navigate('https://example.com');
    await s.snapshot();
    await s.click(1);
    const calls = H.state.spawned[0]!.webContents.debugger.calls;
    expect(calls.some((c) => c.method === 'DOM.scrollIntoViewIfNeeded')).toBe(true);
    const mouse = calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((c) => c.params?.type)).toEqual(['mousePressed', 'mouseReleased']);
    // box content [10,10,30,10,30,20,10,20] → 中心 (20,15)
    expect(mouse[0]!.params).toMatchObject({ x: 20, y: 15, button: 'left', clickCount: 1 });
  });

  it('type：聚焦 + insertText；submit=true 补回车键', async () => {
    const s = await getOrCreateSession('conv_a');
    await s.navigate('https://example.com');
    await s.snapshot();
    await s.typeText(1, 'hello', true);
    const calls = H.state.spawned[0]!.webContents.debugger.calls;
    expect(calls.some((c) => c.method === 'DOM.focus' && c.params?.backendNodeId === 42)).toBe(true);
    expect(
      calls.some((c) => c.method === 'Input.insertText' && c.params?.text === 'hello'),
    ).toBe(true);
    const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(keys.length).toBeGreaterThanOrEqual(2); // Enter down + up
  });

  it('scroll：无 uid 按方向滚一屏（mouseWheel）；带 uid 滚到元素', async () => {
    const s = await getOrCreateSession('conv_a');
    await s.navigate('https://example.com');
    await s.snapshot();
    await s.scroll({ direction: 'down' });
    const calls = H.state.spawned[0]!.webContents.debugger.calls;
    const wheel = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseWheel');
    expect(wheel).toBeTruthy();
    expect(Number(wheel!.params?.deltaY)).toBeGreaterThan(0);
    await s.scroll({ uid: 1 });
    expect(calls.filter((c) => c.method === 'DOM.scrollIntoViewIfNeeded')).toHaveLength(1);
  });

  it('back：无历史时如实返回 noHistory，不假装回退了', async () => {
    const s = await getOrCreateSession('conv_a');
    const r = await s.back();
    expect(r).toMatchObject({ noHistory: true });
  });

  it('原生 <option> 特判：JS 选中 + 派 change，不走坐标点击（折叠下拉点不到）', async () => {
    const s = await getOrCreateSession('conv_a');
    await s.navigate('https://example.com');
    await s.snapshot();
    H.state.nodeName = 'OPTION';
    await s.click(1);
    const calls = H.state.spawned[0]!.webContents.debugger.calls;
    expect(calls.some((c) => c.method === 'Runtime.callFunctionOn')).toBe(true);
    expect(calls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('节点已被移除（SPA 页内换视图）：DOM 层错误翻译成「重新快照」引导', async () => {
    const s = await getOrCreateSession('conv_a');
    await s.navigate('https://example.com');
    await s.snapshot();
    H.state.domThrow = true;
    await expect(s.click(1)).rejects.toThrow(/browser_snapshot/);
  });
});

describe('CDP 无响应不挂轮（S33 playtest 实测：真机整轮永久 running 的回归）', () => {
  it('getFullAXTree 悬死：snapshot 在超时后报错浮出，不无限等待', async () => {
    const s = await getOrCreateSession('conv_a');
    vi.useFakeTimers();
    H.state.hangCommands.add('Accessibility.getFullAXTree');
    const p = s.snapshot();
    const assertion = expect(p).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('创建期 Accessibility.enable 悬死：getOrCreateSession 报错且窗口销毁，不留孤儿', async () => {
    vi.useFakeTimers();
    H.state.hangCommands.add('Accessibility.enable');
    const p = getOrCreateSession('conv_hang');
    const assertion = expect(p).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(H.state.spawned.every((w) => w.destroyed)).toBe(true);
    // 失败的创建不留半截会话：下次可重建
    vi.useRealTimers();
    H.state.hangCommands.clear();
    const s = await getOrCreateSession('conv_hang');
    expect(s).toBeTruthy();
  });
});
