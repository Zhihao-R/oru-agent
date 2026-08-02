/**
 * v0.6 MCP stderr 捕获 smoke——验证 spawn 失败时 lastStderr 含子进程 stderr 节选。
 *
 * 验证点：
 * 1. spawn 一个会立刻输出 stderr 并 exit code !== 0 的命令
 * 2. testServerConnection 返回 status=failed
 * 3. 返回的 lastStderr 字段包含期望的字符串
 *
 * 用 node -e 作为 stub：保证跨平台、立刻输出后退出。
 */
import './__smoke_isolate__';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function main() {
  const { testServerConnection, __resetForTest } = await import('../../electron/main/mcp/registry');
  const { updateSettings } = await import('../../electron/main/projects/store');

  __resetForTest();
  // 准备一个 cfg：node -e 输出 BOOM_MARKER 后立刻 exit 1
  // 写到 settings.mcpServers，testServerConnection 才能找到 cfg
  await updateSettings({
    mcpServers: [
      {
        id: 'stderr-stub',
        label: 'stderr stub',
        command: 'node',
        args: ['-e', "process.stderr.write('BOOM_MARKER\\n'); process.exit(1)"],
        enabled: false, // 不开机自启
      },
    ],
  });

  const state = await testServerConnection('stderr-stub');

  assert(state.status === 'failed', `status 应该是 failed，实际: ${state.status}`);
  assert(
    typeof state.lastStderr === 'string' && state.lastStderr.length > 0,
    `lastStderr 不为空，实际长度: ${state.lastStderr?.length ?? 0}`,
  );
  assert(
    (state.lastStderr ?? '').includes('BOOM_MARKER'),
    `lastStderr 应该含 'BOOM_MARKER'，实际: ${(state.lastStderr ?? '').slice(0, 200)}`,
  );

  // ─── 汇总 ───
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
