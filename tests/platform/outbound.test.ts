/**
 * 渠道出站面（S10 · §4）——resolveOutboundTargets 判据与 deliverToChannel 脱敏/失败留痕。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation, TriggerOrigin } from '@shared/types';
import {
  resolveOutboundTargets,
  deliverToChannel,
  registerChannelSender,
  unregisterChannelSender,
} from '../../electron/main/platform/outbound';

const conv = { id: 'c' } as Conversation;
function origin(platform: 'feishu' | 'discord', chatId: string, mid = 'm'): TriggerOrigin {
  return { platform, chatId, platformMessageId: mid };
}

describe('resolveOutboundTargets', () => {
  it('纯桌面输入（无 origin）→ 空、不回发', () => {
    expect(resolveOutboundTargets([{}, {}], conv)).toEqual([]);
  });

  it('含渠道 origin → 回发到这些 (platform, chatId)', () => {
    const targets = resolveOutboundTargets([{ origin: origin('feishu', 'chat1') }, {}], conv);
    expect(targets).toEqual([{ platform: 'feishu', chatId: 'chat1' }]);
  });

  it('同 chat 多条去重、不同 chat 各一', () => {
    const targets = resolveOutboundTargets(
      [
        { origin: origin('feishu', 'chat1', 'm1') },
        { origin: origin('feishu', 'chat1', 'm2') },
        { origin: origin('discord', 'chat2') },
      ],
      conv,
    );
    expect(targets).toEqual([
      { platform: 'feishu', chatId: 'chat1' },
      { platform: 'discord', chatId: 'chat2' },
    ]);
  });
});

describe('deliverToChannel', () => {
  beforeEach(() => {
    unregisterChannelSender('feishu');
    unregisterChannelSender('discord');
  });

  it('脱敏后经注册发送器发出', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    registerChannelSender('feishu', send);
    await deliverToChannel({ platform: 'feishu', chatId: 'c1' }, 'hello');
    expect(send).toHaveBeenCalledWith('c1', 'hello');
  });

  it('空文本不发', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    registerChannelSender('feishu', send);
    const res = await deliverToChannel({ platform: 'feishu', chatId: 'c1' }, '   ');
    expect(send).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('平台未连接（无注册发送器）→ 失败留痕、不抛', async () => {
    const res = await deliverToChannel({ platform: 'discord', chatId: 'c1' }, 'hi');
    expect(res.ok).toBe(false);
  });

  it('发送失败 → 返回失败结果（留痕，不抛）', async () => {
    registerChannelSender('feishu', vi.fn().mockResolvedValue({ ok: false, error: 'boom', failure: 'permanent' }));
    const res = await deliverToChannel({ platform: 'feishu', chatId: 'c1' }, 'hi');
    expect(res.ok).toBe(false);
  });
});
