// Electron 入口：在 app ready 后跑 deck 校验器 detect smoke（需真实 BrowserWindow 渲染量度）。
// 用法：node_modules/.bin/electron tests/smoke/electron/deckValidateBootstrap.mjs
import { app } from 'electron';
import { register } from 'tsx/esm/api';

register();

app.whenReady().then(async () => {
  try {
    const { runDeckValidateSmoke } = await import('./deckValidateSmoke.ts');
    await runDeckValidateSmoke();
    app.exit(0);
  } catch (e) {
    console.error('[deck validate smoke 失败]', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {}); // 别因离屏窗口销毁自动退出
