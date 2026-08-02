// PoC 透明承载窗探针（已验完 2026-06-21，结论回灌技术设计 §12；正式实现时转正或删除）——技术设计第 12 节风险 3 / 6。
// 由 index.ts 在 ORU_POC_OVERLAY=1 时于 app.whenReady 启动，before-quit 调 stop 收尾。
//
// 验两闸（§7 断点三的两个 macOS 坑）：
//   风险 3 透明窗键盘焦点：frameless+transparent+alwaysOnTop 窗浮在别 app 之上，输入框能否聚焦/打字，
//                          穿透模式下点击能否落到背后 app（setIgnoreMouseEvents forward）。
//   风险 6 原生全屏之上：setVisibleOnAllWorkspaces(visibleOnFullScreen) + level 'screen-saver'，
//                       别 app 独占全屏 Space 时 overlay 能否盖住。
//
// 操作：开窗后直接打字验聚焦；Cmd+Alt+P 切「可交互 ⇄ 穿透」验背后可点；Cmd+Alt+O 关窗。
// 验风险 6：把别的 app 用绿钮切原生全屏，看居中卡片还在不在最上层。

import { app, BrowserWindow, globalShortcut, screen } from 'electron';

let overlayWin: BrowserWindow | null = null;
let clickThrough = false;

// 内联页面：半透明遮罩 + 居中卡片 + 输入框 + 实时焦点/按键回显（纯前端，无需 preload/IPC）。
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;font-family:-apple-system,system-ui;background:rgba(0,0,0,.18)}
  .card{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);width:380px;padding:24px 28px;
    border-radius:16px;background:rgba(28,28,30,.92);color:#f5f5f7;box-shadow:0 12px 40px rgba(0,0,0,.45)}
  h1{font-size:15px;margin:0 0 14px;font-weight:600}
  input{width:100%;box-sizing:border-box;font-size:14px;padding:10px 12px;border-radius:10px;border:none;
    background:#3a3a3c;color:#fff;outline:2px solid #0a84ff}
  .row{margin-top:12px;font-size:12px;line-height:1.7;color:#aeaeb2}
  b{color:#30d158}
</style></head><body>
  <div class="card">
    <h1>👇 这是验证窗 · 请在下面打字</h1>
    <input id="t" placeholder="在这里打字——能输入即「透明置顶窗可聚焦」✓" autofocus>
    <div class="row">
      窗口焦点 document.hasFocus(): <b id="f">?</b> · 最后按键: <b id="k">（无）</b><br>
      ① 打字试聚焦　② Cmd+Alt+P 切穿透后点背后 app　③ 把别 app 绿钮全屏看本窗是否盖住<br>
      （Cmd+Alt+O 是关窗——验完再按，别误触）
    </div>
  </div>
  <script>
    const t=document.getElementById('t'),f=document.getElementById('f'),k=document.getElementById('k');
    t.focus();
    setInterval(()=>{f.textContent=document.hasFocus();},300);
    window.addEventListener('keydown',e=>{k.textContent=e.key;});
  </script>
</body></html>`;

export function startOverlayProbe(): void {
  if (overlayWin) return;
  // 覆盖光标所在 display 整屏（含菜单栏区，用 bounds 不用 workArea，验全屏遮盖）。
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.bounds;
  // ORU_POC_OVERLAY_PANEL=1 用 macOS NSPanel（type:'panel'）——验它能否进别 app 的原生全屏 Space（风险 6 解法）。
  const usePanel = process.env.ORU_POC_OVERLAY_PANEL === '1';
  console.log(
    `[poc.overlay] start — 覆盖 display id=${display.id} bounds=${JSON.stringify(display.bounds)} ` +
      `windowType=${usePanel ? 'panel(NSPanel)' : 'normal'}`,
  );

  overlayWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    ...(usePanel ? { type: 'panel' as const } : {}),
    webPreferences: { contextIsolation: true },
  });
  // level 'screen-saver' + visibleOnFullScreen：盖到别 app 的原生全屏 Space 之上（风险 6）。
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void overlayWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  // 聚焦放到内容加载完再做（loadURL 异步，过早 focus 无效）：moveTop + focus；steal 时先激活 app 再把 key 还给 overlay。
  overlayWin.webContents.once('did-finish-load', () => {
    if (!overlayWin) return;
    // 排除 dev 模式主窗 DevTools 抢 key window 的干扰（生产无 DevTools），否则聚焦实测不可信。
    BrowserWindow.getAllWindows().forEach((w) => {
      if (w !== overlayWin && w.webContents.isDevToolsOpened()) w.webContents.closeDevTools();
    });
    overlayWin.moveTop();
    overlayWin.focus();
    // 结论（2026-06-21）：steal 抢 app 前台会打断背后 app，已否决；正式做 native NSPanel
    // nonactivating + makeKeyAndOrderFront（技术设计 §7 / §12 风险 3）。下面 steal 分支仅留作代价对照。
    if (process.env.ORU_POC_FOCUS === 'steal') {
      app.focus({ steal: true });
      overlayWin.focus(); // steal 激活 app 后焦点可能落主窗/DevTools，再抢回 overlay
    }
    console.log(
      `[poc.overlay] did-finish-load → moveTop+focus${process.env.ORU_POC_FOCUS === 'steal' ? '+steal' : ''}，看卡片 hasFocus`,
    );
  });

  // Cmd+Alt+P 切可交互/穿透——穿透后窗内点不到，故用全局快捷键而非窗内按钮。
  globalShortcut.register('CommandOrControl+Alt+P', () => {
    clickThrough = !clickThrough;
    // forward:true：穿透时仍把 move 事件转给本窗，生产里据此在悬停输入框时动态切回可交互（§7）。
    overlayWin?.setIgnoreMouseEvents(clickThrough, { forward: true });
    if (!clickThrough) overlayWin?.focus();
    console.log(`[poc.overlay] clickThrough=${clickThrough}（${clickThrough ? '穿透:试点背后 app' : '可交互:试点/打字'}）`);
  });
  globalShortcut.register('CommandOrControl+Alt+O', () => stopOverlayProbe());
}

export function stopOverlayProbe(): void {
  if (!overlayWin) return; // 未启动则 no-op，保证 before-quit 无条件调用安全
  globalShortcut.unregister('CommandOrControl+Alt+P');
  globalShortcut.unregister('CommandOrControl+Alt+O');
  if (!overlayWin.isDestroyed()) overlayWin.close();
  overlayWin = null;
  clickThrough = false;
  console.log('[poc.overlay] stop — 窗关闭、快捷键注销');
}
