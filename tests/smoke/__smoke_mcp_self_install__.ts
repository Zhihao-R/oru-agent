/**
 * v0.6 Oru 自装 MCP smoke：验证 mcp_install / runProposalStandalone 关键路径。
 *
 * 1. mcp_install tool 调用 → ctx.onProposal 收到 McpInstallProposal（含 kind 和 status）
 * 2. tool 返回的 text 符合审批门状态（开 = 已递交；关 = 已自动执行）
 * 3. runProposalStandalone 成功路径：proposal.status = 'executed' + broadcast statusChanged
 * 4. runProposalStandalone 失败路径：proposal.status = 'failed' + failureMessage 非空
 * 5. mcp_inspect 返回 envKeys 含 key 但不含 value
 */
import './__smoke_isolate__';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function main() {
  const {
    makeMcpInstallTool,
    makeMcpInspectTool,
    makeMcpListTool,
  } = await import('../../electron/main/agent/agentTools/mcp');
  const { runProposalStandalone } = await import('../../electron/main/proposals/standaloneExec');
  const { updateSettings } = await import('../../electron/main/projects/store');
  const { __resetForTest } = await import('../../electron/main/mcp/registry');
  const { createSubConversation } = await import('../../electron/main/conversations/store');

  __resetForTest();
  await updateSettings({ mcpServers: [] });
  // 主对话已取消——新建一条 sub 对话承载各 ctx / proposal 的 conversationId
  const conv = await createSubConversation('twin', '新对话');

  // ─── case 1: mcp_install（work 挡）→ 构造 install proposal + 调 onProposal + 回执"后台异步执行" ───
  // 只读重构后"什么都问"挡退场：work/danger 经 router 自动执行、回执统一为"后台异步执行"；
  // 只读挡在 execute 入口直接拒（见 case 1b）。挡位实时读 getAgent（'twin' 不存在 → 回落 ctx.approvalMode）。
  {
    const installTool = makeMcpInstallTool();
    let captured: unknown = null;
    const ctx = {
      conversationId: conv.id,
      agentId: 'twin',
      ownerId: 'local-user',
      usage: 'twinMain' as const,
      approvalMode: 'work',
      abortSignal: new AbortController().signal,
      onProposal: async (p: unknown) => {
        captured = p;
      },
    };
    const r = await installTool.execute(
      {
        label: 'Test Linear',
        description: 'read linear tickets',
        command: 'echo',
        args: ['hi'],
        env: { LINEAR_API_KEY: 'lin_secret_token_xyz' },
        enabled: false,
      },
      ctx,
    );
    const p = captured as { kind?: string; status?: string; config?: { label?: string; env?: Record<string, string> } } | null;
    assert(p !== null, 'install tool 触发了 ctx.onProposal');
    assert(p?.kind === 'mcp.install', `proposal.kind === 'mcp.install'，实际: ${p?.kind}`);
    assert(p?.status === 'pending', `proposal.status === 'pending'，实际: ${p?.status}`);
    assert(p?.config?.label === 'Test Linear', `proposal.config.label === 'Test Linear'`);
    assert(
      p?.config?.env?.LINEAR_API_KEY === 'lin_secret_token_xyz',
      'env value 在 propose 上明文传递（让用户审）',
    );
    assert(
      r.text.includes('后台异步执行'),
      `work 挡 tool 返回 "后台异步执行"，实际: ${r.text.slice(0, 60)}`,
    );
  }

  // 注：只读挡对写类工具的硬拒已收敛到中央闸 executeAgentTool（mutatesEnvironment 标记 + 触达
  // execute 前直接拒），不再在各工具 execute 内自判——原 case 1b「直接调 installTool.execute 验只读」
  // 是测错层（绕过中央闸）。该通用行为由 tests/agent/executeAgentTool.test.ts 专测，此处不再重复。

  // ─── case 2: mcp_install 审批门关 → tool 返回 "已自动" ───
  {
    const installTool = makeMcpInstallTool();
    const ctx = {
      conversationId: conv.id,
      agentId: 'twin',
      ownerId: 'local-user',
      usage: 'twinMain' as const,
      approvalMode: 'work',
      abortSignal: new AbortController().signal,
      onProposal: async () => {},
    };
    const r = await installTool.execute(
      { label: 'Trust Mode', command: 'echo', args: [], enabled: false },
      ctx,
    );
    assert(r.text.includes('后台异步执行'), `审批门关时 tool 返回 "后台异步执行"，实际: ${r.text.slice(0, 80)}`);
  }

  // ─── case 3: runProposalStandalone 执行 mcp.install propose → settings 多一条 ───
  {
    __resetForTest();
    await updateSettings({ mcpServers: [] });
    const { buildInstallProposal } = await import('../../electron/main/proposals/makeMcpProposal');
    const p = buildInstallProposal({
      conversationId: conv.id,
      title: 'install foo',
      description: 'install foo',
      config: {
        label: 'Async Foo',
        command: 'echo',
        args: ['foo'],
        enabled: false,
      },
    });
    const events: Array<{ type?: string; status?: string }> = [];
    await runProposalStandalone(p, (ev) => events.push(ev as { type?: string; status?: string }));
    assert(p.status === 'executed', `成功后 proposal.status === 'executed'，实际: ${p.status}`);
    assert(events.length === 1, '广播 1 条 statusChanged');
    assert(
      events[0].type === 'proposal.statusChanged' && events[0].status === 'executed',
      `广播 statusChanged status='executed'`,
    );

    const { getSettings } = await import('../../electron/main/projects/store');
    const s = await getSettings();
    assert(
      (s.mcpServers ?? []).some((srv) => srv.label === 'Async Foo'),
      'settings 多了 Async Foo',
    );
  }

  // ─── case 4: runProposalStandalone 真失败路径 → status='failed' ───
  {
    const { buildInstallProposal } = await import('../../electron/main/proposals/makeMcpProposal');
    const p = buildInstallProposal({
      conversationId: conv.id,
      title: 'install bad',
      description: '',
      config: {
        label: 'Bad Spawn',
        command: '/this/path/does/not/exist/binary',  // 触发 spawn 失败
        args: [],
        enabled: true,  // 必须 enabled=true 才会真 spawn
      },
    });
    const events: Array<{ status?: string; failureMessage?: string }> = [];
    await runProposalStandalone(p, (ev) => events.push(ev as { status?: string }));
    assert(p.status === 'failed', `命令不存在时 status='failed'，实际: ${p.status}`);
    assert(
      typeof p.failureMessage === 'string' && p.failureMessage.length > 0,
      `failureMessage 非空，实际: ${p.failureMessage}`,
    );
    assert(
      events.some((ev) => ev.status === 'failed'),
      `广播 statusChanged 含 status='failed'`,
    );
  }

  // ─── case 5: mcp_inspect 返回 envKeys 含 key 但不含 value ───
  {
    __resetForTest();
    await updateSettings({
      mcpServers: [
        {
          id: 'secret-srv',
          label: 'Secret Server',
          command: 'echo',
          args: [],
          enabled: false,
          env: { SECRET_TOKEN: 'super-secret-value-do-not-leak' },
        },
      ],
    });
    const inspectTool = makeMcpInspectTool();
    const ctx = {
      conversationId: conv.id,
      agentId: 'twin',
      ownerId: 'local-user',
      usage: 'twinMain' as const,
      approvalMode: 'work',
      abortSignal: new AbortController().signal,
    };
    const r = await inspectTool.execute({ serverId: 'secret-srv' }, ctx);
    assert(r.text.includes('SECRET_TOKEN'), 'inspect 返回含 env key 名');
    assert(
      !r.text.includes('super-secret-value-do-not-leak'),
      'inspect **不含** env value（即使 server 配置里有）',
    );
    assert(r.text.includes('"found": true'), 'inspect 返回 found=true');
  }

  // ─── case 6: mcp_list 返回所有 server ───
  {
    const listTool = makeMcpListTool();
    const ctx = {
      conversationId: conv.id,
      agentId: 'twin',
      ownerId: 'local-user',
      usage: 'twinMain' as const,
      approvalMode: 'work',
      abortSignal: new AbortController().signal,
    };
    const r = await listTool.execute({}, ctx);
    const list = JSON.parse(r.text) as Array<{ label: string }>;
    assert(Array.isArray(list), 'mcp_list 返回数组');
    assert(list.some((s) => s.label === 'Secret Server'), 'mcp_list 含已配的 Secret Server');
  }

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
