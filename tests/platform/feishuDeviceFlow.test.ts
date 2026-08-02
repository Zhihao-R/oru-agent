/**
 * 飞书 OAuth device flow（S5 · RFC 8628）——纯 fetch 两步：
 * requestDeviceAuthorization 取 device_code/user_code，pollDeviceToken 轮询到
 * 授权 / 拒绝 / 过期。移植上游 openclaw-lark core/device-flow.ts，收窄为 feishu 单品牌
 * （Oru 只接飞书——lark/custom 域分支不移植）。
 *
 * 承重（必测）：
 * - 发起：端点 accounts.feishu.cn；Basic base64(appId:appSecret)；offline_access 自动补、不重复。
 * - 轮询状态机：pending 继续 / slow_down 退避(+5s,上限60) / access_denied 终态 /
 *   expired_token·invalid_grant 终态 / 未知 error 终态 / 网络异常退避(+1s)继续 /
 *   abort 立即停 / 超 deadline 终态。
 * - token 字段映射默认值（expires_in 7200 / refresh 604800 / 无 refresh_token 时回落）。
 *
 * fetch / sleep / now 全注入，不碰真网络、不真实等待。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  requestDeviceAuthorization,
  pollDeviceToken,
  type DeviceFlowDeps,
} from '../../electron/main/platform/feishuDeviceFlow';

const APP = { appId: 'cli_abc', appSecret: 's3cr3t' };

type FetchLike = DeviceFlowDeps['fetchFn'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 依序回包的假 fetch；调用记录在 calls。 */
function makeFetch(sequence: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchFn: FetchLike = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const item = sequence[Math.min(i++, sequence.length - 1)];
    return typeof item === 'function' ? item() : item;
  }) as NonNullable<FetchLike>;
  return { fetchFn, calls };
}

/** 立即返回的假 sleep + 手动推进的假时钟。 */
function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: (async (ms: number) => {
      now += ms;
    }) as DeviceFlowDeps['sleep'],
  };
}

describe('requestDeviceAuthorization', () => {
  it('POST 到 device_authorization 端点，Basic 头 = base64(appId:appSecret)，body 带 client_id+scope', async () => {
    const { fetchFn, calls } = makeFetch([
      jsonResponse({
        device_code: 'dc-1',
        user_code: 'UC-23',
        verification_uri: 'https://accounts.feishu.cn/oauth/v1/device',
        verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/device?code=UC-23',
        expires_in: 300,
        interval: 3,
      }),
    ]);
    const r = await requestDeviceAuthorization({ ...APP, scope: 'docs:doc' }, { fetchFn });
    expect(r).toEqual({
      deviceCode: 'dc-1',
      userCode: 'UC-23',
      verificationUri: 'https://accounts.feishu.cn/oauth/v1/device',
      verificationUriComplete: 'https://accounts.feishu.cn/oauth/v1/device?code=UC-23',
      expiresIn: 300,
      interval: 3,
    });
    expect(calls[0]!.url).toBe('https://accounts.feishu.cn/oauth/v1/device_authorization');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cli_abc:s3cr3t').toString('base64')}`);
    const body = new URLSearchParams(calls[0]!.init!.body as string);
    expect(body.get('client_id')).toBe('cli_abc');
    expect(body.get('scope')).toBe('docs:doc offline_access'); // 自动补
  });

  it('scope 已含 offline_access 不重复补；空 scope 也能补出', async () => {
    const { fetchFn, calls } = makeFetch([() => jsonResponse({ device_code: 'd', user_code: 'u', verification_uri: 'v' })]);
    await requestDeviceAuthorization({ ...APP, scope: 'a offline_access b' }, { fetchFn });
    expect(new URLSearchParams(calls[0]!.init!.body as string).get('scope')).toBe('a offline_access b');
    await requestDeviceAuthorization({ ...APP, scope: '' }, { fetchFn });
    expect(new URLSearchParams(calls[1]!.init!.body as string).get('scope')).toBe('offline_access');
  });

  it('expires_in / interval 缺省回 240 / 5；verification_uri_complete 缺省回 verification_uri', async () => {
    const { fetchFn } = makeFetch([jsonResponse({ device_code: 'd', user_code: 'u', verification_uri: 'v' })]);
    const r = await requestDeviceAuthorization({ ...APP, scope: '' }, { fetchFn });
    expect(r.expiresIn).toBe(240);
    expect(r.interval).toBe(5);
    expect(r.verificationUriComplete).toBe('v');
  });

  it('服务端回 error → throw（带 error_description），不回半成品', async () => {
    const { fetchFn } = makeFetch([jsonResponse({ error: 'invalid_client', error_description: 'bad client' }, 401)]);
    await expect(requestDeviceAuthorization({ ...APP, scope: '' }, { fetchFn })).rejects.toThrow('bad client');
  });
});

describe('pollDeviceToken 状态机', () => {
  const BASE = { ...APP, deviceCode: 'dc-1', interval: 5, expiresIn: 600 };

  it('pending 若干次后拿到 token → ok + 字段映射', async () => {
    const { fetchFn, calls } = makeFetch([
      jsonResponse({ error: 'authorization_pending' }),
      jsonResponse({ error: 'authorization_pending' }),
      jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 7200, refresh_token_expires_in: 604800, scope: 'docs:doc' }),
    ]);
    const clock = makeClock();
    const r = await pollDeviceToken(BASE, { fetchFn, sleep: clock.sleep, now: clock.now });
    expect(r).toEqual({
      ok: true,
      token: { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200, refreshExpiresIn: 604800, scope: 'docs:doc' },
    });
    // 每次轮询都打 token 端点、带 device_code + client_secret
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token');
    const body = new URLSearchParams(calls[0]!.init!.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(body.get('device_code')).toBe('dc-1');
    expect(body.get('client_secret')).toBe('s3cr3t');
  });

  it('slow_down → 轮询间隔 +5s（可观察：第二次 sleep 走得更久）', async () => {
    const { fetchFn } = makeFetch([
      jsonResponse({ error: 'slow_down' }),
      jsonResponse({ access_token: 'at', refresh_token: 'rt' }),
    ]);
    const clock = makeClock();
    await pollDeviceToken(BASE, { fetchFn, sleep: clock.sleep, now: clock.now });
    expect(clock.now()).toBe(1_000_000 + 5_000 + 10_000); // 5s 首轮 + slow_down 后 10s
  });

  it('access_denied → 终态拒绝', async () => {
    const { fetchFn } = makeFetch([jsonResponse({ error: 'access_denied' })]);
    const r = await pollDeviceToken(BASE, { fetchFn, sleep: makeClock().sleep, now: makeClock().now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('access_denied');
  });

  it('expired_token / invalid_grant → 终态过期', async () => {
    for (const error of ['expired_token', 'invalid_grant']) {
      const { fetchFn } = makeFetch([jsonResponse({ error })]);
      const r = await pollDeviceToken(BASE, { fetchFn, sleep: makeClock().sleep, now: makeClock().now });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('expired_token');
    }
  });

  it('未知 error → 终态（带 error_description）', async () => {
    const { fetchFn } = makeFetch([jsonResponse({ error: 'weird', error_description: 'something odd' })]);
    const r = await pollDeviceToken(BASE, { fetchFn, sleep: makeClock().sleep, now: makeClock().now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('something odd');
  });

  it('网络异常 → 退避继续，不立即失败', async () => {
    let n = 0;
    const fetchFn: NonNullable<FetchLike> = async () => {
      n++;
      if (n < 3) throw new Error('ECONNRESET');
      return jsonResponse({ access_token: 'at', refresh_token: 'rt' });
    };
    const r = await pollDeviceToken(BASE, { fetchFn, sleep: makeClock().sleep, now: makeClock().now });
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
  });

  it('abort → 停止轮询', async () => {
    const { fetchFn } = makeFetch([jsonResponse({ error: 'authorization_pending' })]);
    const controller = new AbortController();
    const clock = makeClock();
    const sleep: DeviceFlowDeps['sleep'] = async (ms, signal) => {
      controller.abort(); // 第一轮等待期间外部取消
      clock.advance(ms);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    };
    const r = await pollDeviceToken({ ...BASE, signal: controller.signal }, { fetchFn, sleep, now: clock.now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('expired_token');
  });

  it('超过 device code 有效期 → 终态过期', async () => {
    const { fetchFn } = makeFetch([jsonResponse({ error: 'authorization_pending' })]);
    const clock = makeClock();
    const r = await pollDeviceToken({ ...BASE, expiresIn: 8 }, { fetchFn, sleep: clock.sleep, now: clock.now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('expired_token');
  });

  it('无 refresh_token → refreshExpiresIn 回落 expiresIn（不可刷新的明示）', async () => {
    const { fetchFn } = makeFetch([jsonResponse({ access_token: 'at', expires_in: 7200 })]);
    const r = await pollDeviceToken(BASE, { fetchFn, sleep: makeClock().sleep, now: makeClock().now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.token.refreshToken).toBe('');
      expect(r.token.refreshExpiresIn).toBe(7200);
    }
  });
});
