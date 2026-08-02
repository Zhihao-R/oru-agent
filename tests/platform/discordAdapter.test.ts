/**
 * Discord adapter 的纯转换（tech design §3.2）——把 discord.js Message normalize 成统一 MessageEvent。
 * Discord 用户 id 全局稳定（无飞书 open_id/union_id 双 ID 之分），故 userId=author.id、userIdAlt 不设。
 * connect/disconnect/send 是 SDK glue（真机需 Bot Token），此处只测 normalize + 命令解析。
 */
import { describe, expect, it } from 'vitest';
import { deliverDiscordContent, normalizeDiscordMessage } from '../../electron/main/platform/discord/adapter';
import type { SendResult } from '@shared/platform/message';

function dmsg(over: { id?: string; content?: string; userId?: string; channelId?: string } = {}) {
  return {
    id: over.id ?? 'msg_1',
    content: over.content ?? '你好',
    author: { id: over.userId ?? 'u_1', bot: false },
    channelId: over.channelId ?? 'dm_1',
  };
}

describe('normalizeDiscordMessage', () => {
  it('提取 content / id / channelId / author.id', () => {
    const e = normalizeDiscordMessage(dmsg({ content: '帮我建文档', userId: 'u_a', channelId: 'dm_x' }));
    expect(e.text).toBe('帮我建文档');
    expect(e.messageId).toBe('msg_1');
    expect(e.source.chatId).toBe('dm_x');
    expect(e.source.userId).toBe('u_a');
    expect(e.source.platform).toBe('discord');
  });

  it('Discord 无 union_id：userIdAlt 不设', () => {
    expect(normalizeDiscordMessage(dmsg()).source.userIdAlt).toBeUndefined();
  });

  it('斜杠命令解析进 command', () => {
    expect(normalizeDiscordMessage(dmsg({ content: '/stop' })).command).toEqual({ kind: 'stop' });
  });

  it('raw 逃生舱保留原始 message', () => {
    const raw = dmsg();
    expect(normalizeDiscordMessage(raw).source.raw).toBe(raw);
  });
});

describe('deliverDiscordContent — 分段投递 + 明确失败自动重投（S05 · G08）', () => {
  /** 按脚本依次吐结果的 sendPayload，记录每次载荷与退避次数。 */
  function scripted(results: SendResult[]) {
    const payloads: Array<{ content: string } | { files: string[] }> = [];
    let backoffs = 0;
    const sendPayload = async (p: { content: string } | { files: string[] }): Promise<SendResult> => {
      payloads.push(p);
      return results[payloads.length - 1] ?? { ok: false, error: '脚本用尽', failure: 'permanent' };
    };
    return { payloads, sendPayload, backoff: async () => void backoffs++, backoffs: () => backoffs };
  }
  const noGap = async () => {};

  it('多段全成功 → 返回最后一段 messageId', async () => {
    const s = scripted([{ ok: true, messageId: 'd1' }, { ok: true, messageId: 'd2' }]);
    const res = await deliverDiscordContent(s.sendPayload, 'a'.repeat(2500), [], 2000, s.backoff, noGap);
    expect(res).toEqual({ ok: true, messageId: 'd2' });
    expect(s.payloads).toHaveLength(2);
  });

  it('段暂时性失败（429）→ 退避后重投一次成功（G08 回归：Discord 此前零次自动重发）', async () => {
    const s = scripted([{ ok: false, error: '429', failure: 'transient' }, { ok: true, messageId: 'd3' }]);
    const res = await deliverDiscordContent(s.sendPayload, 'hi', [], 2000, s.backoff, noGap);
    expect(res).toEqual({ ok: true, messageId: 'd3' });
    expect(s.backoffs()).toBe(1);
  });

  it('段结果未知（超时）→ 不重投、如实返回失败（Discord 无幂等键，盲重发即双发）', async () => {
    const s = scripted([{ ok: false, error: 'ETIMEDOUT', failure: 'unknown' }]);
    const res = await deliverDiscordContent(s.sendPayload, 'hi', [], 2000, s.backoff, noGap);
    expect(res.ok).toBe(false);
    expect(res.failure).toBe('unknown');
    expect(s.payloads).toHaveLength(1);
    expect(s.backoffs()).toBe(0);
  });

  it('文件投递失败 → 如实返回、不吞', async () => {
    const s = scripted([{ ok: true, messageId: 'd4' }, { ok: false, error: '403 forbidden', failure: 'permanent' }]);
    const res = await deliverDiscordContent(s.sendPayload, 'hi', ['/tmp/a.png'], 2000, s.backoff, noGap);
    expect(res.ok).toBe(false);
    expect(s.payloads[1]).toEqual({ files: ['/tmp/a.png'] });
  });
});
