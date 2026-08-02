/**
 * 唤起对话的全局触发（技术设计 §3）+ 窗口内/全屏分流（§8「必须钉死」/ §12 风险 10）。
 *
 * uiohook passive monitor（不消费事件，§3「放行不拦截」）抓「触发修饰键 + 左键按下」，
 * 拿 DIP 全局坐标（PoC 实测即 screen 同系，§4）。命中后做 window-at-point 分流：
 * - 命中 Oru 自己的窗 → 全局路径放手，交窗内老路（前端 useAsideAltClick，有 DOM 更准）；
 * - 命中别 app / 桌面 → 走全屏路径，emit onScreenClick（上层据此截屏 + 出承载窗）。
 *
 * 分流绝不能用「坐标是否落在主窗 bounds 内」：主窗被遮挡时坐标在框内但点其实落在上层 app，
 * 判「窗内」交给收不到事件的老路 → 点了没反应（§8）。靠 native hit-test 取「该点最上层窗归属」。
 * native 缺席（addon 未构建）时降级用 active-win frontmost——偏保守、边界会错，仅 dev 兜底。
 *
 * 已知坑（PoC §12）：合成点击 uiohook 收不到，只认真实硬件事件——自动化测不了触发，须真机手点。
 */
import { BrowserWindow } from 'electron';
import { uIOhook, type UiohookMouseEvent } from 'uiohook-napi';
import activeWindow from 'active-win';
import { loadNativeDesktop, type WindowOwner } from './nativeDesktop';
import type { GlobalPoint } from './screenCapture';

/** 触发修饰键（可配，§3/§11；默认 ⌥）——个别 app 有 ⌥ 含义时用户改键 */
export type TriggerModifier = 'alt' | 'ctrl' | 'meta' | 'shift';
const MOD_FLAG: Record<TriggerModifier, keyof UiohookMouseEvent> = {
  alt: 'altKey',
  ctrl: 'ctrlKey',
  meta: 'metaKey',
  shift: 'shiftKey',
};
/** uiohook 鼠标按键编码：左=1 */
const MOUSE_LEFT = 1;

/**
 * 命中别 app/桌面的全屏触发：DIP 全局点 + 该点窗口归属的 app 名（无窗/取不到则缺省）
 * + 触发那刻的前台 app pid（关浮层后切回它，「弹出即打字」收尾，§7 用户已定）。
 */
export type ScreenTrigger = { point: GlobalPoint; app?: string; restorePid?: number };

/**
 * 分流裁决（纯函数，承重）：该点命中窗归属 owner + Oru 自己的窗 pid 集合 → 走哪条路。
 * 命中 Oru 窗 → 'in-window'（全局路径放手）；命中别 app / 桌面空白(owner=null) → 'screen'。
 */
export function classifyClick(
  owner: WindowOwner | null,
  oruPids: ReadonlySet<number>,
): 'in-window' | 'screen' {
  if (owner && oruPids.has(owner.pid)) return 'in-window';
  return 'screen';
}

let started = false;
let onMouseDown: ((e: UiohookMouseEvent) => void) | null = null;

/**
 * 启动全局触发监听。onScreenClick 仅在分流判为 'screen' 时回调；oruPids() 每次现取
 * （主进程 pid 即 Electron 各窗 NSWindow 的 owner pid）。返回成对的停止函数（注册/注销同处可见）。
 * 不在此做截屏在途的互斥/last-wins——监听只判定+emit，连点节流交持有异步生命周期的编排层（desktop/index.ts）。
 */
export function startGlobalTrigger(opts: {
  modifier: TriggerModifier;
  oruPids: () => ReadonlySet<number>;
  onScreenClick: (t: ScreenTrigger) => void;
}): () => void {
  if (started) return stopGlobalTrigger;
  const flag = MOD_FLAG[opts.modifier];

  onMouseDown = (e: UiohookMouseEvent) => {
    if (!e[flag] || e.button !== MOUSE_LEFT) return; // 非触发组合 → 放行不碰
    const point: GlobalPoint = { x: e.x, y: e.y };
    const owner = resolveOwnerAtPoint(point);
    if (classifyClick(owner, opts.oruPids()) === 'in-window') return; // 窗内老路接手
    // 前台 app（active-win frontmost）：取 pid 作关浮层后的回切目标，取 name 作 app 名兜底（native owner 缺时）
    const front = frontmostApp();
    opts.onScreenClick({ point, app: owner?.app ?? front?.name, restorePid: front?.pid });
  };

  uIOhook.on('mousedown', onMouseDown);
  uIOhook.start();
  started = true;
  return stopGlobalTrigger;
}

/**
 * window-at-point 归属：优先 native hit-test（真该点最上层窗）。
 * native 缺席（dev 未构建 addon）时退化：若点落在「当前聚焦的 Oru 窗」bounds 内 → 判为 Oru。
 * 这条 bounds 兜底只在「Oru 被聚焦」时生效——Oru 被别 app 遮挡时它不聚焦、不会误判窗内（正是 §8
 * 担心的遮挡场景，focus 门控挡掉了），故不与 §8「不能用 bounds 矩形」冲突；它只解 dev 无 addon 时
 * 「点聚焦中的 Oru 自己也走全屏 → 窗内+窗外双触发」。仍取不到则返回 null（分流走全屏）。
 */
function resolveOwnerAtPoint(p: GlobalPoint): WindowOwner | null {
  const native = loadNativeDesktop();
  if (native) {
    try {
      return native.windowOwnerAtPoint(p.x, p.y);
    } catch (e) {
      console.warn('[desktop.trigger] hit-test 失败:', e instanceof Error ? e.message : e);
    }
  }
  return focusedOruOwner(p);
}

/** dev 兜底：点落在聚焦中的 Oru 窗 bounds 内 → 归属 Oru（pid = 主进程）；否则 null */
function focusedOruOwner(p: GlobalPoint): WindowOwner | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused) return null;
  const b = focused.getBounds();
  const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  return inside ? { pid: process.pid, app: 'Oru' } : null;
}

/** 前台 app（active-win frontmost）：name 作 app 名兜底（native owner 缺时）、pid 作关浮层后的回切目标 */
function frontmostApp(): { name: string; pid: number } | undefined {
  try {
    const win = activeWindow.sync({ accessibilityPermission: true, screenRecordingPermission: false });
    return win ? { name: win.owner.name, pid: win.owner.processId } : undefined;
  } catch {
    return undefined;
  }
}

export function stopGlobalTrigger(): void {
  if (!started) return; // 未启动 no-op，保证无条件调用安全
  if (onMouseDown) uIOhook.removeListener('mousedown', onMouseDown);
  uIOhook.stop();
  onMouseDown = null;
  started = false;
}
