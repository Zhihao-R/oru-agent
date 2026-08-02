/**
 * 系统信号统一注册表（理想架构 S14 · G106/G127）
 *
 * 「信号的一生」讲的都是归属某条对话的信号（等批 / 等答 / 出状况 / 完成）；本模块管另一族——
 * 不属于任何一条对话的系统信号：能力掉线（渠道）、凭据过期、资源耗尽（写盘失败）、调度停摆、
 * 存储损坏。它们的影响面天然更大（一条对话报错只拖一条，后端/渠道掉线拖垮全部），却没有任何一条
 * 对话会替它们报错。通知中心是注意力路由器、不是对话状态面板，这类信号同样归它接收——单列一段，
 * 不混入对话；不进对话列表（那里口径是「哪条对话有事」，系统信号无对话可挂），但计入 oru 徽章的
 * 角标计数——徽章是通知中心唯一入口，角标=对话待办+系统信号合计（原顶栏独立全局指示 2026-07-14
 * PM 拍板并入）。
 *
 * 四类源经此一处收口：各源 raise/clear，注册表去重（同 id 复发只更新不新增）、变更即广播全端。
 * 派生型（渠道/凭据，随连接态自愈）由源在状态变更处 raise/clear；事件型（损坏/写盘失败）为一次性
 * 事故、持续到用户忽略或应用重启后重新检测——注册表在内存，重启即清空，底层问题下次读盘会重新
 * raise（如实告知、不假装完整）。
 */
import type { SystemSignal, SystemSignalsEvent } from '@shared/protocol';

/** id → 信号；id 是去重键（如 'channel-offline:feishu' / 'storage-corruption:conversations/index'）。 */
const signals = new Map<string, SystemSignal>();

/** 已被用户忽略的信号 id——忽略后同 id 再 raise 不复现，直到显式 clear（自愈）后才重置。 */
const dismissed = new Set<string>();

let broadcaster: ((ev: SystemSignalsEvent) => void) | null = null;

/** WS 装配时注入一次全局广播器。 */
export function setSystemSignalBroadcaster(fn: (ev: SystemSignalsEvent) => void): void {
  broadcaster = fn;
}

function broadcast(): void {
  broadcaster?.({ type: 'system.signals', signals: listSystemSignals() });
}

/** 当前在场的系统信号（已滤除被忽略的）；按严重度（critical 先）再按时间排序。 */
export function listSystemSignals(): SystemSignal[] {
  return [...signals.values()]
    .filter((s) => !dismissed.has(s.id))
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
}

/**
 * 升起 / 更新一个系统信号。同 id 已在场且内容等价则不广播（避免连接态抖动刷屏）；
 * createdAt 只在首次升起时定，复发不刷新（保持「这问题从何时起」的事实）。
 */
export function raiseSystemSignal(sig: Omit<SystemSignal, 'createdAt'> & { createdAt?: number }): void {
  const prev = signals.get(sig.id);
  const next: SystemSignal = {
    ...sig,
    createdAt: prev?.createdAt ?? sig.createdAt ?? Date.now(),
  };
  // 内容等价（severity / params / detail 未变）+ 未被忽略 → 无需广播
  if (
    prev &&
    !dismissed.has(sig.id) &&
    prev.severity === next.severity &&
    prev.detail === next.detail &&
    JSON.stringify(prev.params ?? null) === JSON.stringify(next.params ?? null)
  ) {
    signals.set(sig.id, next);
    return;
  }
  signals.set(sig.id, next);
  broadcast();
}

/**
 * 消解一个系统信号（条件自愈：渠道重连 / 凭据恢复 / 损坏被隔离修复）。
 * 同时清掉忽略记录——问题真的没了，下次再发是新事件、该重新提示。
 */
export function clearSystemSignal(id: string): void {
  const had = signals.delete(id);
  dismissed.delete(id); // 问题真没了，重置忽略——下次再发是新事件、该重新提示
  if (had) broadcast();
}

/** 用户忽略一个信号（本地隐藏，不删底层问题）；同 id 再 raise 不复现，直到 clear 自愈后重置。 */
export function dismissSystemSignal(id: string): void {
  if (!signals.has(id)) return;
  dismissed.add(id);
  broadcast();
}

/** 测试用：清空注册表与忽略集、解绑广播器。 */
export function __resetSystemSignalsForTest(): void {
  signals.clear();
  dismissed.clear();
  broadcaster = null;
}
