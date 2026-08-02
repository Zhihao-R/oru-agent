/**
 * Devstart smoke — 真实 ~/.oru 启动健康检查
 *
 * 这是测试体系里**唯一**一个不走 ORU_DIR 隔离、直接用真实 ~/.oru 的 smoke。
 *
 * 目的：验证 dev 模式启动路径在改了底层（migrate / store / engine 等）后仍能跑通：
 *  - migrate 函数（legacy + user-scoped）不抛错
 *  - ensureDefaultAgent 能加载真实数据（或首次幂等创建）；createSubConversation 能建新对话
 *  - listProjects / listConversations 能读出真实数据
 *  - ws server 能起来 + 关闭
 *
 * 幂等不污染：不发任何 chat 消息、不创建项目、不会写老用户已有的 CLAUDE.md（首次启动会幂等创建初始 Twin home，跟 dev 模式首次启动行为一致）。
 *
 * 用法：npm run smoke:devstart
 */
import { startWsServer, stopWsServer } from '../../electron/main/ws/server';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { createSubConversation, listConversations } from '../../electron/main/conversations/store';
import { listProjects } from '../../electron/main/projects/store';
import { migrateLegacySessions, migrateToUserScopedLayout } from '../../electron/main/migrate';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function main(): Promise<void> {
  console.log('=== devstart smoke (真实 ~/.oru) ===');

  // 1. migrate 应幂等无害
  try {
    await migrateLegacySessions();
    assert(true, 'migrateLegacySessions 不抛');
  } catch (e) {
    assert(false, 'migrateLegacySessions 不抛', e instanceof Error ? e.message : String(e));
  }
  try {
    await migrateToUserScopedLayout();
    assert(true, 'migrateToUserScopedLayout 不抛');
  } catch (e) {
    assert(false, 'migrateToUserScopedLayout 不抛', e instanceof Error ? e.message : String(e));
  }

  // 2. agents / conversations store 能加载（或首次幂等创建）
  let agentId = '';
  try {
    const agent = await ensureDefaultAgent();
    agentId = agent.id;
    assert(!!agent.id && !!agent.ownerId && !!agent.homePath, 'ensureDefaultAgent 返回完整 agent', `id=${agent.id} owner=${agent.ownerId}`);
  } catch (e) {
    assert(false, 'ensureDefaultAgent 不抛', e instanceof Error ? e.message : String(e));
  }
  try {
    const conv = await createSubConversation(agentId, '新对话');
    assert(!!conv.id && conv.kind === 'sub' && !!conv.ownerId, 'createSubConversation 返回新建 sub 对话', conv.id);
  } catch (e) {
    assert(false, 'createSubConversation 不抛', e instanceof Error ? e.message : String(e));
  }

  // 3. readonly 列表查询
  try {
    const { projects } = await listProjects();
    assert(Array.isArray(projects), 'listProjects 返回数组', `数量=${projects.length}`);
    // 所有项目都应带 ownerId
    const allHaveOwner = projects.every((p) => typeof p.ownerId === 'string' && p.ownerId.length > 0);
    assert(allHaveOwner, '所有项目带 ownerId');
  } catch (e) {
    assert(false, 'listProjects 不抛', e instanceof Error ? e.message : String(e));
  }
  try {
    const convs = await listConversations(agentId);
    assert(Array.isArray(convs) && convs.length >= 1, 'listConversations 返回数组（至少含刚建的对话）', `数量=${convs.length}`);
    const allHaveOwner = convs.every((c) => typeof c.ownerId === 'string' && c.ownerId.length > 0);
    assert(allHaveOwner, '所有对话带 ownerId');
  } catch (e) {
    assert(false, 'listConversations 不抛', e instanceof Error ? e.message : String(e));
  }

  // 4. ws server 能起来和关掉
  try {
    const port = await startWsServer();
    assert(typeof port === 'number' && port > 0, 'ws server 启动返回有效 port', String(port));
    stopWsServer();
    assert(true, 'ws server 干净关闭');
  } catch (e) {
    assert(false, 'ws server 起停', e instanceof Error ? e.message : String(e));
  }

  const total = RESULTS.length;
  const pass = RESULTS.filter((r) => r.ok).length;
  const fail = total - pass;
  console.log('---');
  console.log(`total: ${total}, pass: ${pass}, fail: ${fail}`);
  console.log(fail === 0 ? 'ALL PASS' : 'FAIL');
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[devstart smoke] 未捕获异常：', e);
  process.exit(1);
});
