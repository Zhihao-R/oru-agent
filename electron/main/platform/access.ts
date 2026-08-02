/**
 * 入站访问决策（tech design §6，PRD 红线 3 fail-closed）——gateway 第一关的纯决策：
 * 白名单内放行；否则尝试配对码绑定；都不成立则 deny——gateway 据此回一句「未认证」引导（限频）。
 * （原设计对陌生人零回应以不泄露 bot 存在；PM 拍板改为给引导：飞书里能私聊到 bot 的本就是同组织
 * 加了它的人，暴露面有限，而「首次发消息石沉大海」的体验代价更实。仍不泄露「配对码对不对」防爆破。）
 *
 * 副作用（把条目写白名单、回「绑定成功」/「未认证」）由 gateway 执行——本函数只产出决策，
 * 唯一的状态变更是配对成功时消费掉一次性码（经注入的 pairing）。
 */
import type { MessageEvent, SessionSource } from '@shared/platform/message';
import type { WhitelistEntry } from '@shared/types';

/** 成员判定：条目 id 命中 stableId 或裸 userId 即在白名单（§6 降级路径，见 decideAccess 注释）。 */
export function isWhitelisted(whitelist: readonly WhitelistEntry[], id: string, userId: string): boolean {
  return whitelist.some((w) => w.id === id || w.id === userId);
}

/** 白名单稳定 ID：优先 union_id（换 bot 仍稳定），取不到降级 userId（§6 降级）。 */
export function stableId(s: SessionSource): string {
  return s.userIdAlt ?? s.userId;
}

export type AccessDecision =
  | { kind: 'admit' }
  | { kind: 'bind'; stableId: string }
  | { kind: 'deny' }; // 未白名单且非有效配对码——gateway 据此回「未认证」引导（限频；曾为静默，PRD 红线 3 已调整）

export function decideAccess(
  e: MessageEvent,
  whitelist: readonly WhitelistEntry[],
  pairing: { tryConsume(code: string): boolean },
): AccessDecision {
  const id = stableId(e.source);
  // 白名单优先：已绑定者直接放行，绝不因其恰好发了配对码而重复绑定 / 消费码。
  // 同时认 stableId 与裸 userId：覆盖「绑定时无 union_id（存了 open_id），之后应用补了
  // contact scope、消息开始带 union_id」的过渡——此时 stableId 变了，靠裸 userId 兜住不被锁死
  // （§6 降级路径；fail-closed 系统里把已绑用户锁在门外比多认一个 ID 更糟）。
  if (isWhitelisted(whitelist, id, e.source.userId)) {
    return { kind: 'admit' };
  }
  if (pairing.tryConsume(e.text.trim())) {
    return { kind: 'bind', stableId: id };
  }
  // 错码 / 失效码 / 普通消息一律走这里——回同一句「未认证」，不泄露「码对不对」（防爆破回声）。
  return { kind: 'deny' };
}
