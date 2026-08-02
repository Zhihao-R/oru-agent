/**
 * 飞书 OAuth device flow（S5 · RFC 8628）——设置页「飞书用户身份」授权的两步纯 fetch 实现：
 *   1. requestDeviceAuthorization：拿 device_code + user_code + 授权链接；
 *   2. pollDeviceToken：轮询 token 端点，直到用户授权 / 拒绝 / 码过期 / 外部取消。
 *
 * 移植上游 openclaw-lark src/core/device-flow.ts（MIT），收窄为 feishu 单品牌
 * （Oru 只接飞书，lark/custom 域分支不移植）。不用 Lark SDK——这两个 OAuth 端点在 SDK 面之外。
 *
 * fetch / sleep / now 全部可注入（测试瞬时化）；生产默认全局 fetch + 真 sleep。
 * appSecret 只出现在 Authorization 头 / 表单体里，不进日志（本文件不 log 密文）。
 */

export interface DeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number; // 秒
  interval: number; // 建议轮询间隔（秒）
}

export interface DeviceFlowTokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // 秒
  refreshExpiresIn: number; // 秒
  scope: string;
}

export type DeviceFlowResult =
  | { ok: true; token: DeviceFlowTokenData }
  | { ok: false; error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token'; message: string };

export interface DeviceFlowDeps {
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const DEVICE_AUTHORIZATION_URL = 'https://accounts.feishu.cn/oauth/v1/device_authorization';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * 第一步：请求设备授权码。Confidential Client 认证（HTTP Basic = appId:appSecret）。
 * offline_access 自动补进 scope（缺了它响应里没有 refresh_token，token 不可刷新）。
 */
export async function requestDeviceAuthorization(
  params: { appId: string; appSecret: string; scope: string },
  deps: DeviceFlowDeps = {},
): Promise<DeviceAuthResponse> {
  const fetchFn = deps.fetchFn ?? fetch;
  let scope = params.scope;
  if (!scope.includes('offline_access')) {
    scope = scope ? `${scope} offline_access` : 'offline_access';
  }

  const resp = await fetchFn(DEVICE_AUTHORIZATION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${params.appId}:${params.appSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ client_id: params.appId, scope }).toString(),
  });

  const text = await resp.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Device authorization failed: HTTP ${String(resp.status)} – ${text.slice(0, 200)}`);
  }
  if (!resp.ok || data.error) {
    const msg = (data.error_description as string) ?? (data.error as string) ?? 'Unknown error';
    throw new Error(`Device authorization failed: ${msg}`);
  }

  return {
    deviceCode: data.device_code as string,
    userCode: data.user_code as string,
    verificationUri: data.verification_uri as string,
    verificationUriComplete: (data.verification_uri_complete as string) ?? (data.verification_uri as string),
    expiresIn: (data.expires_in as number) ?? 240,
    interval: (data.interval as number) ?? 5,
  };
}

const MAX_POLL_INTERVAL = 60; // slow_down 退避上限（秒）
const MAX_POLL_ATTEMPTS = 200; // 安全上限（远超设备码有效期内的正常轮询数）

/**
 * 第二步：轮询 token 端点。authorization_pending 继续；slow_down 间隔 +5s；
 * access_denied / expired_token / invalid_grant 终态；网络异常退避 +1s 继续。
 * signal 可外部取消（设置页「取消」/ 发起新 flow 顶掉旧 flow）。
 */
export async function pollDeviceToken(
  params: {
    appId: string;
    appSecret: string;
    deviceCode: string;
    interval: number;
    expiresIn: number;
    signal?: AbortSignal;
  },
  deps: DeviceFlowDeps = {},
): Promise<DeviceFlowResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleepFn = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let interval = params.interval;
  const deadline = now() + params.expiresIn * 1000;
  let attempts = 0;

  while (now() < deadline && attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    if (params.signal?.aborted) {
      return { ok: false, error: 'expired_token', message: '授权已取消' };
    }
    try {
      await sleepFn(interval * 1000, params.signal);
    } catch {
      return { ok: false, error: 'expired_token', message: '授权已取消' };
    }

    let data: Record<string, unknown>;
    try {
      const resp = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: params.deviceCode,
          client_id: params.appId,
          client_secret: params.appSecret,
        }).toString(),
      });
      data = (await resp.json()) as Record<string, unknown>;
    } catch {
      // 网络/解析异常：退避 +1s 继续（瞬时故障不该终结授权流程）
      interval = Math.min(interval + 1, MAX_POLL_INTERVAL);
      continue;
    }

    const error = data.error as string | undefined;

    if (!error && data.access_token) {
      const refreshToken = (data.refresh_token as string) ?? '';
      const expiresIn = (data.expires_in as number) ?? 7200;
      // 无 refresh_token（app 未开 refresh 能力）→ 不可刷新，有效期回落 access 同款
      const refreshExpiresIn = refreshToken ? ((data.refresh_token_expires_in as number) ?? 604800) : expiresIn;
      return {
        ok: true,
        token: {
          accessToken: data.access_token as string,
          refreshToken,
          expiresIn,
          refreshExpiresIn,
          scope: (data.scope as string) ?? '',
        },
      };
    }

    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval = Math.min(interval + 5, MAX_POLL_INTERVAL);
      continue;
    }
    if (error === 'access_denied') {
      return { ok: false, error: 'access_denied', message: '用户拒绝了授权' };
    }
    if (error === 'expired_token' || error === 'invalid_grant') {
      return { ok: false, error: 'expired_token', message: '授权码已过期，请重新发起' };
    }
    // 未知 error 按终态处理（不静默死循环）
    return { ok: false, error: 'expired_token', message: (data.error_description as string) ?? error ?? 'Unknown error' };
  }

  return { ok: false, error: 'expired_token', message: '授权超时，请重新发起' };
}
