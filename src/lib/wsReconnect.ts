/**
 * 断线重连重拉的统一原语（D4）。
 *
 * 各服务端权威态的同步入口（App 的 resyncServerState、四个 sync hook）挂载时各自拉一次初值；
 * 断线期间漏掉的推送只能靠重连重拉对齐。onStatus 的 'open' 覆盖「首次连上」与「断后重连」两种，
 * 首次由挂载加载负责、不能在此重复（否则启动双拉）——everConnected 门槛把首次 'open' 吞掉、
 * 只在其后的每次 'open' 触发 handler。语义与调用点一致，避免各处手抄这段守卫（系统性）。
 */
import { wsClient } from './ws';

/** 注册「重连（非首次 open）时重拉」。返回退订函数，收进调用点的 effect 清理。 */
export function onReconnect(handler: () => void): () => void {
  let everConnected = wsClient.status() === 'open';
  return wsClient.onStatus((s) => {
    if (s !== 'open') return;
    if (everConnected) handler();
    else everConnected = true; // 首次 open：交给挂载加载，避免双拉
  });
}
