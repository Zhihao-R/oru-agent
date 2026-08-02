/**
 * 给 backend.runOneShot 包一层超时——autoName / compress 等离线 LLM 调用复用。
 *
 * 设计目的：runOneShot 自身的 backend 实现不一定信任上游 retry 行为；这里用
 * AbortController + setTimeout 提供一个统一的"硬超时"语义——超时即 abort signal，
 * 调用方按 AbortError 或 backend 透出的 error 处理失败。
 *
 * 入参直接透 OneShotInput——不要在这里复制 prompt-only 的窄签名，否则 autoName 想关
 * reasoning、compress 想塞 outputSchema 都得改 helper 自己。
 */
import type { AgentBackend, OneShotInput, OneShotResult } from '@shared/agent/backend';

export async function runOneShotWithTimeout(
  backend: AgentBackend,
  input: OneShotInput,
  timeoutMs: number,
): Promise<OneShotResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await backend.runOneShot(input, ac.signal);
  } finally {
    clearTimeout(timer);
  }
}
