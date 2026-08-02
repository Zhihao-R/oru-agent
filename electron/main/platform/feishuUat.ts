/**
 * 飞书 UAT client + user 身份 docs_ai transport（S5 · user 身份自管）——进程内 user 身份
 * 调用的两件套，取代「user op 每次 spawn lark-cli」（token 原存在 lark-cli 钥匙串，进程内拿不到）。
 *
 *  - getValidUserAccessToken：读 token store（feishuUserToken.ts，独立 0600 文件），
 *    access_token 提前 5min 主动刷新；refresh_token 单次消费——并发刷新必须用同一把
 *    per-app 单飞锁，否则第二个刷新拿已消费的 token 必败并误清。refresh 终态失败
 *    （错误码非 20050 / refresh 本身过期）清 token，逼重新授权；网络异常不清洗牌（往上抛，
 *    transport 映射成 network 故障而不是「需要重新授权」的误导）。
 *  - makeUatDocsAiTransport：Bearer fetch 直调 OAPI（user 身份 SDK 不支持 per-request
 *    user_access_token 注入到 request() 的干净路径，fetch 更可控）；服务端判 token 失效
 *    （99991668/99991677）强制刷新重试一次——对齐上游 uat-client callWithUAT。
 *
 * token 永不出主进程、永不上信封/日志（ envelope 只载服务端回包；Bearer 头不落任何文本）。
 */
import type { FeishuCredential } from './credentialStore';
import { getFeishuCredential } from './credentialStore';
import {
  getUserToken,
  setUserToken,
  clearUserToken,
  tokenStatus,
  type StoredUserToken,
} from './feishuUserToken';
import type { DocsAiTransport, DocsAiTransportResult, LarkApiEnvelope } from './feishuDocsAi';

const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const OPEN_BASE = 'https://open.feishu.cn';

/** refresh token 端点可重试的错误码（服务端瞬时故障）——遇之重试一次，仍败清 token。 */
const REFRESH_TRANSIENT_CODE = 20050;
/** access_token 失效码（无效/过期）——API 调用遇之强制刷新重试一次。 */
const TOKEN_RETRY_CODES: ReadonlySet<number> = new Set([99991668, 99991677]);

// ─────────────────────────── 刷新内核 ───────────────────────────

export interface UatDeps {
  getCredential: () => Promise<FeishuCredential | null>;
  getToken: (appId: string) => Promise<StoredUserToken | null>;
  setToken: (token: StoredUserToken) => Promise<void>;
  clearToken: () => Promise<void>;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** per-app 刷新单飞锁（refresh_token 单次消费，见文件头）。 */
const refreshLocks = new Map<string, Promise<StoredUserToken | null>>();

async function doRefreshToken(deps: UatDeps, cred: FeishuCredential, stored: StoredUserToken): Promise<StoredUserToken | null> {
  const now = deps.now?.() ?? Date.now();
  if (now >= stored.refreshExpiresAt) {
    await deps.clearToken(); // refresh 本身已过期——只能重新授权
    return null;
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    client_id: cred.appId,
    client_secret: cred.appSecret,
  }).toString();
  const callEndpoint = async (): Promise<Record<string, unknown>> => {
    const resp = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return (await resp.json()) as Record<string, unknown>;
  };

  // 网络异常往上抛（不清 token——瞬时故障不该洗牌授权状态）
  let data = await callEndpoint();
  // 飞书 v2 token 端点成功回 code:0；也可能用标准 OAuth 的 error 字段
  const failed = (d: Record<string, unknown>): boolean =>
    (typeof d.code === 'number' && d.code !== 0) || typeof d.error === 'string';
  if (failed(data)) {
    if (data.code === REFRESH_TRANSIENT_CODE) {
      data = await callEndpoint(); // 瞬时故障重试一次
    }
    if (failed(data)) {
      await deps.clearToken(); // 终态失败（已消费/已撤销/未知）——清掉逼重新授权
      return null;
    }
  }
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    // 成功态但没给 access_token（服务端怪异响应）——不清洗牌，按失败回 null
    return null;
  }

  const t = deps.now?.() ?? Date.now();
  const updated: StoredUserToken = {
    ...stored,
    appId: cred.appId,
    accessToken: data.access_token,
    refreshToken: (data.refresh_token as string) ?? stored.refreshToken, // 轮换用新的
    expiresAt: t + ((data.expires_in as number) ?? 7200) * 1000,
    refreshExpiresAt:
      typeof data.refresh_token_expires_in === 'number' ? t + data.refresh_token_expires_in * 1000 : stored.refreshExpiresAt,
    scope: (data.scope as string) ?? stored.scope,
    grantedAt: stored.grantedAt, // 首次授权时刻保留
  };
  await deps.setToken(updated);
  return updated;
}

async function refreshWithLock(deps: UatDeps, cred: FeishuCredential, stored: StoredUserToken): Promise<StoredUserToken | null> {
  const key = cred.appId;
  const existing = refreshLocks.get(key);
  if (existing) {
    // 已有刷新在飞——等它落地后重读 store（可能已轮换好，也可能已清；await 后绝不沿用旧读数）
    await existing;
    return deps.getToken(cred.appId);
  }
  const promise = doRefreshToken(deps, cred, stored);
  refreshLocks.set(key, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(key);
  }
}

/**
 * 拿一个可用的 user access token：valid 直接回；needs_refresh 经单飞锁刷新；
 * 无 token / 刷新失败 → null（调用方映射成「需要重新授权」）。网络异常往上抛。
 */
export async function getValidUserAccessToken(deps: UatDeps): Promise<string | null> {
  const cred = await deps.getCredential();
  if (!cred) return null;
  const stored = await deps.getToken(cred.appId);
  if (!stored) return null;
  const status = tokenStatus(stored, deps.now?.());
  if (status === 'valid') return stored.accessToken;
  if (status === 'expired') {
    await deps.clearToken();
    return null;
  }
  const refreshed = await refreshWithLock(deps, cred, stored);
  if (!refreshed) return null;
  // 并发等待者重读到的可能是刚轮换的新 token——valid 才用，其余一律当需重新授权
  return tokenStatus(refreshed, deps.now?.()) === 'valid' ? refreshed.accessToken : null;
}

/** 强制刷新（服务端判 token 失效后的重试路径）——绕过主动刷新窗口直接刷。 */
export async function forceRefreshUserToken(deps: UatDeps): Promise<string | null> {
  const cred = await deps.getCredential();
  if (!cred) return null;
  const stored = await deps.getToken(cred.appId);
  if (!stored) return null;
  const refreshed = await refreshWithLock(deps, cred, stored);
  if (!refreshed) return null;
  return tokenStatus(refreshed, deps.now?.()) === 'valid' ? refreshed.accessToken : null;
}

// ─────────────────────────── user 身份 docs_ai transport ───────────────────────────

export interface UatTransportDeps {
  getCredential: () => Promise<FeishuCredential | null>;
  /** 主动刷新窗口内拿 token；null = 需授权。 */
  getValidToken: (cred: FeishuCredential) => Promise<string | null>;
  /** 服务端判失效后强制刷新；null = 需授权。 */
  forceRefresh: (cred: FeishuCredential) => Promise<string | null>;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

function isTokenInvalidEnvelope(res: DocsAiTransportResult): boolean {
  return (res.kind === 'ok' || res.kind === 'http') && typeof res.envelope?.code === 'number' && TOKEN_RETRY_CODES.has(res.envelope.code);
}

/**
 * user 身份 transport：Bearer fetch 直调 OAPI。token 失效码 → 强制刷新重试一次；
 * 拿不到 token → no-user-token（内核映射成重新授权指引，对齐 S2 结构化错误）。
 */
export function makeUatDocsAiTransport(deps: UatTransportDeps): DocsAiTransport {
  const fetchFn = deps.fetchFn ?? fetch;

  const doCall = async (
    req: Parameters<DocsAiTransport>[0],
    accessToken: string,
  ): Promise<DocsAiTransportResult> => {
    const query = req.params ? `?${new URLSearchParams(req.params as Record<string, string>).toString()}` : '';
    let resp: Response;
    try {
      resp = await fetchFn(`${OPEN_BASE}${req.path}${query}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      return { kind: 'network', subtype: timeout ? 'timeout' : 'transport', message: e instanceof Error ? e.message : String(e) };
    }
    const text = await resp.text();
    let envelope: LarkApiEnvelope | undefined;
    try {
      envelope = text ? (JSON.parse(text) as LarkApiEnvelope) : undefined;
    } catch {
      envelope = undefined;
    }
    if (!resp.ok) return { kind: 'http', status: resp.status, envelope };
    if (envelope === undefined) {
      return { kind: 'network', subtype: 'transport', message: `invalid JSON response (HTTP ${String(resp.status)})` };
    }
    return { kind: 'ok', envelope };
  };

  return async (req) => {
    const cred = await deps.getCredential();
    if (!cred) return { kind: 'not-configured' };
    let token: string | null;
    try {
      token = await deps.getValidToken(cred);
    } catch (e) {
      return { kind: 'network', subtype: 'transport', message: e instanceof Error ? e.message : String(e) };
    }
    if (!token) return { kind: 'no-user-token' };

    let res = await doCall(req, token);
    if (isTokenInvalidEnvelope(res)) {
      // 服务端判失效（本地窗口还认为 valid 的情况）——强制刷新重试一次（对齐上游 callWithUAT）
      let refreshed: string | null;
      try {
        refreshed = await deps.forceRefresh(cred);
      } catch (e) {
        return { kind: 'network', subtype: 'transport', message: e instanceof Error ? e.message : String(e) };
      }
      if (!refreshed) return { kind: 'no-user-token' };
      res = await doCall(req, refreshed);
    }
    return res;
  };
}

/** 生产默认：credentialStore + token store 真接线。 */
export function makeDefaultUatDocsAiTransport(): DocsAiTransport {
  const deps: UatDeps = {
    getCredential: () => getFeishuCredential(),
    getToken: (appId) => getUserToken(appId),
    setToken: (t) => setUserToken(t),
    clearToken: () => clearUserToken(),
  };
  return makeUatDocsAiTransport({
    getCredential: deps.getCredential,
    getValidToken: (cred) => getValidUserAccessToken({ ...deps, getCredential: async () => cred }),
    forceRefresh: (cred) => forceRefreshUserToken({ ...deps, getCredential: async () => cred }),
  });
}
