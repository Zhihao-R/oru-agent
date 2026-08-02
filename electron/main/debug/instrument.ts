/**
 * 后台 LLM 调用的调试插桩 helper —— 让 runner.ts 主对话之外的 LLM 调用也进调试面板。
 *
 * runner.ts 的主对话手写了完整插桩（beginRound → makeStreamDeriver → teeAndDerive →
 * done/error，外加 prompt_built / inference_view）。其余调用点不需要那么细，这里收敛成两条：
 *
 *   - instrumentConversation：包住 runConversation 的事件流（A 类，与主对话同构，复用 deriver）
 *   - instrumentOneShot：包住一次 runOneShot（B 类，无事件流，oneShotStart / recordOneShot 直接落盘）
 *
 * 两条都靠 debugLogger.beginRound 的关闭态保护——enabled=false 时返回 NoOp，几乎零开销。
 */
import { debugLogger, type BackendDebugInfo, type RoundMeta } from './logger';
import { teeAndDerive } from './teeAndDerive';
import type { ConversationEvent, OneShotResult } from '@shared/agent/backend';

/** backend 实例上 debug 需要的三个只读字段——A/B 两类都直接传 backend 取 */
export type { BackendDebugInfo };

/** systemContext 提供时落一条 prompt_built（durationMs/stable 段对后台调用无意义，置 0） */
function emitPromptBuilt(
  round: ReturnType<typeof debugLogger.beginRound>,
  systemContext: string | undefined,
): void {
  if (systemContext === undefined) return;
  round.promptBuilt({
    durationMs: 0,
    systemContextChars: systemContext.length,
    stableSystemContextChars: 0,
    systemContext,
  });
}

/**
 * A 类：透明包住 runConversation 的事件流。调用方把 `handle.events` 换成本函数返回值即可，
 * 消费方式不变（事件一字不差透传）。
 *
 * done() 放在 finally——正常消费完 / 消费方提前 break / 抛错三种路径都收束 round_done；
 * 抛错时先 emit error 再走 finally 的 done，顺序与 runner.ts 一致。
 */
export async function* instrumentConversation(
  backend: BackendDebugInfo,
  meta: RoundMeta,
  events: AsyncIterable<ConversationEvent>,
  systemContext?: string,
): AsyncIterable<ConversationEvent> {
  const round = debugLogger.beginRound(meta);
  emitPromptBuilt(round, systemContext);
  const deriver = round.makeStreamDeriver(backend);
  let hadError = false;
  try {
    for await (const ev of teeAndDerive(events, deriver)) {
      if (ev.type === 'result' && ev.isError) hadError = true;
      yield ev;
    }
  } catch (e) {
    hadError = true;
    round.error({
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      phase: 'stream',
    });
    throw e;
  } finally {
    round.done({ hadError });
  }
}

/**
 * B 类：包住一次 runOneShot（返回文本 + token 用量）。runOneShot 无事件流，不走 deriver——
 * run() 前 oneShotStart 落 llm_call_start（卡死时面板可见"有 start 无 done"），成功后
 * recordOneShot 落 llm_call_done（带 usage；firstTokenMs 留空——一次性返回没有"首 token"
 * 概念）+ final_answer；抛错时 done() 补 llm_call_done 收口。
 *
 * 收尾结构与 instrumentConversation 对齐：hadError + finally done，单一收束点。
 */
export async function instrumentOneShot(
  backend: BackendDebugInfo,
  meta: RoundMeta,
  run: () => Promise<OneShotResult>,
  systemContext?: string,
): Promise<string> {
  const round = debugLogger.beginRound(meta);
  emitPromptBuilt(round, systemContext);
  round.oneShotStart(backend);
  let hadError = false;
  try {
    const result = await run();
    round.recordOneShot({ text: result.text, usage: result.usage });
    return result.text;
  } catch (e) {
    hadError = true;
    round.error({
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      phase: 'llm',
    });
    throw e;
  } finally {
    round.done({ hadError });
  }
}
