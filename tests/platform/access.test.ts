/**
 * 入站访问决策（tech design §6 + 红线 3 fail-closed）——gateway 第一关：
 * 白名单内 → 放行；命中活跃配对码 → 绑定；否则 deny（gateway 据此回「未认证」引导，限频）。
 * 白名单匹配优先 union_id（userIdAlt），换 bot 仍认得你。
 */
import { describe, expect, it } from 'vitest';
import { decideAccess, stableId, isWhitelisted } from '../../electron/main/platform/access';
import type { MessageEvent, SessionSource } from '@shared/platform/message';
import type { WhitelistEntry } from '@shared/types';

const msg = (text: string, over: Partial<SessionSource> = {}): MessageEvent => ({
  text,
  messageId: 'm1',
  source: { platform: 'feishu', chatId: 'oc', chatType: 'dm', userId: 'ou_1', raw: {}, ...over },
});

/** 从 id 列表造白名单条目（成员判定只看 id，其余字段不影响放行判定）。 */
const wl = (...ids: string[]): WhitelistEntry[] => ids.map((id) => ({ id }));

/** 假配对器：固定一个正确码，tryConsume 一次性。 */
function fakePairing(correct: string | null) {
  let code = correct;
  return {
    tryConsume(input: string) {
      if (code !== null && input === code) {
        code = null;
        return true;
      }
      return false;
    },
  };
}

describe('stableId — 白名单稳定 ID 优先 union_id', () => {
  it('有 userIdAlt 用它', () => {
    expect(stableId({ platform: 'feishu', chatId: 'c', chatType: 'dm', userId: 'ou', userIdAlt: 'un', raw: {} })).toBe('un');
  });
  it('无 userIdAlt 降级 userId', () => {
    expect(stableId({ platform: 'feishu', chatId: 'c', chatType: 'dm', userId: 'ou', raw: {} })).toBe('ou');
  });
});

describe('decideAccess — fail-closed', () => {
  it('空白名单 + 无配对码 → deny', () => {
    const d = decideAccess(msg('hello'), [], fakePairing(null));
    expect(d.kind).toBe('deny');
  });

  it('白名单内（按 userId）→ 放行', () => {
    const d = decideAccess(msg('hello'), wl('ou_1'), fakePairing(null));
    expect(d.kind).toBe('admit');
  });

  it('白名单匹配优先 union_id：名单存 union_id，消息带 userIdAlt → 放行', () => {
    const d = decideAccess(msg('hi', { userId: 'ou_changed', userIdAlt: 'un_stable' }), wl('un_stable'), fakePairing(null));
    expect(d.kind).toBe('admit');
  });

  it('非白名单 + 发对配对码 → 绑定（返回稳定 ID 供加名单）', () => {
    const d = decideAccess(msg('123456', { userIdAlt: 'un_stable' }), [], fakePairing('123456'));
    expect(d).toEqual({ kind: 'bind', stableId: 'un_stable' });
  });

  it('配对码两侧空白容错', () => {
    const d = decideAccess(msg('  123456 \n'), [], fakePairing('123456'));
    expect(d.kind).toBe('bind');
  });

  it('非白名单 + 错码 → deny（与普通消息同决策，不泄露码对不对）', () => {
    const d = decideAccess(msg('999999'), [], fakePairing('123456'));
    expect(d.kind).toBe('deny');
  });

  it('已在白名单者发配对码 → 直接放行，不重复绑定 / 不消费码', () => {
    const pairing = fakePairing('123456');
    const d = decideAccess(msg('123456', { userId: 'ou_1' }), wl('ou_1'), pairing);
    expect(d.kind).toBe('admit');
    // 码未被消费：陌生人之后仍能用它绑定
    expect(pairing.tryConsume('123456')).toBe(true);
  });
});

describe('isWhitelisted — 成员判定按 entry.id（stableId 或裸 userId 命中即放行）', () => {
  it('命中 stableId', () => {
    expect(isWhitelisted(wl('un_1'), 'un_1', 'ou_1')).toBe(true);
  });
  it('stableId 不中、裸 userId 命中（union_id 过渡期降级）', () => {
    expect(isWhitelisted(wl('ou_1'), 'un_1', 'ou_1')).toBe(true);
  });
  it('都不中 → false', () => {
    expect(isWhitelisted(wl('un_other'), 'un_1', 'ou_1')).toBe(false);
  });
  it('空名单 → false', () => {
    expect(isWhitelisted([], 'un_1', 'ou_1')).toBe(false);
  });
});
