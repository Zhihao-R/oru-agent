/**
 * 广播捕获——收敛 ws / proposal 路由测试里手写的 `const events = []; const broadcast = e => events.push(e)`
 * 加上 `filter(type).map(status)` 这类断言样板。
 *
 * 用于**进程内**驱动 `route(msg, reply, broadcast)` / `proposeOrExecute(ctx, p, …)` 的单测——
 * 这些路径不连真 WebSocket，只把 ServerEvent 推给一个 broadcast 回调。真 WS 客户端只在 smoke
 * E2E（tests/smoke/__smoke_*__.ts）里用，那里连真服务器，不适用本 helper。
 *
 * ```ts
 * const cap = captureBroadcast();
 * await route(msg, () => {}, cap.broadcast);
 * expect(cap.statuses()).toEqual(['executing', 'executed']);
 * expect(cap.types()).toEqual(['conv.state']);
 * ```
 *
 * 只暴露真被断言用到的面（broadcast / events / types / statuses）——按 type 收窄取某事件负载
 * 等更花哨的读法有第二个调用点再加，不预先铺宽。
 */
import type { ServerEvent } from '@shared/protocol';
import type { ProposalStatus } from '@shared/types';

export type BroadcastCapture = {
  /** 传给 route / proposeOrExecute 的 broadcast 回调 */
  broadcast: (ev: ServerEvent) => void;
  /** 已捕获的全部事件（原始顺序） */
  events: ServerEvent[];
  /** 事件 type 序列——最常见的顺序断言 */
  types: () => ServerEvent['type'][];
  /** proposal.statusChanged 的 status 序列（审批终态链断言的高频写法） */
  statuses: () => Exclude<ProposalStatus, 'pending'>[];
};

export function captureBroadcast(): BroadcastCapture {
  const events: ServerEvent[] = [];
  return {
    broadcast: (ev) => {
      events.push(ev);
    },
    events,
    types: () => events.map((e) => e.type),
    statuses: () =>
      events
        .filter(
          (e): e is Extract<ServerEvent, { type: 'proposal.statusChanged' }> =>
            e.type === 'proposal.statusChanged',
        )
        .map((e) => e.status),
  };
}
