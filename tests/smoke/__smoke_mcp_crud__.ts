/**
 * v0.6 MCP CRUD smoke——验证 mcp.create / mcp.update / mcp.delete 三个新 RPC 关键路径：
 *
 * 1. create 不传 id，后端生成 serverId（slugify(label)）
 * 2. create 同 label 两次，第二次自动加 -2 后缀
 * 3. update 改 label 持久化到 settings
 * 4. update 改 enabled true → false 时 client 被 kill + tools 反注册
 * 5. update 改 enabled false → true 时 client 被 spawn（即使会失败也得尝试）
 * 6. delete 从 settings 移除 + 进程 kill
 * 7. delete 不存在的 id 返回 false
 *
 * 用 `echo` 作为 stub MCP command —— echo 不是 MCP server，spawn 后立刻退出，
 * handshake 会失败。这测的是 CRUD 的 settings/状态语义，不测 handshake-level 行为。
 */
import './__smoke_isolate__';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function main() {
  const {
    createServer,
    updateServer,
    deleteServer,
    __getClientForTest,
    __resetForTest,
  } = await import('../../electron/main/mcp/registry');
  const { getSettings, updateSettings } = await import('../../electron/main/projects/store');

  // 清空 mcp 状态，确保隔离
  __resetForTest();
  // 清空 settings.mcpServers（避免 preset chrome-devtools 干扰 slugify 冲突测试）
  await updateSettings({ mcpServers: [] });

  // ─── case 1: create 不传 id，后端生成 ───
  const cfg1 = await createServer({
    label: 'Test MCP',
    command: 'echo',
    args: ['hello'],
    enabled: false, // 不启动，避免真 spawn
  });
  assert(typeof cfg1.id === 'string' && cfg1.id.length > 0, 'create 返回带 id 的 cfg');
  assert(cfg1.id === 'test-mcp', `slugify('Test MCP') = 'test-mcp'，实际: ${cfg1.id}`);

  // 验证写入 settings
  const s1 = await getSettings();
  assert(
    (s1.mcpServers ?? []).some((s) => s.id === 'test-mcp'),
    'create 后 settings.mcpServers 含新 server',
  );

  // ─── case 2: 同 label 第二次，加 -2 后缀 ───
  const cfg2 = await createServer({
    label: 'Test MCP',
    command: 'echo',
    args: ['world'],
    enabled: false,
  });
  assert(cfg2.id === 'test-mcp-2', `同 label 第二次 id 应该是 'test-mcp-2'，实际: ${cfg2.id}`);

  // ─── case 3: update 改 label 持久化 ───
  const u1 = await updateServer(cfg1.id, { label: 'Renamed' });
  assert(u1?.label === 'Renamed', 'update 后内存里的 label 是新值');
  const s2 = await getSettings();
  const fromSettings = (s2.mcpServers ?? []).find((s) => s.id === cfg1.id);
  assert(fromSettings?.label === 'Renamed', 'update 后 settings.mcpServers 持久化新 label');
  assert(fromSettings?.id === cfg1.id, 'update 不改 id');

  // ─── case 4: update 改 enabled false → true → 触发 startServer（会失败但应尝试） ───
  // 用一个绝对会失败的 command 让 spawn 立即报错，验证 enabled=true 触发 start
  await updateServer(cfg1.id, { command: '/this/path/does/not/exist' });
  const u2 = await updateServer(cfg1.id, { enabled: true });
  assert(u2?.enabled === true, 'update enabled=true 持久化');
  // restart 后 client 应该在 registry 里（即使 status=failed）
  // 注意：startServer 失败时 client 仍留在 clients map（带 failed 状态）
  // start 抛错后 client 留在 map 里（带 failed 状态），settings UI 仍能看到错误
  const client1 = __getClientForTest(cfg1.id);
  assert(
    client1 !== undefined && client1.status === 'failed',
    `update enabled=true 后 client 存在且 status=failed，实际: ${client1?.status}`,
  );

  // ─── case 5: update 改 enabled true → false → 触发 stopServer ───
  await updateServer(cfg1.id, { enabled: false });
  // stopServer 会从 clients map 移除
  const client2 = __getClientForTest(cfg1.id);
  assert(client2 === undefined, 'update enabled=false 后 client 从 registry 移除');

  // ─── case 6: delete 从 settings 移除 ───
  const del1 = await deleteServer(cfg1.id);
  assert(del1 === true, 'delete 已存在的 server 返回 true');
  const s3 = await getSettings();
  assert(
    !(s3.mcpServers ?? []).some((s) => s.id === cfg1.id),
    'delete 后 settings.mcpServers 不再含此 id',
  );

  // ─── case 7: delete 不存在的 id 返回 false ───
  const del2 = await deleteServer('nonexistent-server-id');
  assert(del2 === false, 'delete 不存在的 server 返回 false');

  // 清理剩余测试数据
  await deleteServer(cfg2.id).catch(() => {});

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
