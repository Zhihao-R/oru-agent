// Electron 入口：跑 image_search 缩略图 smoke（feed-thumbs + 部分失败 + WebP 解码实证）。
// 用法：node_modules/.bin/electron tests/smoke/electron/imageThumbSmokeBootstrap.mjs
import { app } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from 'tsx/esm/api';

// 让 tsx 解析 @shared/* 路径别名（本 smoke 链路会经 selector→projects/store 命中 @shared 运行时导入）
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.TSX_TSCONFIG_PATH ??= join(repoRoot, 'tsconfig.node.json');

register();

app.whenReady().then(async () => {
  try {
    const { runImageThumbSmoke } = await import('./imageThumbSmoke.ts');
    await runImageThumbSmoke();
    app.exit(0);
  } catch (e) {
    console.error('[imageThumb smoke 失败]', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {});
