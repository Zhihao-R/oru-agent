/**
 * 配对码（tech design §6）——桌面出一次性限时码，平台发对了把发送者绑进白名单。
 * 承重性质：一次性（用过即失效）、限时（过期拒）、换发即作废旧码、无码时一律拒。
 * 时钟注入，不依赖真实时间。
 */
import { describe, expect, it } from 'vitest';
import { PairingManager } from '../../electron/main/platform/pairing';

function makeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('PairingManager', () => {
  it('发出的码能被消费一次', () => {
    const clk = makeClock();
    const pm = new PairingManager({ now: clk.now });
    const { code } = pm.issue();
    expect(pm.tryConsume(code)).toBe(true);
  });

  it('一次性：消费过的码再用即失效', () => {
    const clk = makeClock();
    const pm = new PairingManager({ now: clk.now });
    const { code } = pm.issue();
    pm.tryConsume(code);
    expect(pm.tryConsume(code)).toBe(false);
  });

  it('错码拒绝', () => {
    const clk = makeClock();
    const pm = new PairingManager({ now: clk.now });
    pm.issue();
    expect(pm.tryConsume('000000')).toBe(false);
  });

  it('过期码拒绝', () => {
    const clk = makeClock();
    const pm = new PairingManager({ now: clk.now, ttlMs: 5 * 60_000 });
    const { code } = pm.issue();
    clk.advance(5 * 60_000 + 1);
    expect(pm.tryConsume(code)).toBe(false);
  });

  it('换发新码作废旧码', () => {
    const clk = makeClock();
    const pm = new PairingManager({ now: clk.now });
    const { code: old } = pm.issue();
    pm.issue();
    expect(pm.tryConsume(old)).toBe(false);
  });

  it('无活跃码时一律拒', () => {
    const clk = makeClock();
    const pm = new PairingManager({ now: clk.now });
    expect(pm.tryConsume('123456')).toBe(false);
  });

  it('active 反映当前可显示的码与到期时间，消费后清空', () => {
    const clk = makeClock();
    const pm = new PairingManager({ now: clk.now, ttlMs: 60_000 });
    const { code, expiresAt } = pm.issue();
    expect(pm.active).toEqual({ code, expiresAt });
    expect(expiresAt).toBe(1_000 + 60_000);
    pm.tryConsume(code);
    expect(pm.active).toBeNull();
  });

  it('过期后 active 自动呈现为空（不展示死码）', () => {
    const clk = makeClock();
    const pm = new PairingManager({ now: clk.now, ttlMs: 1_000 });
    pm.issue();
    clk.advance(1_001);
    expect(pm.active).toBeNull();
  });
});
