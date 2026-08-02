// Electron 入口：在 app ready 后跑联系表 fidelity smoke。
// 用法：node_modules/.bin/electron tests/smoke/electron/contactSheetBootstrap.mjs
import { app } from 'electron';
import { register } from 'tsx/esm/api';

register();

app.whenReady().then(async () => {
  try {
    const { runContactSheetSmoke } = await import('./contactSheetSmoke.ts');
    await runContactSheetSmoke();
    app.exit(0);
  } catch (e) {
    console.error('[contact sheet smoke 失败]', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {}); // 别因离屏窗口销毁自动退出
