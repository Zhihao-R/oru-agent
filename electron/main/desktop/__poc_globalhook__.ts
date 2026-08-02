// PoC 多闸验证探针（已验完 2026-06-21，结论回灌技术设计 §12；正式实现时转正或删除）——技术设计第 12 节剩余风险闸。
// 跑在真 Electron 主进程里才作数：独立 node 脚本测不到 ABI / 系统坐标 / desktopCapturer。
// 由 index.ts 在 ORU_POC_GLOBALHOOK=1 时于 app.whenReady 启动，before-quit 调 stop 收尾。
//
// 一次 ⌥+左键命中跑完这几闸的「可自动采集」部分，结果打印到控制台 + 落盘 /tmp/oru_poc_*：
//   风险 2 坐标对齐：uiohook(e.x,e.y) 对照 Electron screen.getCursorScreenPoint()（DIP 黄金参照）
//                    → 定单位/原点 → getDisplayNearestPoint 定屏 → desktopCapturer 按 display_id
//                    显式匹配 → 核对帧尺寸 = size×scaleFactor → 算物理像素坐标 → crop 落点周围落盘肉眼核对。
//   风险 4 截图性能：抓帧 / 下采样(长边 1568) / JPEG 编码 各段计时，判落在「几秒内」。
//   风险 10 分流裁决：active-win.sync 取 frontmost 窗 + bounds，实测它在「Oru 被遮挡」时返回什么，
//                    坐实 uiohook+active-win 是否提供 window-at-point（不提供则需补 CGWindowList）。
//   风险 8 能耗：start 后每 5s 打印进程 cpuUsage 增量，挂一段观察常驻占用。
//
// 不在本探针：风险 3 透明窗键盘焦点 / 风险 6 全屏 Space 之上（需独立 overlay 承载窗 + 真机交互，第二波）。
//
// 已知坑（PoC 实测）：合成点击 uiohook 收不到，只认真实硬件事件——必须真机手点触发。

import { uIOhook, type UiohookMouseEvent } from 'uiohook-napi';
import activeWindow from 'active-win';
import { desktopCapturer, screen } from 'electron';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// uiohook 鼠标按键编码：左=1 右=2 中=3。
const MOUSE_LEFT = 1;
// 下采样目标长边（评点视觉模型可接受量级）——风险 4 的「体量压缩」步，与 DPR 归一不同目标。
const DOWNSAMPLE_LONG_EDGE = 1568;

// 触发修饰键可配（验「命中判定是数据、能换键」）：ORU_POC_MOD = alt(默认) | ctrl | meta | shift。
type ModName = 'alt' | 'ctrl' | 'meta' | 'shift';
const MOD_FLAG: Record<ModName, keyof UiohookMouseEvent> = {
  alt: 'altKey',
  ctrl: 'ctrlKey',
  meta: 'metaKey',
  shift: 'shiftKey',
};

function resolveMod(): ModName {
  const raw = (process.env.ORU_POC_MOD ?? 'alt').toLowerCase();
  return (raw in MOD_FLAG ? raw : 'alt') as ModName;
}

let started = false;
let onMouseDown: ((e: UiohookMouseEvent) => void) | null = null;
let energyTimer: NodeJS.Timeout | null = null;
let selftestTimer: NodeJS.Timeout | null = null;
let running = false; // 单轮采集互斥：连点只认「当前没在跑」的那次，避免截图重入
let hitSeq = 0;

// 触发一轮采集。raw=真实 uiohook 事件（手点命中）时跑全闸；raw=null（自检）时跳过
// 「uiohook 坐标对照」段（无真硬件坐标），仅验截图 + 坐标数学链路——不依赖鼠标点击即可自验权限是否真过。
function triggerCollect(label: string, raw: UiohookMouseEvent | null): void {
  if (running) {
    console.log('[poc.gate] 上一轮采集未结束，忽略本次触发');
    return;
  }
  // 命中瞬间同步抓黄金参照，绝不能等到 async 之后（鼠标会移动 / 前台会变）：
  //   golden = Electron 全局光标坐标（保证 DIP、左上原点），作 uiohook 坐标的对照标尺。
  const golden = screen.getCursorScreenPoint();
  let front: { name: string; bounds: { x: number; y: number; width: number; height: number } } | null = null;
  try {
    // accessibilityPermission:true 才拿得到 frontmost owner/bounds（风险 10 要的）；
    // screenRecordingPermission:false 只要 app 名、不要窗口标题，避开额外录屏弹窗。
    const win = activeWindow.sync({ accessibilityPermission: true, screenRecordingPermission: false });
    if (win) front = { name: win.owner.name, bounds: win.bounds };
  } catch (err) {
    console.warn('[poc.gate] active-win 取 frontmost 失败:', (err as Error).message);
  }
  running = true;
  const seq = ++hitSeq;
  void runGates(seq, label, raw, golden, front).finally(() => {
    running = false;
  });
}

export function startGlobalHookProbe(): void {
  if (started) return;
  const mod = resolveMod();
  const flag = MOD_FLAG[mod];
  console.log(`[poc.gate] start — trigger = ${mod}+left（改 ORU_POC_MOD 验修饰键可配）`);

  onMouseDown = (e: UiohookMouseEvent) => {
    // 命中判定：触发修饰键 + 左键。其余放过——passive monitor，不消费事件。
    if (!e[flag] || e.button !== MOUSE_LEFT) return;
    triggerCollect(mod, e);
  };

  uIOhook.on('mousedown', onMouseDown);
  uIOhook.start();
  started = true;

  // 自检（ORU_POC_SELFTEST=1）：启动 2.5s 后用当前光标位置自动跑一轮 gate2/4，不依赖手点——
  // 验「权限真过 + 截图链路通 + 坐标数学对」。把光标先放到某个明确小目标上再启动，crop 图就能肉眼核落点。
  if (process.env.ORU_POC_SELFTEST === '1') {
    console.log('[poc.gate] SELFTEST 开：2.5s 后用当前光标位置自动采一轮（把光标放到要核对的目标上）');
    selftestTimer = setTimeout(() => triggerCollect('selftest', null), 2500);
  }

  // 风险 8：常驻监听能耗采样。基线归零，每 5s 打印自上次的 CPU 增量（user+system，微秒）。
  let last = process.cpuUsage();
  energyTimer = setInterval(() => {
    const d = process.cpuUsage(last);
    last = process.cpuUsage();
    const pct = ((d.user + d.system) / 1e6 / 5) * 100; // 占满单核百分比近似
    console.log(`[poc.gate.energy] 近 5s CPU ≈ ${pct.toFixed(2)}% 单核（user=${d.user}us sys=${d.system}us）`);
  }, 5000);
}

async function runGates(
  seq: number,
  label: string,
  raw: UiohookMouseEvent | null,
  golden: { x: number; y: number },
  front: { name: string; bounds: { x: number; y: number; width: number; height: number } } | null,
): Promise<void> {
  console.log(`\n===== [poc.gate] HIT #${seq} (${label}) =====`);

  // ---- 风险 2：坐标对齐 ----------------------------------------------------
  console.log(`[gate2] Electron getCursorScreenPoint (DIP,左上原点) = (${golden.x}, ${golden.y})`);
  if (raw) {
    // 第一步（最易塌）：uiohook 坐标 vs Electron DIP 黄金参照，定单位与原点。
    console.log(`[gate2] uiohook 原始 (e.x,e.y) = (${raw.x}, ${raw.y})`);
    console.log(
      `[gate2] 比值 x=${(raw.x / golden.x).toFixed(3)} y=${(raw.y / golden.y).toFixed(3)} ` +
        `（≈1 则 uiohook 也是 DIP/左上；≈scaleFactor 则 uiohook 是物理像素；y 为负则原点翻转）`,
    );
  } else {
    console.log('[gate2] 自检轮：无真实 uiohook 坐标，跳过单位对照，仅验截图 + 坐标数学（以 golden 为权威点）');
  }

  // 定屏：用 DIP 全局点定位 display（uiohook 若是物理像素，此处该用归一后的 DIP——下方按比值判定后取 golden 作权威）。
  const display = screen.getDisplayNearestPoint(golden);
  console.log(
    `[gate2] 命中 display id=${display.id} scaleFactor=${display.scaleFactor} ` +
      `bounds=${JSON.stringify(display.bounds)} size=${JSON.stringify(display.size)}`,
  );

  // 抓该屏整帧（desktopCapturer 按 display_id 显式匹配，不能用数组下标）。
  const tCapStart = performanceNow();
  const physW = Math.round(display.size.width * display.scaleFactor);
  const physH = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: physW, height: physH },
  });
  const tCapEnd = performanceNow();
  const match = sources.find((s) => s.display_id === String(display.id));
  if (!match) {
    console.warn(
      `[gate2] ✗ desktopCapturer 没有 display_id=${display.id} 的源；现有=${sources
        .map((s) => `${s.name}:${s.display_id}`)
        .join(', ')}（屏幕录制权限未授 → 源列表为空/无名）`,
    );
    return;
  }
  const frame = match.thumbnail;
  const fsize = frame.getSize();
  console.log(
    `[gate2] 帧尺寸=${fsize.width}x${fsize.height}  期望(size×scaleFactor)=${physW}x${physH}  ` +
      `${fsize.width === physW && fsize.height === physH ? '✓ 对齐' : '✗ 不对齐（坐标会错位）'}`,
  );

  // 算位图物理像素坐标：(DIP全局点 − display.bounds.origin) × scaleFactor。
  const bmpX = Math.round((golden.x - display.bounds.x) * display.scaleFactor);
  const bmpY = Math.round((golden.y - display.bounds.y) * display.scaleFactor);
  console.log(`[gate2] 落点物理像素 = (${bmpX}, ${bmpY})`);
  // crop 落点周围 240px 落盘，肉眼核对「圈是否真套在点的东西上」。
  const half = 120;
  const cropX = Math.max(0, Math.min(bmpX - half, fsize.width - 2 * half));
  const cropY = Math.max(0, Math.min(bmpY - half, fsize.height - 2 * half));
  const crop = frame.crop({ x: cropX, y: cropY, width: 2 * half, height: 2 * half });
  const cropPath = join(tmpdir(), `oru_poc_gate2_hit${seq}_crop.png`);
  await writeFile(cropPath, crop.toPNG());
  console.log(`[gate2] 落点周围 240px 已落盘核对落点 → ${cropPath}`);

  // ---- 风险 4：截图性能 ----------------------------------------------------
  const tDsStart = performanceNow();
  const long = Math.max(fsize.width, fsize.height);
  const scale = long > DOWNSAMPLE_LONG_EDGE ? DOWNSAMPLE_LONG_EDGE / long : 1;
  const small = frame.resize({ width: Math.round(fsize.width * scale), height: Math.round(fsize.height * scale) });
  const tDsEnd = performanceNow();
  const jpeg = small.toJPEG(80);
  const tEncEnd = performanceNow();
  const fullPath = join(tmpdir(), `oru_poc_gate4_hit${seq}_downsampled.jpg`);
  await writeFile(fullPath, jpeg);
  console.log(
    `[gate4] 抓帧=${(tCapEnd - tCapStart).toFixed(0)}ms  下采样=${(tDsEnd - tDsStart).toFixed(0)}ms  ` +
      `JPEG编码=${(tEncEnd - tDsEnd).toFixed(0)}ms  合计≈${(tEncEnd - tCapStart).toFixed(0)}ms  ` +
      `下采样后=${small.getSize().width}x${small.getSize().height} ${(jpeg.length / 1024).toFixed(0)}KB → ${fullPath}`,
  );

  // ---- 风险 10：分流裁决 ---------------------------------------------------
  if (front) {
    const inBounds =
      golden.x >= front.bounds.x &&
      golden.x < front.bounds.x + front.bounds.width &&
      golden.y >= front.bounds.y &&
      golden.y < front.bounds.y + front.bounds.height;
    console.log(
      `[gate10] active-win frontmost = "${front.name}" bounds=${JSON.stringify(front.bounds)}  ` +
        `点是否落在 frontmost bounds 内=${inBounds}`,
    );
    console.log(
      `[gate10] ⚠ active-win 只给「最前台窗」非「该点命中的最上层窗」。` +
        `验缺口：把 Oru 主窗放别 app 之下被遮挡，再 ⌥+左键点遮挡区——若这里 frontmost 仍报别 app、` +
        `或 bounds 判定与肉眼归属不符，即坐实需补 CGWindowListCopyWindowInfo 做 window-at-point。`,
    );
  } else {
    console.log('[gate10] active-win 无返回（辅助功能权限未授？）——window-at-point 缺口待补');
  }
  console.log(`===== [poc.gate] HIT #${seq} done =====\n`);
}

// 主进程无 performance.now 保证可用时的小兜底（Electron 主进程有 global performance，但探针独立不假设）。
function performanceNow(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

export function stopGlobalHookProbe(): void {
  if (!started) return; // 未启动则 no-op，保证 before-quit 无条件调用安全
  if (energyTimer) clearInterval(energyTimer);
  if (selftestTimer) clearTimeout(selftestTimer);
  if (onMouseDown) uIOhook.removeListener('mousedown', onMouseDown);
  uIOhook.stop();
  energyTimer = null;
  selftestTimer = null;
  onMouseDown = null;
  started = false;
  console.log('[poc.gate] stop — listener removed, hook stopped, energy timer cleared');
}
