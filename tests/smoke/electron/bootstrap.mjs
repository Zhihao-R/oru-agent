// Electron 入口：注册 tsx loader 跑 TS smoke，在 app ready 后调渲染原语。
// 用法：node_modules/.bin/electron tests/smoke/electron/bootstrap.mjs
import { app } from 'electron';
import { register } from 'tsx/esm/api';

register();

app.whenReady().then(async () => {
  try {
    const { runRenderSmoke } = await import('./renderSmoke.ts');
    await runRenderSmoke();
    app.exit(0);
  } catch (e) {
    console.error('[render smoke 失败]', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {}); // 别因离屏窗口销毁自动退出
