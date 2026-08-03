/**
 * rendererQuery —— main → renderer 的通用查询信箱。
 *
 * 协议同构先例：chat.askUserChoice（ServerEvent）+ chat.answerUserChoice（ClientRequest）。
 *
 * 防线（照抄 pendingDecision）：先挂 waiter 再 emit；超时 settle（调用方决定降级方向——
 * 闸门路径保守拦截）；多窗口广播下首答生效、后到丢弃（按 queryId take-once）。
 * 无客户端连接（无 UI 的对话 / smoke）：dirtySet 立即按空集应答——没有渲染进程就没有未落盘改动，
 * 这是语义正确而非降级。
 */
import { newReqId } from '@shared/ids';
import type { Broadcast } from '../ws/server';

export type RendererQueryKind = 'dirtySet';
export type DirtySetResult = { paths: string[] };

const DEFAULT_TIMEOUT_MS = 2000;

type Deps = { broadcast: Broadcast; hasClients: () => boolean };
let deps: Deps | null = null;

/** 启动期注入（index.ts）——不直接 import ws/server 的运行时符号，避免模块环。 */
export function setRendererQueryDeps(d: Deps): void {
  deps = d;
}

type Waiter = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, Waiter>();

export function resetRendererQueryForTest(): void {
  for (const w of pending.values()) clearTimeout(w.timer);
  pending.clear();
}

export function rendererQuery<T>(
  kind: RendererQueryKind,
  payload: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  if (!deps || !deps.hasClients()) {
    if (kind === 'dirtySet') return Promise.resolve({ paths: [] } as T);
    return Promise.reject(new Error('rendererQuery: 无渲染进程连接'));
  }
  const queryId = newReqId();
  const d = deps;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(queryId);
      // 治本一（方案 B，2026-08-03 拍板）：dirtySet 超时降级「按无脏放行」——查不到就当没草稿，
      // 不再 reject 拖挂闸门。实时落盘下草稿概念本就弱化 + FileHistory 兜底，漏拦风险低，换来
      // bash / write / 编码转换不再被渲染端高负载时 2s 超时拦成「编辑器无响应」。
      // 其它 kind（读路径如 draft）保留原有 reject 语义，由调用方自行降级读磁盘。
      if (kind === 'dirtySet') {
        resolve({ paths: [] } as T);
      } else {
        reject(new Error(`rendererQuery 超时（${timeoutMs}ms, kind=${kind}）`));
      }
    }, timeoutMs);
    // 先挂 waiter 再 emit——应答先于 emit 返回也不丢
    pending.set(queryId, { resolve: (r) => resolve(r as T), reject, timer });
    d.broadcast({ type: 'renderer.query', queryId, kind, payload });
  });
}

/** renderer 应答入口（router 的 renderer.queryResult case 调）。返回是否被消费（take-once）。 */
export function resolveRendererQuery(queryId: string, result: unknown): boolean {
  const waiter = pending.get(queryId);
  if (!waiter) return false; // 已超时 / 已被首答消费——后到丢弃
  pending.delete(queryId);
  clearTimeout(waiter.timer);
  waiter.resolve(result);
  return true;
}
