/**
 * 出站重发内核（理想架构 S05 · error-retry「送达」拍板口径）——
 * 「只有能保证恢复不产生重复后果的失败才自动处理」落到出站：
 *
 *  - classifySendFailure：失败三态——transient（平台明确拒绝且瞬时：429/连接未建立，重发无双发风险）、
 *    unknown（结果未知：超时/连接中断/5xx，请求可能已送达——盲重发即双发）、
 *    permanent（明确永久：鉴权/参数错，重发注定再败）。
 *  - sendWithRetry：transient 退避重发一次；unknown 仅在幂等（平台按幂等键去重）时才重发；
 *    permanent 从不重发。
 */
import { describe, expect, it } from 'vitest';
import { classifySendFailure, sendWithRetry } from '../../electron/main/platform/outboundRetry';
import type { SendResult } from '@shared/platform/message';

describe('classifySendFailure — 失败三态', () => {
  it('429 / rate limit → transient（平台明确拒收，重发无双发风险）', () => {
    expect(classifySendFailure(new Error('429 Too Many Requests'))).toBe('transient');
    expect(classifySendFailure(new Error('rate limit exceeded'))).toBe('transient');
  });

  it('连接未建立（ECONNREFUSED / EAI_AGAIN）→ transient（请求根本没发出去）', () => {
    expect(classifySendFailure(new Error('connect ECONNREFUSED 1.2.3.4:443'))).toBe('transient');
    expect(classifySendFailure(new Error('getaddrinfo EAI_AGAIN open.feishu.cn'))).toBe('transient');
  });

  it('超时 / 连接中断 → unknown（请求可能已送达，盲重发即双发）', () => {
    expect(classifySendFailure(new Error('ETIMEDOUT'))).toBe('unknown');
    expect(classifySendFailure(new Error('timeout of 30000ms exceeded'))).toBe('unknown');
    expect(classifySendFailure(new Error('read ECONNRESET'))).toBe('unknown');
    expect(classifySendFailure(new Error('socket hang up'))).toBe('unknown');
  });

  it('HTTP 响应码分类：429 transient、5xx unknown、其余 4xx permanent', () => {
    const withStatus = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
    expect(classifySendFailure(withStatus(429))).toBe('transient');
    expect(classifySendFailure(withStatus(500))).toBe('unknown');
    expect(classifySendFailure(withStatus(502))).toBe('unknown');
    expect(classifySendFailure(withStatus(400))).toBe('permanent');
    expect(classifySendFailure(withStatus(401))).toBe('permanent');
  });

  it('鉴权 / 参数等无法归类的错误 → permanent（不猜、不重发）', () => {
    expect(classifySendFailure(new Error('invalid app_secret'))).toBe('permanent');
    expect(classifySendFailure(new Error('content format of the post type is incorrect'))).toBe('permanent');
  });
});

describe('sendWithRetry — 按失败三态决定重发', () => {
  /** 造按脚本依次吐结果的 sendOnce，记录调用次数与退避次数。 */
  function scripted(results: SendResult[]) {
    let calls = 0;
    let backoffs = 0;
    const sendOnce = async (): Promise<SendResult> => results[calls++] ?? { ok: false, error: '脚本用尽', failure: 'permanent' };
    const backoff = async () => void backoffs++;
    return { sendOnce, backoff, calls: () => calls, backoffs: () => backoffs };
  }

  it('一次成功 → 不退避不重发', async () => {
    const s = scripted([{ ok: true, messageId: 'm1' }]);
    const res = await sendWithRetry(s.sendOnce, { idempotent: false, backoff: s.backoff });
    expect(res).toEqual({ ok: true, messageId: 'm1' });
    expect(s.calls()).toBe(1);
    expect(s.backoffs()).toBe(0);
  });

  it('transient → 退避后重发一次，成功', async () => {
    const s = scripted([{ ok: false, error: '429', failure: 'transient' }, { ok: true, messageId: 'm2' }]);
    const res = await sendWithRetry(s.sendOnce, { idempotent: false, backoff: s.backoff });
    expect(res).toEqual({ ok: true, messageId: 'm2' });
    expect(s.backoffs()).toBe(1);
  });

  it('transient 重发仍失败 → 如实返回，不无限重试', async () => {
    const s = scripted([
      { ok: false, error: '429', failure: 'transient' },
      { ok: false, error: '429', failure: 'transient' },
    ]);
    const res = await sendWithRetry(s.sendOnce, { idempotent: false, backoff: s.backoff });
    expect(res.ok).toBe(false);
    expect(s.calls()).toBe(2);
  });

  it('unknown + 非幂等 → 不重发（防双发的回归：Discord 无幂等键，结果未知一律交出去）', async () => {
    const s = scripted([{ ok: false, error: 'ETIMEDOUT', failure: 'unknown' }]);
    const res = await sendWithRetry(s.sendOnce, { idempotent: false, backoff: s.backoff });
    expect(res.ok).toBe(false);
    expect(res.failure).toBe('unknown');
    expect(s.calls()).toBe(1);
    expect(s.backoffs()).toBe(0);
  });

  it('unknown + 幂等 → 重发一次（平台按幂等键去重，重发安全）', async () => {
    const s = scripted([{ ok: false, error: 'ETIMEDOUT', failure: 'unknown' }, { ok: true, messageId: 'm3' }]);
    const res = await sendWithRetry(s.sendOnce, { idempotent: true, backoff: s.backoff });
    expect(res).toEqual({ ok: true, messageId: 'm3' });
    expect(s.backoffs()).toBe(1);
  });

  it('permanent → 从不重发', async () => {
    const s = scripted([{ ok: false, error: 'invalid app_secret', failure: 'permanent' }]);
    const res = await sendWithRetry(s.sendOnce, { idempotent: true, backoff: s.backoff });
    expect(res.ok).toBe(false);
    expect(s.calls()).toBe(1);
  });
});
