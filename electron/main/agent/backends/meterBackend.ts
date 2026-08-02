/**
 * 用量计量代理（理想架构 S13 · G110）
 *
 * getBackendFor(usage) 是全系统模型调用的唯一入口——它既按用途路由、又返回会上报 result.usage
 * 的后端。把返回的后端包一层薄代理，观测每轮 result 事件 / oneShot 的 usage，按用途落账：计量因此
 * 是「既有收口点的副产品」，零对齐税、三后端一致（含托管后端——其 result.usage 由 modelUsage
 * 聚合，per-call 缺失不影响 result 级归账）。
 *
 * 用 Proxy 而非重建对象：Proxy 透传原型链，`instanceof ClaudeCodeBackend` 等对具体后端类的判定
 * 依旧成立，对所有调用方（含路由自检、单测）完全透明。只拦 runConversation / runOneShot 两个出量
 * 口，其余成员绑定到真实例转发（`this` 恒为真后端，杜绝私有字段错绑）；落账 fire-and-forget，绝不
 * 阻塞事件流。
 */
import type {
  AgentBackend,
  ConversationHandle,
  ConversationInput,
  OneShotInput,
  OneShotResult,
} from '@shared/agent/backend';
import type { LlmUsage } from '@shared/types';
import { recordUsage } from '../../usage/ledger';

function meterConversation(handle: ConversationHandle, purpose: LlmUsage): ConversationHandle {
  return {
    events: (async function* () {
      for await (const ev of handle.events) {
        // result 是每轮终结事件、携带整轮聚合 usage——一轮只落一次账（多次工具调用不重复计）
        if (ev.type === 'result' && ev.usage) {
          void recordUsage(purpose, {
            inputTokens: ev.usage.inputTokens,
            outputTokens: ev.usage.outputTokens,
          });
        }
        yield ev;
      }
    })(),
  };
}

export function meterBackend(backend: AgentBackend, purpose: LlmUsage): AgentBackend {
  return new Proxy(backend, {
    get(target, prop, receiver) {
      if (prop === 'runConversation') {
        return (input: ConversationInput) => meterConversation(target.runConversation(input), purpose);
      }
      if (prop === 'runOneShot') {
        return async (input: OneShotInput, signal?: AbortSignal): Promise<OneShotResult> => {
          const res = await target.runOneShot(input, signal);
          if (res.usage) {
            void recordUsage(purpose, {
              inputTokens: res.usage.inputTokens,
              outputTokens: res.usage.outputTokens,
            });
          }
          return res;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      // 方法绑回真实例，避免以 proxy 为 this 触碰后端私有字段
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
