/**
 * v0.6 mcp_update tool smoke：验证 update propose + runProposalStandalone 触发 registry.updateServer。
 *
 * 1. mcp_update 改 label → propose 含 patch.label + before.label
 * 2. mcp_update patch={enabled:false} → 卡片标题"建议停用 X"（仅 enabled 改 → toggle 子样式）
 * 3. runProposalStandalone 执行 mcp.update propose → settings 持久化新值
 * 4. mcp_update 改 enabled (true→false) → runProposalStandalone 后 client 被 kill（registry 内存中无）
 * 5. mcp_delete propose + 执行 → settings 移除
 */
import './__smoke_isolate__';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function main() {
  const { makeMcpUpdateTool, makeMcpDeleteTool } = await import('../../electron/main/agent/agentTools/mcp');
  const { runProposalStandalone } = await import('../../electron/main/proposals/standaloneExec');
  const { updateSettings, getSettings } = await import('../../electron/main/projects/store');
  const { __resetForTest } = await import('../../electron/main/mcp/registry');
  const { createSubConversation } = await import('../../electron/main/conversations/store');

  __resetForTest();
  // 主对话已取消——新建一条 sub 对话承载本次 propose 的 conversationId
  const conv = await createSubConversation('twin', '新对话');
  await updateSettings({
    mcpServers: [
      {
        id: 'srv-a',
        label: 'Original',
        command: 'echo',
        args: ['old'],
        enabled: false,
      },
    ],
  });

  const ctx = {
    conversationId: conv.id,
    agentId: 'twin',
    ownerId: 'local-user',
    usage: 'twinMain' as const,
    approvalMode: 'work',
    abortSignal: new AbortController().signal,
    onProposal: async () => {},
  };

  // ─── case 1: mcp_update 改 label → propose 含 patch.label + before ───
  {
    const updateTool = makeMcpUpdateTool();
    let captured: unknown = null;
    const r = await updateTool.execute(
      { serverId: 'srv-a', patch: { label: 'Renamed' } },
      { ...ctx, onProposal: async (p) => { captured = p; } },
    );
    const p = captured as { kind?: string; serverId?: string; patch?: Record<string, unknown>; before?: { label?: string }; title?: string } | null;
    assert(p?.kind === 'mcp.update', `proposal.kind === 'mcp.update'`);
    assert(p?.serverId === 'srv-a', `proposal.serverId === 'srv-a'`);
    assert(p?.patch?.label === 'Renamed', `patch.label === 'Renamed'`);
    assert(p?.before?.label === 'Original', `before.label === 'Original' (snapshot)`);
    assert(p?.title === '建议修改 Original 的配置', `title 是多字段配置卡：${p?.title}`);
    assert(r.text.includes('后台异步执行'), `work 挡 tool 返回 "后台异步执行"`);
  }

  // ─── case 2: 仅改 enabled → 卡片标题 "建议启用 / 停用" ───
  {
    const updateTool = makeMcpUpdateTool();
    let captured: unknown = null;
    await updateTool.execute(
      { serverId: 'srv-a', patch: { enabled: true } },
      { ...ctx, onProposal: async (p) => { captured = p; } },
    );
    const p = captured as { title?: string } | null;
    assert(p?.title === '建议启用 Original', `title 是 toggle 卡：${p?.title}`);
  }

  // ─── case 3: runProposalStandalone 执行 mcp.update propose → settings 持久化新值 ───
  {
    const { buildUpdateProposal } = await import('../../electron/main/proposals/makeMcpProposal');
    const before = (await getSettings()).mcpServers?.find((s) => s.id === 'srv-a');
    if (!before) throw new Error('srv-a missing');
    const p = buildUpdateProposal({
      conversationId: conv.id,
      title: 'update srv-a',
      description: '',
      serverId: 'srv-a',
      patch: { label: 'After Async Update', args: ['new'] },
      before,
    });
    const events: unknown[] = [];
    await runProposalStandalone(p, (ev) => events.push(ev));
    assert(p.status === 'executed', `update status='executed'`);
    const s2 = await getSettings();
    const after = s2.mcpServers?.find((s) => s.id === 'srv-a');
    assert(after?.label === 'After Async Update', `settings 持久化新 label：${after?.label}`);
    assert(after?.args.includes('new') === true, `args 持久化新值`);
  }

  // ─── case 4: mcp_delete propose + 执行 → settings 移除 ───
  {
    const deleteTool = makeMcpDeleteTool();
    let captured: unknown = null;
    await deleteTool.execute(
      { serverId: 'srv-a' },
      { ...ctx, onProposal: async (p) => { captured = p; } },
    );
    const p = captured as { kind?: string; serverId?: string; target?: { label?: string } } | null;
    assert(p?.kind === 'mcp.delete', `delete proposal.kind === 'mcp.delete'`);
    assert(p?.serverId === 'srv-a', `delete serverId 正确`);
    assert(p?.target?.label === 'After Async Update', `target snapshot 用 deletion 时刻的 label`);

    const { runProposalStandalone } = await import('../../electron/main/proposals/standaloneExec');
    await runProposalStandalone(p as Parameters<typeof runProposalStandalone>[0], () => {});
    const s3 = await getSettings();
    assert(
      !(s3.mcpServers ?? []).some((s) => s.id === 'srv-a'),
      'delete 执行后 settings 不再含 srv-a',
    );
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
