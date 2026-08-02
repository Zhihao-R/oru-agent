/**
 * 在飞回合打标登记表（连发合并 S1）——「无产出才撤」的单一判定出处 + 撤起链 origins custody。
 *
 * 两条承重口径（docs/plans/2026-08-01-飞书体验优化三件套.md S1）：
 * 1. **干净判定单点**：「无产出」= 无 chat.delta 且无 chat.toolCall，由装配层在事件流上打标
 *    （markLiveTurnProduced），steeringQueue 的三态裁决与本表之外只读（isLiveTurnRestartable）。
 * 2. **撤起不交手还**：被撤回合已消费的 origins 不进 handback，由本表 custody 过户给重起回合
 *    （supersedeLiveTurn）——表情逐条清与渠道回发随新回合的 turnInputs 照旧。
 *
 * token 归属（与 steeringQueue runToken 同源）：每条目归属一个回合 token。被撤回合的迟到收尾
 * （finally endLiveTurn / 流尾声 markProduced / drain noteOrigin）凭旧 token 一律 no-op，
 * 不得动新回合的条目——撤起时 supersedeLiveTurn 先把条目改属新 token，正是为了挡住它们。
 */
import type { TriggerOrigin } from '@shared/types';

/** 撤起窗口：回合起跑后这么短时间内且无产出才允许撤起重跑（PM 拍板 1s，可调常量）。 */
export const RESTART_WINDOW_MS = 1000;

type LiveTurnEntry = {
  /** 归属凭据：只认这个 token 的写入；撤起过户时翻新。 */
  token: number;
  /** 本回合起跑时刻（撤起窗口的锚，begin 时重置——链式连撤按新回合重新计窗）。 */
  startedAt: number;
  /** 已流过 delta / tool_use——「有产出」后撤起会留痕（半截 bubble），判不可撤。 */
  produced: boolean;
  /** 已消费未交付的 origins custody：撤起链过户，回合正常终结（交付/清表情完毕）才销条。 */
  origins: TriggerOrigin[];
};

const entries = new Map<string, LiveTurnEntry>();

/** origin 同一性：平台 + 聊天 + 平台消息 id 三元组（custody 去重与装配层 turnInputs 去重共用）。 */
export const sameTriggerOrigin = (a: TriggerOrigin, b: TriggerOrigin): boolean =>
  a.platform === b.platform &&
  a.chatId === b.chatId &&
  a.platformMessageId === b.platformMessageId;

/**
 * 回合起跑（装配层 runOneTurn 首行，早于一切 await）：开条 / 重置产出标记与窗口锚。
 * origins 继承上一条目——撤起链上被撤回合留下的 custody 由重起回合继续承担；
 * 自然终结的回合已先销条（endLiveTurn），不会把旧 origins 带进无关回合。
 */
export function beginLiveTurn(key: string, token: number): void {
  const prev = entries.get(key);
  entries.set(key, { token, startedAt: Date.now(), produced: false, origins: prev?.origins ?? [] });
}

/** 装配层事件流打标：本对话流过 chat.delta / chat.toolCall 即「有产出」。旧 token no-op。 */
export function markLiveTurnProduced(key: string, token: number): void {
  const e = entries.get(key);
  if (e && e.token === token) e.produced = true;
}

/** 装配层消费一个 origin（起回合 seed / restart 批 / 间隙插入 drain）：入 custody。按三元组去重。 */
export function noteLiveTurnOrigin(key: string, token: number, origin: TriggerOrigin): void {
  const e = entries.get(key);
  if (!e || e.token !== token) return;
  if (!e.origins.some((o) => sameTriggerOrigin(o, origin))) e.origins.push(origin);
}

/**
 * 撤起过户（入口在 restart 决策后、首个 await 前同步调）：条目改属新 token——
 * 被撤回合的迟到收尾凭旧 token 删不到它；新消息 origin 就地入账（新回合尚未起跑、
 * 无人代记——若它在起跑前又被连撤，下一条 supersede 仍能把这条 origin 接着过户下去）。
 */
export function supersedeLiveTurn(key: string, newToken: number, newOrigin?: TriggerOrigin): void {
  const e = entries.get(key);
  if (!e) return;
  e.token = newToken;
  if (newOrigin && !e.origins.some((o) => sameTriggerOrigin(o, newOrigin))) e.origins.push(newOrigin);
}

/** 读 custody 中的 origins（装配层开回合时继承进 turnInputs——回发与清表情的对象）。 */
export function peekLiveTurnOrigins(key: string): TriggerOrigin[] {
  return [...(entries.get(key)?.origins ?? [])];
}

/** 回合末销条（装配层 finally）：token 相符才删——被撤回合的迟到收尾不得删新回合的条。 */
export function endLiveTurn(key: string, token: number): void {
  const e = entries.get(key);
  if (e && e.token === token) entries.delete(key);
}

/**
 * 本回合是否已被撤起接替（条目已过户给更新的 token）：被撤回合收尾据此判「custody origins
 * 的表情归新回合清」，不抢清（否则渠道「处理中」表情在新回合跑完前提前消失，像没受理）。
 */
export function isLiveTurnSuperseded(key: string, token: number): boolean {
  const e = entries.get(key);
  return !!e && e.token !== token;
}

/**
 * 对话级终止的 custody 兜底（brake / 撤起后落盘失败）：无条件销条并返回 custody origins——
 * 调用方负责清这些 origin 的「处理中」表情。闸已释放、回合永不起跑时，custody 里的渠道
 * origin 无人交付也无人在场清，表情会永久悬挂（S1 review · I2）。
 */
export function drainLiveTurn(key: string): TriggerOrigin[] {
  const e = entries.get(key);
  entries.delete(key);
  return e?.origins ?? [];
}

/** 队列三态裁决只读：窗口内且无产出才可撤起重跑。无条目（未起跑 / 已终）一律不可撤（安全方向）。 */
export function isLiveTurnRestartable(key: string): boolean {
  const e = entries.get(key);
  return !!e && !e.produced && Date.now() - e.startedAt <= RESTART_WINDOW_MS;
}
