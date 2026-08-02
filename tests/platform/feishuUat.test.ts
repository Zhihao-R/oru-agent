/**
 * 飞书 UAT client + user 身份 docs_ai transport（S5）——进程内 user 身份调用的两件套：
 *  - getValidUserAccessToken：读 token store，提前 5min 主动刷新（per-app 单飞锁——
 *    refresh_token 单次消费，并发刷新会用已消费的 token 必败）；refresh 终态失败清 token。
 *  - makeUatDocsAiTransport：Bearer fetch 调 OAPI；服务端判 token 失效（99991668/99991677）
 *    强制刷新重试一次。
 *
 * 承重（必测）：
 *  - 刷新：端点/表单体形状、token 轮换落盘（grantedAt/scope 保留）、20050 重试一次、
 *    其余错误码清 token、refresh 已过期不调端点直接清、并发只刷一次。
 *  - transport：无凭证 not-configured、无 token no-user-token、Bearer 头/URL/query/JSON body、
 *    非 2xx http、fetch 异常 network、token 失效码强制刷新重试一次。
 *
 * 依赖全注入（credential / token store / fetch / now），不碰真网络与真凭证文件。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FeishuCredential } from '../../electron/main/platform/credentialStore';
import type { StoredUserToken } from '../../electron/main/platform/feishuUserToken';
import {
  getValidUserAccessToken,
  makeUatDocsAiTransport,
  type UatDeps,
  type UatTransportDeps,
} from '../../electron/main/platform/feishuUat';

const CRED: FeishuCredential = { appId: 'cli_abc', appSecret: 's3cr3t' };
const NOW = 1_000_000_000;

function storedToken(overrides: Partial<StoredUserToken> = {}): StoredUserToken {
  return {
    appId: CRED.appId,
    userOpenId: 'ou_u1',
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: NOW + 7200_000,
    refreshExpiresAt: NOW + 30 * 24 * 3600_000,
    scope: 'docs:doc offline_access',
    grantedAt: NOW - 1000,
    ...overrides,
  };
}

type FetchFn = NonNullable<UatDeps['fetchFn']>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 可编程的 UAT 依赖：内存 token + 依序回包的 fetch；写操作对齐生产实现的无条件 setToken/clearToken。 */
function makeDeps(opts: {
  token?: StoredUserToken | null;
  fetchSequence?: Array<Response | (() => Response | Promise<Response>)>;
  now?: () => number;
}) {
  let token = opts.token === undefined ? storedToken() : opts.token;
  // 无条件覆盖/清空——与 feishuUat.ts 的 UatDeps（setToken/clearToken）一致，并记录调用
  const setToken = vi.fn(async (next: StoredUserToken) => {
    token = next;
  });
  const clearToken = vi.fn(async () => {
    token = null;
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const seq = opts.fetchSequence ?? [];
  const fetchFn: FetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const item = seq[Math.min(i++, Math.max(seq.length - 1, 0))];
    if (!item) throw new Error('unexpected fetch');
    return typeof item === 'function' ? item() : item;
  }) as FetchFn;
  const deps: UatDeps = {
    getCredential: async () => CRED,
    getToken: async () => token,
    setToken,
    clearToken,
    fetchFn,
    now: opts.now ?? (() => NOW),
  };
  return {
    deps,
    calls,
    setToken,
    clearToken,
    fetchFn,
    /** 测试直改盘上 token（模拟外部 revoke / 重授权 / 别人轮换）。 */
    setTokenDirect: (t: StoredUserToken | null) => {
      token = t;
    },
  };
}

// ─────────────────────────── getValidUserAccessToken ───────────────────────────

describe('getValidUserAccessToken', () => {
  it('无凭证 → null（不可能发生但防御：凭证先没的竞态）', async () => {
    const { deps } = makeDeps({});
    const r = await getValidUserAccessToken({ ...deps, getCredential: async () => null });
    expect(r).toBeNull();
  });

  it('无 token → null（需授权）', async () => {
    const { deps } = makeDeps({ token: null });
    expect(await getValidUserAccessToken(deps)).toBeNull();
  });

  it('valid → 直接回 accessToken，不调刷新端点', async () => {
    const { deps, calls } = makeDeps({});
    expect(await getValidUserAccessToken(deps)).toBe('at-old');
    expect(calls).toHaveLength(0);
  });

  it('needs_refresh → 调刷新端点（表单形状对）、轮换落盘、回新 token', async () => {
    const { deps, calls, setToken } = makeDeps({
      token: storedToken({ expiresAt: NOW + 60_000 }), // 1 分钟后过期 → needs_refresh
      fetchSequence: [
        jsonResponse({ code: 0, access_token: 'at-new', refresh_token: 'rt-new', expires_in: 7200, refresh_token_expires_in: 604800 }),
      ],
    });
    expect(await getValidUserAccessToken(deps)).toBe('at-new');
    expect(calls[0]!.url).toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token');
    const body = new URLSearchParams(calls[0]!.init!.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-old');
    expect(body.get('client_id')).toBe('cli_abc');
    expect(body.get('client_secret')).toBe('s3cr3t');
    expect(setToken).toHaveBeenCalledTimes(1);
    const saved = setToken.mock.calls[0]![0];
    expect(saved.accessToken).toBe('at-new');
    expect(saved.refreshToken).toBe('rt-new'); // 轮换用新 refresh_token
    expect(saved.grantedAt).toBe(NOW - 1000); // 首次授权时刻保留
    expect(saved.scope).toBe('docs:doc offline_access'); // 响应没给 scope 回落旧的
    expect(saved.expiresAt).toBe(NOW + 7200_000);
  });

  it('refresh 回 20050（服务端瞬时故障）→ 重试一次；成则轮换', async () => {
    const { deps, calls } = makeDeps({
      token: storedToken({ expiresAt: NOW - 1 }),
      fetchSequence: [
        jsonResponse({ code: 20050 }),
        jsonResponse({ code: 0, access_token: 'at-new', refresh_token: 'rt-new' }),
      ],
    });
    expect(await getValidUserAccessToken(deps)).toBe('at-new');
    expect(calls).toHaveLength(2);
  });

  it('refresh 20050 重试仍败 → 清 token + null', async () => {
    const { deps, clearToken } = makeDeps({
      token: storedToken({ expiresAt: NOW - 1 }),
      fetchSequence: [() => jsonResponse({ code: 20050 })],
    });
    expect(await getValidUserAccessToken(deps)).toBeNull();
    expect(clearToken).toHaveBeenCalledTimes(1);
  });

  it('refresh 回其他错误码（如 20073 已消费）→ 清 token + null（重新授权）', async () => {
    const { deps, clearToken } = makeDeps({
      token: storedToken({ expiresAt: NOW - 1 }),
      fetchSequence: [jsonResponse({ code: 20073 })],
    });
    expect(await getValidUserAccessToken(deps)).toBeNull();
    expect(clearToken).toHaveBeenCalledTimes(1);
  });

  it('refresh_token 本身已过期 → 不调端点，直接清 + null', async () => {
    const { deps, calls, clearToken } = makeDeps({
      token: storedToken({ expiresAt: NOW - 1, refreshExpiresAt: NOW - 1 }),
    });
    expect(await getValidUserAccessToken(deps)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(clearToken).toHaveBeenCalledTimes(1);
  });

  it('并发两个 needs_refresh → 刷新端点只打一次（单飞锁，refresh_token 单次消费）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, calls } = makeDeps({
      token: storedToken({ expiresAt: NOW - 1 }),
      fetchSequence: [
        async () => {
          await gate;
          return jsonResponse({ code: 0, access_token: 'at-new', refresh_token: 'rt-new' });
        },
      ],
    });
    const p1 = getValidUserAccessToken(deps);
    const p2 = getValidUserAccessToken(deps);
    release();
    expect(await p1).toBe('at-new');
    expect(await p2).toBe('at-new');
    expect(calls).toHaveLength(1);
  });
});

// ─────────────────────────── makeUatDocsAiTransport ───────────────────────────

function makeTransportDeps(opts: Parameters<typeof makeDeps>[0], tokenOverride?: string | null) {
  const { deps, calls, fetchFn } = makeDeps(opts);
  const tdeps: UatTransportDeps = {
    getCredential: deps.getCredential,
    getValidToken: async () => tokenOverride === undefined ? 'at-old' : tokenOverride,
    forceRefresh: vi.fn(async () => 'at-new'),
    fetchFn,
  };
  return { tdeps, calls, deps };
}

describe('makeUatDocsAiTransport', () => {
  const REQ = { method: 'POST' as const, path: '/open-apis/docs_ai/v1/documents', body: { a: 1 }, params: { x: 'y' }, timeoutMs: 5000 };

  it('无凭证 → not-configured', async () => {
    const { tdeps } = makeTransportDeps({});
    const transport = makeUatDocsAiTransport({ ...tdeps, getCredential: async () => null });
    expect(await transport(REQ)).toEqual({ kind: 'not-configured' });
  });

  it('无 user token → no-user-token（内核映射成重新授权指引）', async () => {
    const { tdeps } = makeTransportDeps({}, null);
    const transport = makeUatDocsAiTransport(tdeps);
    expect(await transport(REQ)).toEqual({ kind: 'no-user-token' });
  });

  it('正常调用：Bearer 头、URL=open.feishu.cn+path、query、JSON body', async () => {
    const { tdeps, calls } = makeTransportDeps({ fetchSequence: [jsonResponse({ code: 0, data: { ok: 1 } })] });
    const transport = makeUatDocsAiTransport(tdeps);
    const r = await transport(REQ);
    expect(r).toEqual({ kind: 'ok', envelope: { code: 0, data: { ok: 1 } } });
    expect(calls[0]!.url).toBe('https://open.feishu.cn/open-apis/docs_ai/v1/documents?x=y');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer at-old');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ a: 1 });
  });

  it('HTTP 非 2xx 带信封 → http（交内核分类）', async () => {
    const { tdeps } = makeTransportDeps({ fetchSequence: [jsonResponse({ code: 99991672, msg: 'no scope' }, 403)] });
    const transport = makeUatDocsAiTransport(tdeps);
    const r = await transport(REQ);
    expect(r.kind).toBe('http');
    if (r.kind === 'http') {
      expect(r.status).toBe(403);
      expect(r.envelope?.code).toBe(99991672);
    }
  });

  it('fetch 抛异常 → network/transport；AbortError → network/timeout', async () => {
    const { tdeps } = makeTransportDeps({ fetchSequence: [() => Promise.reject(new Error('ECONNRESET'))] });
    const transport = makeUatDocsAiTransport(tdeps);
    const r = await transport(REQ);
    expect(r.kind).toBe('network');
    if (r.kind === 'network') expect(r.subtype).toBe('transport');

    const abortDeps = makeTransportDeps({
      fetchSequence: [() => Promise.reject(new DOMException('The operation timed out', 'TimeoutError'))],
    });
    const r2 = makeUatDocsAiTransport(abortDeps.tdeps)(REQ);
    expect((await r2).kind).toBe('network');
  });

  it('服务端判 token 失效（99991677）→ 强制刷新 + 重试一次（新 Bearer）', async () => {
    const { tdeps, calls } = makeTransportDeps({
      fetchSequence: [
        jsonResponse({ code: 99991677, msg: 'token expired' }),
        jsonResponse({ code: 0, data: { ok: 1 } }),
      ],
    });
    const transport = makeUatDocsAiTransport(tdeps);
    const r = await transport(REQ);
    expect(r).toEqual({ kind: 'ok', envelope: { code: 0, data: { ok: 1 } } });
    expect(tdeps.forceRefresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer at-new');
  });

  it('强制刷新拿不到 token → no-user-token', async () => {
    const { tdeps } = makeTransportDeps({ fetchSequence: [jsonResponse({ code: 99991668, msg: 'invalid' })] });
    const transport = makeUatDocsAiTransport({ ...tdeps, forceRefresh: async () => null });
    expect(await transport(REQ)).toEqual({ kind: 'no-user-token' });
  });

  it('重试后仍失效 → 不再重试，信封交内核分类（authentication → needsReauth）', async () => {
    const { tdeps, calls } = makeTransportDeps({
      fetchSequence: [() => jsonResponse({ code: 99991677, msg: 'expired' })],
    });
    const transport = makeUatDocsAiTransport(tdeps);
    const r = await transport(REQ);
    expect(tdeps.forceRefresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2); // 只重试一次
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.envelope.code).toBe(99991677);
  });
});
