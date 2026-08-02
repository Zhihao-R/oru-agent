/**
 * 浏览器操控的活页面会话（S33 · §5）—— 六件 browser_* 工具共享的「当前页」。
 *
 * 一个会话 = 一个离屏 BrowserWindow + 其 webContents.debugger（CDP），按会话桶 key 入桶
 * （key = ctx.browserSessionId ?? conversationId：主对话按对话入桶；对话期 subagent 的
 * conversationId 与主对话相同，用独立 browserSessionId 隔离，不与主对话抢「当前页」）。
 * PM 拍板「不持久化、每次干净无痕」：partition 用无 persist: 前缀的内存 session（Electron
 * 默认 session 是持久的、还与应用共享，直接违背无痕——故不用默认 session，实施方案 §5 的
 * 「默认临时 session」在此修正为内存 partition），窗口关闭即一切 cookie / storage 蒸发。
 *
 * 副作用生命周期（CLAUDE.md 约定）：窗口、debugger attach、闲置计时器成对收在 Session 结构里，
 * closeSession 统一 detach + destroy + 清计时器；触发时机 = 对话归档/删除/清空（ws handler 调
 * closeBrowserSession，只覆盖主对话桶；subagent 桶靠闲置超时回收）、闲置超时、应用退出
 * （closeAllBrowserSessions）。回调闭包捕获创建时的 session 实例，不读模块全局。
 *
 * await 后重检（CLAUDE.md 约定）：主框架每次导航 epoch+1，快照发出的 uid 记录发出时的 epoch，
 * click/type 先核 epoch——navigate 之后页面可能已被另一次工具调用换掉，过期即拒、要求重新快照，
 * 不沿用旧页面态操作错元素（绝不改错的同族纪律）。
 */
import type { BrowserWindow } from 'electron';
import { formatAxTree, type AXNode, type SnapshotFormatResult } from './snapshotFormat';

/** 闲置回收阈值：最后一次操作返回后计时。初值定性正确（分钟级留活页、小时级必回收），待观察调整。 */
export const BROWSER_IDLE_MS = 10 * 60_000;
const NAVIGATE_TIMEOUT_MS = 20_000;
/** 页面加载后的短 settle：等首帧脚本把首屏 DOM 立起来再快照（对齐 htmlRenderer 的 settle 语义） */
const SETTLE_MS = 300;
/** 点按/输入后的短 settle：给可能触发的跳转/重渲染让路，回执里的当前 URL 才可信 */
const INTERACTION_SETTLE_MS = 150;
const VIEWPORT = { width: 1280, height: 900 };
/** 覆盖式输入的全选脚本：select() 只在 input/textarea 上存在，其余静默跳过 */
const SELECT_ALL_JS =
  'document.activeElement && typeof document.activeElement.select === "function" && document.activeElement.select()';

export type BrowserSessionHandle = {
  /** 导航到 url（仅 http/https），返回落地后的地址与标题 */
  navigate(url: string): Promise<{ url: string; title: string }>;
  /** 读当前页 a11y 树文本（带 uid）；offset=1-based 起始行，超封顶分页续读 */
  snapshot(offset?: number): Promise<Pick<SnapshotFormatResult, 'text' | 'truncated' | 'totalLines' | 'nextOffset'>>;
  click(uid: number): Promise<void>;
  typeText(uid: number, text: string, submit?: boolean): Promise<void>;
  scroll(arg: { direction?: 'up' | 'down'; uid?: number }): Promise<void>;
  back(): Promise<{ url: string; title: string } | { noHistory: true }>;
  currentUrl(): string;
};

type Session = BrowserSessionHandle & {
  key: string;
  win: BrowserWindow;
  /** 主框架每次导航 +1（loadURL / 点链接 / 回退；不含页内 pushState）；uid 的有效性凭据 */
  epoch: number;
  uidMap: Map<number, { backendNodeId: number; epoch: number }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const sessions = new Map<string, Session>();

/**
 * 单条 CDP 命令的硬超时。playtest 实测（2026-07-13）：CDP 可能**静默不返回**（实证是
 * 空白 renderer 上的 Accessibility.enable，已由 about:blank 预加载修掉根因），没有超时
 * 整轮对话就永久挂在 running——每条命令必须经 cdp() 走这个兜底闸，超时报错浮出给模型。
 */
const CDP_TIMEOUT_MS = 10_000;

function cdp<T = unknown>(
  dbg: { sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> },
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CDP ${method} 超时（${CDP_TIMEOUT_MS}ms）——页面无响应`)),
      CDP_TIMEOUT_MS,
    );
    dbg.sendCommand(method, params).then(
      (v) => {
        clearTimeout(timer);
        resolve(v as T);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// 动态 import：electron 只在主进程运行时有具名导出（对齐 htmlRenderer 的加载方式）。
// 共享同一份 promise：并发首建会话时不重复解析模块。
let electronModule: Promise<typeof import('electron')> | undefined;
const loadElectron = () => (electronModule ??= import('electron'));

export async function getOrCreateSession(sessionKey: string): Promise<BrowserSessionHandle> {
  const existing = sessions.get(sessionKey);
  if (existing) {
    touch(existing);
    return existing;
  }

  const { BrowserWindow } = await loadElectron();
  // 普通隐藏窗口而非 offscreen。溯源（playtest 2026-07-13）：第 2 轮曾把 Accessibility.enable
  // 卡死归因 offscreen 而改成隐藏窗口，第 3 轮证伪——真因是空白 renderer（无已提交文档）上
  // enable 永不返回，已由下方 about:blank 预加载修掉。保留隐藏窗口：这是整链路真机验证过的
  // 配置，且本会话不截图、offscreen 的静默/色准收益为零，不值得回切再赌一轮验证。
  // show:false 不见窗口；x/y 抛到屏外是防御（万一被第三方唤起 show 也不闪在用户脸上）。
  const win = new BrowserWindow({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    show: false,
    x: -32000,
    y: -32000,
    webPreferences: {
      // 无 persist: 前缀 → 内存 session：cookie/storage 随窗口关闭蒸发（PM「干净无痕」）；
      // 按会话桶独立命名，异桶即便同时活着也互不见彼此的会话态。
      partition: `oru-browser-${sessionKey}`,
      nodeIntegration: false,
      contextIsolation: true,
      // 与 htmlRenderer（sandbox:false，渲染自有产物）不同：这里加载任意互联网页面，开满沙箱
      sandbox: true,
      webSecurity: true,
      // 隐藏窗口默认被后台节流（定时器/渲染降频）——点按后页面要及时重渲染，关掉
      backgroundThrottling: false,
    },
  });
  // 权限（摄像头/地理位置/通知…）一律拒：无痕会话不代用户授任何权
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  // 下载一律取消：浏览器操控读页面、不落文件（落文件走既有文件工具的守卫链）
  win.webContents.session.on('will-download', (e) => e.preventDefault());

  const session: Session = {
    key: sessionKey,
    win,
    epoch: 0,
    uidMap: new Map(),
    idleTimer: null,
    currentUrl: () => win.webContents.getURL(),

    async navigate(url: string) {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`仅支持 http/https 地址，得到：${url}`);
      }
      touch(session);
      // navigate 的语义：尽力加载，到点/失败都返回当前页面态，让模型基于随后的 snapshot 决定
      // 下一步——绝不因加载失败把整轮挂住或抛裸协议错。三种收场统一「结束等待、返回落地 URL」：
      //   1. load 成功 resolve → 页面加载完
      //   2. load 拒绝（ERR_ABORTED / SSL 重置 / DNS 失败 …）→ 不抛，记下错误、照样返回当前 URL
      //      （被 SSL 持续重置 + 重定向重试的站点上 loadURL 可能 4s 就 reject，此路径必须自愈，
      //       否则 race 交给 timeout 空等 20s、真机实测 google 被 GFW 重置会挂死——playtest 第 3 轮）
      //   3. 都没发生但超了 NAVIGATE_TIMEOUT_MS → stop 掉未完成加载，已渲染部分照样可操作
      console.log(`[browser] navigate 开始 ${url}`);
      let loadError: string | undefined;
      const load = win.webContents.loadURL(url).then(
        () => {},
        (e: unknown) => {
          loadError = e instanceof Error ? e.message : String(e);
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((res) => {
        timer = setTimeout(() => {
          win.webContents.stop();
          res();
        }, NAVIGATE_TIMEOUT_MS);
      });
      try {
        await Promise.race([load, timeout]);
      } finally {
        clearTimeout(timer);
      }
      await delay(SETTLE_MS);
      touch(session);
      const landedUrl = win.webContents.getURL();
      // 加载失败且没落到任何真实页面（仍是初始 about:blank）：抛可读错误让模型知道该换站/换法，
      // 而非返回空白页让它对着空快照瞎猜。已落到某页（部分渲染 / 重定向到别处）则视作可用、返回。
      if (loadError && (landedUrl === 'about:blank' || landedUrl === '')) {
        console.log(`[browser] navigate 失败 ${url}：${loadError}`);
        throw new Error(`打不开 ${url}（${loadError}）——换个可访问的地址再试`);
      }
      console.log(`[browser] navigate 完成 ${landedUrl}`);
      return { url: landedUrl, title: win.webContents.getTitle() };
    },

    async snapshot(offset?: number) {
      touch(session);
      const { nodes } = await cdp<{ nodes: AXNode[] }>(
        win.webContents.debugger,
        'Accessibility.getFullAXTree',
      );
      const r = formatAxTree(nodes, offset !== undefined ? { offset } : undefined);
      // 换代：旧快照的 uid 全部作废（uid 只在最新一次快照内有意义；分页续读是同一棵树的
      // 再取全树，uid 按全树分配、各窗口一致，重建映射不影响已知 uid 的指向）
      session.uidMap.clear();
      for (const [uid, backendNodeId] of r.uidToBackendNodeId) {
        session.uidMap.set(uid, { backendNodeId, epoch: session.epoch });
      }
      touch(session);
      return { text: r.text, truncated: r.truncated, totalLines: r.totalLines, nextOffset: r.nextOffset };
    },

    async click(uid: number) {
      const backendNodeId = resolveUid(session, uid);
      touch(session);
      const dbg = win.webContents.debugger;
      await translateDomError(uid, async () => {
        // 原生 <option> 特判：折叠的下拉里 option 无有效 box、坐标点击点不到——
        // 直接选中 + 派 input/change（Playwright selectOption 同款做法）
        const desc = await cdp<{ node?: { nodeName?: string } }>(dbg, 'DOM.describeNode', {
          backendNodeId,
        });
        if (desc.node?.nodeName === 'OPTION') {
          const { object } = await cdp<{ object: { objectId: string } }>(dbg, 'DOM.resolveNode', {
            backendNodeId,
          });
          await cdp(dbg, 'Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function() {
              this.selected = true;
              var s = this.closest('select');
              if (s) {
                s.value = this.value;
                s.dispatchEvent(new Event('input', { bubbles: true }));
                s.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }`,
          });
          return;
        }
        await cdp(dbg, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
        const { x, y } = await centerOf(session, backendNodeId);
        const base = { x, y, button: 'left', clickCount: 1 };
        await cdp(dbg, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
        await cdp(dbg, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      });
      await delay(INTERACTION_SETTLE_MS);
      touch(session);
    },

    async typeText(uid: number, text: string, submit?: boolean) {
      const backendNodeId = resolveUid(session, uid);
      touch(session);
      const dbg = win.webContents.debugger;
      await translateDomError(uid, async () => {
        await cdp(dbg, 'DOM.focus', { backendNodeId });
        // 覆盖式输入：先全选已有内容，insertText 落下即替换。select() 只在 input/textarea 上存在——
        // contenteditable（富文本框）无此方法，落成 caret 处插入（局限已写进工具 description）。
        await cdp(
          { sendCommand: () => win.webContents.executeJavaScript(SELECT_ALL_JS) },
          'Runtime.evaluate(selectAll)',
        );
        await cdp(dbg, 'Input.insertText', { text });
        if (submit) {
          const enter = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' };
          await cdp(dbg, 'Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...enter });
          await cdp(dbg, 'Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
        }
      });
      await delay(INTERACTION_SETTLE_MS);
      touch(session);
    },

    async scroll(arg: { direction?: 'up' | 'down'; uid?: number }) {
      touch(session);
      const dbg = win.webContents.debugger;
      if (arg.uid !== undefined) {
        const backendNodeId = resolveUid(session, arg.uid);
        await translateDomError(arg.uid, () =>
          cdp(dbg, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).then(() => {}),
        );
      } else {
        const deltaY = (arg.direction === 'up' ? -1 : 1) * Math.round(VIEWPORT.height * 0.8);
        await cdp(dbg, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(VIEWPORT.width / 2),
          y: Math.round(VIEWPORT.height / 2),
          deltaX: 0,
          deltaY,
        });
      }
      touch(session);
    },

    async back() {
      touch(session);
      const nav = win.webContents.navigationHistory;
      if (!nav.canGoBack()) return { noHistory: true as const };
      let onLoad!: () => void;
      const done = new Promise<void>((resolve) => {
        onLoad = () => resolve();
        win.webContents.once('did-finish-load', onLoad);
      });
      nav.goBack();
      try {
        await Promise.race([done, delay(NAVIGATE_TIMEOUT_MS)]);
      } finally {
        // 超时赢得 race 时 once 监听器仍挂着（窗口长命，不像 htmlRenderer 用完即销）——显式摘除
        win.webContents.removeListener('did-finish-load', onLoad);
      }
      await delay(SETTLE_MS);
      touch(session);
      return { url: win.webContents.getURL(), title: win.webContents.getTitle() };
    },
  };

  // 主框架每次导航（loadURL / 点链接 / 回退）epoch+1——uid 过期的判据。
  // 页内导航（pushState/hash）不在此列：DOM 未重建、backendNodeId 仍有效，SPA 换视图后
  // 失效的个别 uid 由 DOM 层错误统一翻译成「重新快照」引导（translateDomError）。
  win.webContents.on('did-navigate', () => {
    session.epoch += 1;
  });
  // 弹窗（target=_blank / window.open）不开新窗：同一窗口跟进导航，保持「一个会话一页」的模型
  //（搜索结果页大量 _blank 链接，deny 掉点击就全部失灵）。跨站跟进不再过闸是已声明的残余风险
  //（进站审批锚定的是 navigate 动作，见 techdoc §7）。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) win.webContents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });

  try {
    win.webContents.debugger.attach('1.3');
    // 先立起一个已提交文档再 enable：真机实测（playtest 2026-07-13 第 3 轮）——空白窗口
    // （renderer 尚无 committed document）上 Accessibility.enable **永不返回**（必卡超时），
    // 与 offscreen 无关；先 loadURL('about:blank') 等 did-finish-load 后 enable 立即返回（实测 3ms）。
    // 放在此处而非首次 navigate 后：让会话「一建好即完全可用」——snapshot/click 走 peekSession
    // 只取不建，会话在册就必须能调 getFullAXTree，不能把 enable 拖到真实 navigate 才做。
    await win.webContents.loadURL('about:blank');
    await cdp(win.webContents.debugger, 'Accessibility.enable');
    // about:blank 只是初始化占位，不该算进用户可见的导航历史（否则刚建会话就 back 会「回退到
    // 空白页」而非如实说无历史）——清掉它、把 epoch 归零，会话对外呈现「干净、无历史、epoch=0」。
    win.webContents.navigationHistory.clear();
    session.epoch = 0;
  } catch (e) {
    // 初始化失败不留半截会话：销毁窗口、把可读错误抛给工具层（下次调用可重建）
    try {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    } catch {
      /* 同 closeSession 兜底 */
    }
    win.destroy();
    throw new Error(`浏览器会话初始化失败：${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`[browser] 会话就绪 key=${sessionKey}`);

  // await 后重检（CLAUDE.md）：上面一串 await 期间同 key 的并发调用可能已建好会话入桶——
  // 后到者销毁自己这套、用先到者的，否则先到者被覆盖出桶成孤儿窗口（debugger 悬空）。
  const raced = sessions.get(sessionKey);
  if (raced) {
    try {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    } catch {
      /* 见 closeSession 同款兜底 */
    }
    win.destroy();
    touch(raced);
    return raced;
  }
  sessions.set(sessionKey, session);
  touch(session);
  return session;
}

/** 只取不建：browser_snapshot/click 等页面内工具用——没活页面该报错引导 navigate，不该白开窗口 */
export function peekSession(sessionKey: string): BrowserSessionHandle | undefined {
  const s = sessions.get(sessionKey);
  if (s) touch(s);
  return s;
}

/** 对话归档 / 删除 / 清空时调（传 conversationId 即主对话桶）：活页面立即回收（无会话则 no-op） */
export function closeBrowserSession(sessionKey: string): void {
  const s = sessions.get(sessionKey);
  if (!s) return;
  sessions.delete(sessionKey);
  closeSession(s);
}

/** 应用退出 / 测试收尾：回收全部 */
export function closeAllBrowserSessions(): void {
  const all = [...sessions.values()];
  sessions.clear();
  for (const s of all) closeSession(s);
}

function closeSession(s: Session): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = null;
  try {
    if (!s.win.isDestroyed() && s.win.webContents.debugger.isAttached()) {
      s.win.webContents.debugger.detach();
    }
  } catch {
    /* 窗口销毁本会自动解绑；detach 万一抛错不该掩盖清理 */
  }
  if (!s.win.isDestroyed()) s.win.destroy();
}

/**
 * 重置闲置计时。每个操作**进出各调一次**：入口 touch 防「长操作跑到一半被闲置回收」，
 * 出口 touch 让计时从「最后一次操作返回」起算（BROWSER_IDLE_MS 的语义）。
 * 到点自查桶里还是不是自己（防误删重建后的新会话）再回收。
 */
function touch(s: Session): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (sessions.get(s.key) === s) sessions.delete(s.key);
    closeSession(s);
  }, BROWSER_IDLE_MS);
}

/** uid → backendNodeId：未知 uid / 已换页（epoch 过期）都拒，要求重新快照 */
function resolveUid(s: Session, uid: number): number {
  const entry = s.uidMap.get(uid);
  if (!entry) {
    throw new Error(`uid=${uid} 不在当前快照里——先调 browser_snapshot 拿最新的元素引用`);
  }
  if (entry.epoch !== s.epoch) {
    throw new Error('页面已经跳转，这份快照过期了——请重新 browser_snapshot 再操作');
  }
  return entry.backendNodeId;
}

/**
 * DOM 层 CDP 失败（节点已被移除 / 不可见等）统一翻译成「重新快照」引导——
 * SPA 页内换视图不 bump epoch，个别 uid 失效时模型该拿到能看懂的下一步，不是裸协议错误。
 */
async function translateDomError(uid: number, op: () => Promise<void>): Promise<void> {
  try {
    await op();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`uid=${uid} 对应的元素操作失败（页面内容可能已变化：${msg}）——请重新 browser_snapshot 再操作`);
  }
}

async function centerOf(s: Session, backendNodeId: number): Promise<{ x: number; y: number }> {
  const { model } = await cdp<{ model: { content: number[] } }>(
    s.win.webContents.debugger,
    'DOM.getBoxModel',
    { backendNodeId },
  );
  // content quad：[x1,y1, x2,y2, x3,y3, x4,y4]
  const q = model.content;
  return {
    x: Math.round((q[0] + q[2] + q[4] + q[6]) / 4),
    y: Math.round((q[1] + q[3] + q[5] + q[7]) / 4),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
