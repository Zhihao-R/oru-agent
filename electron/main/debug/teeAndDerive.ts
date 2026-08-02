/**
 * teeAndDerive —— 把 backend 的 ConversationEvent 流"分流"给 debug deriver
 *
 * 调用模式（详见 docs/tech/2026-05-10-debug-module-tech-design.md §4.1）：
 *
 *   const handle = backend.runConversation({...});
 *   const deriver = round.makeStreamDeriver({backendType, modelId, providerId});
 *   const wrappedEvents = teeAndDerive(handle.events, deriver);
 *   await pipeSdkToEvents(wrappedEvents, ...);
 *
 * 关键属性：
 * - 透明转发：消费方拿到的事件序列与原始 handle.events 一字不差
 * - deriver 抛错被 try/catch 吞掉，不影响主流（debug 模块 die quietly）
 * - deriver === null（NoOp 模式）时直接透传，零额外开销
 */

import type { ConversationEvent } from '@shared/agent/backend';
import type { StreamDeriver } from './derive';

export async function* teeAndDerive(
  src: AsyncIterable<ConversationEvent>,
  deriver: StreamDeriver | null,
): AsyncIterable<ConversationEvent> {
  if (!deriver) {
    // NoOp 直通
    for await (const ev of src) yield ev;
    return;
  }
  for await (const ev of src) {
    try {
      deriver.feed(ev);
    } catch (e) {
      // debug 错了不影响主对话
      console.warn('[debug.deriver] feed failed', e);
    }
    yield ev;
  }
}
