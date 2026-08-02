// 编译唤起对话的 native addon（desktop_native）——必须按 Electron 的 ABI 编，不是系统 node。
// 用法：npm run build:native（先装好 node-addon-api / node-gyp）。CI / 打包前置。
//
// 产物落在 addon 自己的 build/Release/desktop_native.node——nativeDesktop.ts 的 addonPath() 直接从那里
// 解析（dev）。刻意不复制到 out/main：electron-vite 每次 build/dev 都重建 out/ 会把它冲掉。
// prod 打包由 electron-builder 经 package.json build.mac.extraResources 拷到 resources/。
//
// 已知坑（§12）：重签 Electron 重置 TCC 权限要重授；输入监控授权后须重启 app 生效；
// 硬化运行时要 entitlement disable-library-validation（见 build/entitlements.mac.plist）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('[buildNative] 非 macOS，跳过（唤起对话一期只做 mac）');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const addonDir = join(root, 'electron/native/desktop');
const electronVersion = require(join(root, 'node_modules/electron/package.json')).version;

console.log(`[buildNative] 按 Electron ${electronVersion} (${process.arch}) ABI 编译 desktop_native…`);
const nodeGyp = join(root, 'node_modules/.bin/node-gyp');
const r = spawnSync(
  nodeGyp,
  [
    'rebuild',
    `--target=${electronVersion}`,
    `--arch=${process.arch}`,
    '--dist-url=https://electronjs.org/headers',
  ],
  { cwd: addonDir, stdio: 'inherit' },
);
if (r.status !== 0) {
  console.error('[buildNative] node-gyp 失败（先 npm i node-addon-api node-gyp，并确认 Xcode CLT 已装）');
  process.exit(r.status ?? 1);
}

const built = join(addonDir, 'build/Release/desktop_native.node');
if (!existsSync(built)) {
  console.error(`[buildNative] 找不到产物 ${built}`);
  process.exit(1);
}
console.log(`[buildNative] ✓ 产物 ${built}（dev 直接从此解析；prod 打包经 extraResources 拷到 resources/）`);
