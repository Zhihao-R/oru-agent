/**
 * 飞书 adapter 的纯转换（tech design §3.1）——把 SDK 的 im.message.receive_v1 事件 normalize 成
 * 统一 MessageEvent：取 message_id / chat_id、open_id（userId）/ union_id（userIdAlt）、解析文本与斜杠命令。
 * connect/disconnect/send 是 SDK glue（真实长连接由 PoC 验），此处只测 normalize。
 * （parseCommand 自身的用例在 command.test.ts——跨平台同源解析，不在 adapter 重复钉。）
 */
import { describe, expect, it } from 'vitest';
import { buildOutboundText, deliverText, normalizeFeishuEvent } from '../../electron/main/platform/feishu/adapter';
import type { SendResult } from '@shared/platform/message';

/** 造一条飞书 im.message.receive_v1 事件（SDK 已解包到 data.message / data.sender）。 */
function feishuEvent(over: { text?: string; chatType?: string; openId?: string; unionId?: string } = {}) {
  return {
    sender: { sender_id: { open_id: over.openId ?? 'ou_x', union_id: over.unionId ?? 'on_x', user_id: 'u_x' } },
    message: {
      message_id: 'om_123',
      chat_id: 'oc_456',
      chat_type: over.chatType ?? 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: over.text ?? '你好' }),
    },
  };
}

describe('normalizeFeishuEvent', () => {
  it('提取文本 / message_id / chat_id / open_id / union_id', () => {
    const e = normalizeFeishuEvent(feishuEvent({ text: '帮我建文档', openId: 'ou_a', unionId: 'on_b' }));
    expect(e.text).toBe('帮我建文档');
    expect(e.messageId).toBe('om_123');
    expect(e.source.chatId).toBe('oc_456');
    expect(e.source.userId).toBe('ou_a');
    expect(e.source.userIdAlt).toBe('on_b');
    expect(e.source.platform).toBe('feishu');
  });

  it('斜杠命令被解析进 command', () => {
    expect(normalizeFeishuEvent(feishuEvent({ text: '/stop' })).command).toEqual({ kind: 'stop' });
  });

  it('raw 逃生舱保留原始事件', () => {
    const raw = feishuEvent();
    expect(normalizeFeishuEvent(raw).source.raw).toBe(raw);
  });

  it('content 非法 JSON 不抛（降级空文本）', () => {
    const bad = { ...feishuEvent(), message: { ...feishuEvent().message, content: 'not-json' } };
    expect(() => normalizeFeishuEvent(bad)).not.toThrow();
    expect(normalizeFeishuEvent(bad).text).toBe('');
  });
});

/** 造非文本消息事件：指定 message_type 与 content 对象。 */
function feishuTypedEvent(messageType: string, content: unknown) {
  const base = feishuEvent();
  return {
    ...base,
    message: { ...base.message, message_type: messageType, content: JSON.stringify(content) },
  };
}

describe('normalizeFeishuEvent — 图片消息（image）', () => {
  it('提取 image_key 进 imageKeys，text 为空', () => {
    const e = normalizeFeishuEvent(feishuTypedEvent('image', { image_key: 'img_k1' }));
    expect(e.text).toBe('');
    expect(e.imageKeys).toEqual(['img_k1']);
  });

  it('缺 image_key → 无 imageKeys（走不支持回执，不装作有图）', () => {
    const e = normalizeFeishuEvent(feishuTypedEvent('image', {}));
    expect(e.imageKeys ?? []).toEqual([]);
  });

  it('文本消息不带 imageKeys', () => {
    expect(normalizeFeishuEvent(feishuEvent({ text: 'hi' })).imageKeys).toBeUndefined();
  });
});

describe('normalizeFeishuEvent — 富文本消息（post，图文混发）', () => {
  it('抽 title + text runs 拼接为文本、img runs 收进 imageKeys', () => {
    const e = normalizeFeishuEvent(
      feishuTypedEvent('post', {
        title: '酒单',
        content: [
          [{ tag: 'text', text: '帮我看看' }, { tag: 'img', image_key: 'img_a' }],
          [{ tag: 'text', text: '第二段' }, { tag: 'img', image_key: 'img_b' }],
        ],
      }),
    );
    expect(e.text).toBe('酒单\n帮我看看\n第二段');
    expect(e.imageKeys).toEqual(['img_a', 'img_b']);
  });

  it('纯图 post（无 title 无 text run）→ text 空 + imageKeys 有货', () => {
    const e = normalizeFeishuEvent(
      feishuTypedEvent('post', { content: [[{ tag: 'img', image_key: 'img_only' }]] }),
    );
    expect(e.text).toBe('');
    expect(e.imageKeys).toEqual(['img_only']);
  });

  it('post 里的非文非图元素（@提及/链接）不抛、原样跳过', () => {
    const e = normalizeFeishuEvent(
      feishuTypedEvent('post', {
        content: [[{ tag: 'at', user_id: 'u1' }, { tag: 'text', text: '在吗' }]],
      }),
    );
    expect(e.text).toBe('在吗');
  });

  it('post 结构非法（content 不是数组）→ 降级空事件不抛', () => {
    const e = normalizeFeishuEvent(feishuTypedEvent('post', { content: 'garbage' }));
    expect(e.text).toBe('');
    expect(e.imageKeys ?? []).toEqual([]);
  });
});

describe('buildOutboundText — 出站文本走 post+md、带 uuid 幂等键', () => {
  it('msg_type 是 post、文本整段进 md 标签（text 类型飞书不渲染 Markdown）、uuid 透传', () => {
    const data = buildOutboundText('oc_1', '**加粗**\n# 标题\n- 列表', 'uuid-1');
    expect(data.receive_id).toBe('oc_1');
    expect(data.msg_type).toBe('post');
    expect(data.uuid).toBe('uuid-1');
    expect(JSON.parse(data.content)).toEqual({
      zh_cn: { content: [[{ tag: 'md', text: '**加粗**\n# 标题\n- 列表' }]] },
    });
  });
});

describe('deliverText — 幂等键重发、明确拒收才降级 text（S05 拍板：结果未知不盲重发）', () => {
  /** 造一个按脚本依次吐结果的 sendOnce，记录每次消息体（含 uuid）。 */
  function scriptedSend(results: SendResult[]) {
    const calls: Array<{ msg_type: string; content: string; uuid?: string }> = [];
    const sendOnce = async (data: { receive_id: string; content: string; msg_type: string; uuid?: string }): Promise<SendResult> => {
      calls.push({ msg_type: data.msg_type, content: data.content, uuid: data.uuid });
      return results[calls.length - 1] ?? { ok: false, error: '脚本用尽', failure: 'permanent' };
    };
    return { calls, sendOnce };
  }
  const noBackoff = async () => {};
  /** 递增 uuid 工厂——断言「重试同 uuid、降级新 uuid」。 */
  function seqUuid() {
    let n = 0;
    return () => `uuid-${++n}`;
  }

  it('post 一次成功 → 不重试不降级，消息带 uuid', async () => {
    const { calls, sendOnce } = scriptedSend([{ ok: true, messageId: 'om_1' }]);
    const res = await deliverText(sendOnce, 'oc_1', 'hi', noBackoff, seqUuid());
    expect(res).toEqual({ ok: true, messageId: 'om_1' });
    expect(calls.map((c) => c.msg_type)).toEqual(['post']);
    expect(calls[0]!.uuid).toBe('uuid-1');
  });

  it('post 被平台明确拒收（permanent）→ 降级 text 原样补投（明确失败无双发风险）', async () => {
    const { calls, sendOnce } = scriptedSend([
      { ok: false, error: 'content format of the post type is incorrect', failure: 'permanent' },
      { ok: true, messageId: 'om_2' },
    ]);
    const res = await deliverText(sendOnce, 'oc_1', '**原文**', noBackoff, seqUuid());
    expect(res).toEqual({ ok: true, messageId: 'om_2' });
    expect(calls.map((c) => c.msg_type)).toEqual(['post', 'text']);
    expect(JSON.parse(calls[1]!.content)).toEqual({ text: '**原文**' });
    expect(calls[1]!.uuid).not.toBe(calls[0]!.uuid); // 不同内容不同幂等键
  });

  it('暂时性失败（429）→ 退避后同 uuid 重发，成功则不降级', async () => {
    let waited = 0;
    const { calls, sendOnce } = scriptedSend([
      { ok: false, error: '429 rate limit', failure: 'transient' },
      { ok: true, messageId: 'om_3' },
    ]);
    const res = await deliverText(sendOnce, 'oc_1', 'hi', async () => void waited++, seqUuid());
    expect(res).toEqual({ ok: true, messageId: 'om_3' });
    expect(waited).toBe(1);
    expect(calls.map((c) => c.msg_type)).toEqual(['post', 'post']);
    expect(calls[1]!.uuid).toBe(calls[0]!.uuid); // 重发同 uuid，平台幂等去重
  });

  it('结果未知（超时）→ 带同 uuid 重发（幂等键防双发，G84 回归：不再盲重发）', async () => {
    const { calls, sendOnce } = scriptedSend([
      { ok: false, error: 'ETIMEDOUT', failure: 'unknown' },
      { ok: true, messageId: 'om_4' },
    ]);
    const res = await deliverText(sendOnce, 'oc_1', 'hi', noBackoff, seqUuid());
    expect(res).toEqual({ ok: true, messageId: 'om_4' });
    expect(calls[1]!.uuid).toBe(calls[0]!.uuid);
  });

  it('结果未知重发仍失败 → 不降级 text（G84 回归：撤掉无条件补投，同一内容不三投）', async () => {
    const { calls, sendOnce } = scriptedSend([
      { ok: false, error: 'ETIMEDOUT', failure: 'unknown' },
      { ok: false, error: 'ETIMEDOUT', failure: 'unknown' },
    ]);
    const res = await deliverText(sendOnce, 'oc_1', 'hi', noBackoff, seqUuid());
    expect(res.ok).toBe(false);
    expect(res.failure).toBe('unknown');
    expect(calls.map((c) => c.msg_type)).toEqual(['post', 'post']); // 无第三投
  });

  it('暂时性失败重发仍失败 → 不降级 text（降级只救「post 被明确拒收」一种）', async () => {
    const { calls, sendOnce } = scriptedSend([
      { ok: false, error: '429', failure: 'transient' },
      { ok: false, error: '429', failure: 'transient' },
    ]);
    const res = await deliverText(sendOnce, 'oc_1', 'hi', noBackoff, seqUuid());
    expect(res.ok).toBe(false);
    expect(calls.map((c) => c.msg_type)).toEqual(['post', 'post']);
  });
});
