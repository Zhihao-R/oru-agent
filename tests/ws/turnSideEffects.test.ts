/**
 * 回合收尾副作用清单（S34 · G27，锚 conversation-flow.html#Side）。
 *
 * 钉住清单成员：一轮跑完 → applyTurnSideEffects 一处扩散 ①列表/通知状态推送(conv.state)
 * ②归档扫描触发（活跃驱动）。自动命名已前移到 chat.send「首条 user 消息落盘后」即时触发
 * （见 electron/main/ws/handlers/chat.ts），**不在**收尾清单内。并守回归：收尾**不**更新已读
 * 水位 lastSeenAt（回合产出是新内容，盖成已读会抹掉未读提醒）——applyTurnSideEffects 只广播
 * conv.state、从不写水位。
 *
 * ORU_DIR 必须在 paths 加载前设好；归档触发 mock 掉（不跑真定时器）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORU_DIR = mkdtempSync(join(tmpdir(), 'oru-test-sideeffects-'));

const { triggerScanMock } = vi.hoisted(() => ({
  triggerScanMock: vi.fn(),
}));
vi.mock('../../electron/main/conversations/autoArchiver', () => ({ triggerScan: triggerScanMock }));

import { applyTurnSideEffects } from '../../electron/main/ws/handlers/turnArgs';

beforeEach(() => vi.clearAllMocks());

describe('applyTurnSideEffects 回合收尾清单（G27）', () => {
  it('一轮跑完 → 推 conv.state + 触发归档扫描', async () => {
    const broadcast = vi.fn();
    await applyTurnSideEffects({ agentId: 'a1', conversationId: 'c1', broadcast });

    // 列表/通知状态推送
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'conv.state', agentId: 'a1' }));
    // 归档扫描触发（活跃驱动）
    expect(triggerScanMock).toHaveBeenCalledTimes(1);
  });

  it('回归：收尾只广播状态、绝不写已读水位（广播的 conv.state 不带任何 markSeen 动作）', async () => {
    const broadcast = vi.fn();
    await applyTurnSideEffects({ agentId: 'a1', conversationId: 'c1', broadcast });
    // 只发 conv.state（读态广播），没有任何 seen/水位类事件——lastSeenAt 只由 conv.markSeen 更新。
    const evTypes = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(evTypes).toEqual(['conv.state']);
  });
});
