import { app } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from 'tsx/esm/api';

// 让 tsx 解析 @shared/* 路径别名（dream 链路经 claudeCode 命中 @shared/agent 运行时导入）。
// 对齐 imageThumbSmokeBootstrap.mjs：register() 前先指好 tsconfig，否则 @shared 解析不了。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.TSX_TSCONFIG_PATH ??= join(repoRoot, 'tsconfig.node.json');

// safeStorage 的 macOS 钥匙串条目名是 `<app.name> Safe Storage`——裸跑 electron 时 app.name
// 是 'Electron'，取不到正式应用（name=oru）那条，config.json 里的 oru-enc 密钥就解不开、
// 后端 isReady 直接报「缺少 API Key」。必须在 whenReady 之前对齐名字。
app.setName('oru');
register();
app.whenReady().then(async()=>{ try{ const {run}=await import('../__dream_real_oneoff__.ts'); await run(); app.exit(0);}catch(e){console.error('[fail]',e&&e.stack?e.stack:e); app.exit(1);} });
app.on('window-all-closed',()=>{});
