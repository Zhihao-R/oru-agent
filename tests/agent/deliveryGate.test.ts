/**
 * 对外投递判定内核（S04 → S24）：用户逐字地址判定 + 授权键 / 授权 scope 推导。
 * 攻击场景是主角：地址出现在 assistant 消息（抓回内容）不算、追加参数不算、
 * 合成 kind 的 user 消息不算——「逐字来自用户本人」一个都不能松。
 * S24 起会话级过渡记忆（rememberSessionGrant/sessionGrantCovers）已从生产代码移除，
 * 免卡改由持久授权清单（isGranted）判——本文件只覆盖判定内核的纯函数轴。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, DeliveryTarget } from '../../shared/types';

const historyByConv = new Map<string, ChatMessage[]>();

vi.mock('../../electron/main/conversations/store', () => ({
  readHistory: vi.fn(
    async (_agentId: string, convId: string): Promise<ChatMessage[]> => historyByConv.get(convId) ?? [],
  ),
}));

import {
  addressesPinnedByUser,
  deliveryGrantKey,
  deliveryScope,
  judgeUrl,
} from '../../electron/main/agent/outbound/deliveryGate';

let seq = 0;
function msg(role: ChatMessage['role'], text: string, kind?: ChatMessage['kind']): ChatMessage {
  return {
    id: `m${seq++}`,
    conversationId: 'c1',
    role,
    text,
    toolCalls: [],
    createdAt: 1,
    done: true,
    kind,
  };
}

beforeEach(() => {
  historyByConv.clear();
});

describe('addressesPinnedByUser（逐字合取）', () => {
  it('用户消息里逐字出现 → pinned；含去 scheme 形态', async () => {
    historyByConv.set('c1', [msg('user', '帮我看下 https://example.com/a?x=1 这页')]);
    expect(await addressesPinnedByUser(['https://example.com/a?x=1'], 'a1', 'c1')).toBe(true);
    // 用户没写 scheme，模型带 scheme 抓——去前缀形态命中
    historyByConv.set('c1', [msg('user', '看下 example.com/b 呗')]);
    expect(await addressesPinnedByUser(['https://example.com/b'], 'a1', 'c1')).toBe(true);
  });

  it('攻击：地址只在 assistant 消息（抓回内容）→ 不 pinned', async () => {
    historyByConv.set('c1', [msg('assistant', '页面里提到 https://evil.example.com/x')]);
    expect(await addressesPinnedByUser(['https://evil.example.com/x'], 'a1', 'c1')).toBe(false);
  });

  it('攻击：用户地址后追加参数 → 不逐字、不 pinned', async () => {
    historyByConv.set('c1', [msg('user', '看看 https://example.com/a')]);
    expect(await addressesPinnedByUser(['https://example.com/a?leak=secret'], 'a1', 'c1')).toBe(false);
  });

  it('合成 kind 的 user 消息（proposal 等）不算用户本人消息', async () => {
    historyByConv.set('c1', [msg('user', 'https://example.com/from-card', 'proposal')]);
    expect(await addressesPinnedByUser(['https://example.com/from-card'], 'a1', 'c1')).toBe(false);
  });

  it('多地址合取：只钉了其一 → false；空地址列表恒 false', async () => {
    historyByConv.set('c1', [msg('user', 'https://a.example.com')]);
    expect(await addressesPinnedByUser(['https://a.example.com', 'https://b.example.com'], 'a1', 'c1')).toBe(false);
    expect(await addressesPinnedByUser([], 'a1', 'c1')).toBe(false);
  });

  it('大小写敏感：Host 大小写不同 → 不 pinned（宁可误拦）', async () => {
    historyByConv.set('c1', [msg('user', 'https://Example.com/a')]);
    expect(await addressesPinnedByUser(['https://example.com/a'], 'a1', 'c1')).toBe(false);
  });
});

describe('judgeUrl 与授权键 / 授权 scope', () => {
  it('非 pinned → 投递目标：channel=web、recipient=host', async () => {
    const v = await judgeUrl('https://api.example.com/collect', 'a1', 'c1');
    expect(v).toMatchObject({ target: { channel: 'web', recipient: 'api.example.com' } });
  });
  it('deliveryGrantKey：渠道:收件人；recipient=null → null（不可持久授权）', () => {
    expect(deliveryGrantKey({ channel: 'web', recipient: 'x.com', label: '' })).toBe('web:x.com');
    expect(deliveryGrantKey({ channel: 'feishu', recipient: null, label: '' })).toBeNull();
  });
});

describe('deliveryScope（S24 · G30：投递目标 → 可持久授权 scope）', () => {
  const t = (recipient: string | null): DeliveryTarget => ({ channel: 'web', recipient, label: '' });

  it('有收件人 → {kind:delivery, channel, recipient}', () => {
    expect(deliveryScope(t('example.com'))).toEqual({
      kind: 'delivery',
      channel: 'web',
      recipient: 'example.com',
    });
  });
  it('recipient=null → null（不可持久授权，该目标永远弹卡）', () => {
    expect(deliveryScope(t(null))).toBeNull();
  });
});
