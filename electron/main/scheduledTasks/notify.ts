/**
 * 定时任务全端状态广播——任何改动 store 的路径（AI 工具 / router RPC / 调度器 markRun）
 * 都经此把最新全量状态推给所有客户端（对齐 settings.update 的 broadcast 范式）。
 * broadcaster 在 index.ts 启动时注入；未注入（单测 / 背景）时静默。
 *
 * payload 由调用方传入的 buildFn 构造（走 rpc.buildScheduledStatePayload 单一 helper，带 groups）——
 * 本模块不反向依赖 store/聚合，便于测试注入。
 */
import type { ScheduledTaskStateEvent } from '@shared/protocol';

type Broadcaster = (payload: ScheduledTaskStateEvent) => void;

let broadcaster: Broadcaster | null = null;

export function setScheduledTaskBroadcaster(fn: Broadcaster | null): void {
  broadcaster = fn;
}

/** 构造全量状态 + 广播。buildFn 由调用方传入（走 rpc 单一 helper，避免本模块依赖聚合层）。 */
export async function emitScheduledTaskState(
  buildFn: () => Promise<ScheduledTaskStateEvent>,
): Promise<void> {
  if (!broadcaster) return;
  broadcaster(await buildFn());
}
