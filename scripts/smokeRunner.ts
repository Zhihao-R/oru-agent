/**
 * Smoke runner: glob 自动发现 tests/smoke/__smoke_*__.ts（tsx 跑）+
 * tests/smoke/electron/*ootstrap.mjs（electron 跑），串行执行。
 *
 * 用法：
 *   npm run smoke:all                              # 跑全部（含 electron 渲染 smoke）
 *   npm run smoke:all -- '__smoke_chat__.ts'       # 跑单个（pattern；不带 electron 阶段）
 *   npm run smoke:all -- '__smoke_taskboard*'      # 跑一组
 *
 * 不需要额外装 glob —— node:fs 自带 globSync。
 */
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const explicitPattern = process.argv[2];
const pattern = explicitPattern ?? '__smoke_*__.ts';

// electron 渲染 smoke 需要 electron 二进制（非 tsx），仅全量运行时纳入——
// 否则 smoke:all 给"全测了"的错觉却漏跑 deck 渲染回归（审计 T3）。
// 排除 dreamBootstrap：它是手动真机一次性诊断（__dream_real_oneoff__），要求 ORU_DIR 指向真实
// ~/.oru + 配好的真 LLM 后端，且会真跑 dream 改写真实用户 profile——自动化沙箱里恒失败、也不该
// 在 CI 动用户真实记忆数据。自动化 dream 走已 mock 的 __smoke_dream__.ts；本工具留作手动按需跑。
const MANUAL_ONLY = new Set(['dreamBootstrap.mjs']);
// 真打 LLM 的记忆 smoke（tsx 侧同理）：单次几分钟到半小时、烧 token、结论需人判，
// 卷进 smoke:all 只会拖慢全量并产生没人读的报告；按需 npm run smoke:xxx 单独跑。
// 显式 pattern 点名时不排除（files 已被 pattern 过滤）。
const MANUAL_ONLY_TSX = new Set([
  '__smoke_dream__.ts',
  '__smoke_capture__.ts',
  '__smoke_memory_scale__.ts',
  '__smoke_memory_chain__.ts',
]);
const files = globSync(`tests/smoke/${pattern}`)
  .filter((f) => explicitPattern !== undefined || !MANUAL_ONLY_TSX.has(f.split('/').pop() ?? f))
  .sort();
const electronFiles = explicitPattern
  ? []
  : globSync('tests/smoke/electron/*ootstrap.mjs')
      .filter((f) => !MANUAL_ONLY.has(f.split('/').pop() ?? f))
      .sort();

if (files.length === 0 && electronFiles.length === 0) {
  console.error(`No smoke files matched: tests/smoke/${pattern}`);
  process.exit(1);
}

const total = files.length + electronFiles.length;
console.log(`Running ${files.length} tsx + ${electronFiles.length} electron smoke file(s):\n`);

let failed = 0;
const failedList: string[] = [];

function runOne(f: string, cmd: string, cmdArgs: string[], extraEnv?: NodeJS.ProcessEnv): void {
  const start = Date.now();
  console.log(`▶ ${f}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  const ms = Date.now() - start;
  if (r.status !== 0 || r.error) {
    failed++;
    failedList.push(f);
    // status=null 时是 spawn 失败（二进制缺失）或被信号杀——不带原因 CI 里没法排障
    const reason = r.error?.message ?? (r.signal ? `signal ${r.signal}` : `exit ${r.status}`);
    console.error(`✗ ${f} (${ms}ms) — ${reason}\n`);
  } else {
    console.log(`✓ ${f} (${ms}ms)\n`);
  }
}

// tsx 经纯 Node 跑：经 NODE_OPTIONS 注入 electron stub 的 resolve hook（用 env 而非 tsx 参数——
// tsx 见到 --import 会把后续 --tsconfig 漏给 node），让静态 import { app } from 'electron' 的主进程
// 模块加载得动（否则整条 smoke 链 SyntaxError 崩）。详见 tests/smoke/_electronStub/。
// 仅 tsx smoke 注入；electron bootstrap 跑真实 electron，不能给 stub。
const electronStubRegister = pathToFileURL(resolve('tests/smoke/_electronStub/register.mjs')).href;
const tsxEnv: NodeJS.ProcessEnv = {
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${electronStubRegister}`.trim(),
};
for (const f of files) {
  runOne(f, 'npx', ['tsx', '--tsconfig', 'tsconfig.node.json', resolve(f)], tsxEnv);
}
for (const f of electronFiles) {
  runOne(f, 'npx', ['electron', resolve(f)]);
}

console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) {
  console.log('Failed:');
  for (const f of failedList) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
