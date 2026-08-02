/**
 * 飞书用户授权状态机（S5 · 设置页「飞书用户身份」入口后端）——device flow 的生命周期管理：
 *
 *   idle ──start──▶ pending（展示授权链接 / user_code）──轮询──▶ authorized
 *                      │                                        ▲
 *                      ├──轮询──▶ denied（用户拒绝）              │ setToken（0600 文件）
 *                      ├──轮询──▶ expired（码过期 / 取消）
 *                      └──request 抛错──▶ error
 *   cancel / revoke / 新 start ──▶ idle / 顶替（旧 flow 的迟到结果一律作废）
 *
 * 承重纪律：
 *  - 单活跃 flow：任何时刻最多一个轮询在飞；start 顶替、cancel/revoke 中止都靠代次
 *    （generation）+ AbortController 双保险——await 后重检代次，绝不沿用 await 前的身份
 *    （仓规：await 后重检共享状态）。
 *  - token 只经 setToken 落独立 0600 文件（feishuUserToken.ts），状态结构里绝无密文
 *    （state 会被广播给渲染进程——链接/user_code 非密文可上屏，token 不行）。
 *  - user_info 抓取是 best-effort：抓不到不阻断授权（昵称留空，界面回落）。
 */
import type { FeishuUserAuthState } from '@shared/platform/message';
import type { FeishuCredential } from './credentialStore';
import { getFeishuCredential } from './credentialStore';
import type { DeviceAuthResponse, DeviceFlowResult } from './feishuDeviceFlow';
import { requestDeviceAuthorization, pollDeviceToken } from './feishuDeviceFlow';
import type { StoredUserToken } from './feishuUserToken';
import { setUserToken, clearUserToken } from './feishuUserToken';
import { getRequiredScopes } from './feishuScope';

export interface UserAuthFlowDeps {
  getCredential: () => Promise<FeishuCredential | null>;
  /** device flow 申请的 scope 并集（生产 = feishuScope 单一来源，与「一键开通权限」同一份）。 */
  loadScopes: () => Promise<readonly string[]>;
  requestDeviceAuthorization: (params: { appId: string; appSecret: string; scope: string }) => Promise<DeviceAuthResponse>;
  pollDeviceToken: (params: {
    appId: string;
    appSecret: string;
    deviceCode: string;
    interval: number;
    expiresIn: number;
    signal?: AbortSignal;
  }) => Promise<DeviceFlowResult>;
  /** 拿 user_info（open_id / 昵称）；失败回 null（不阻断授权）。 */
  fetchUserInfo: (accessToken: string) => Promise<{ openId: string; name?: string } | null>;
  setToken: (token: StoredUserToken) => Promise<void>;
  clearToken: () => Promise<void>;
  now?: () => number;
}

export interface UserAuthFlow {
  /** 发起授权：顶替进行中的旧 flow；返回到达 pending（或 error）后的状态。 */
  start: () => Promise<FeishuUserAuthState>;
  cancel: () => Promise<FeishuUserAuthState>;
  /** 解除授权：清 token + 回 idle（进行中的 flow 一并顶掉）。 */
  revoke: () => Promise<FeishuUserAuthState>;
  getState: () => FeishuUserAuthState;
  /** 状态迁移推送（WS 广播挂这里）；返回退订函数（成对清理）。 */
  subscribe: (listener: (state: FeishuUserAuthState) => void) => () => void;
}

export function makeUserAuthFlow(deps: UserAuthFlowDeps): UserAuthFlow {
  let state: FeishuUserAuthState = { phase: 'idle' };
  let generation = 0;
  let active: AbortController | null = null;
  const listeners = new Set<(state: FeishuUserAuthState) => void>();

  const setState = (s: FeishuUserAuthState): void => {
    state = s;
    for (const l of listeners) l(s);
  };

  /** 顶掉进行中的 flow：代次 +1（迟到结果作废）+ abort（轮询尽快停）。 */
  const supersede = (): { gen: number; controller: AbortController } => {
    generation++;
    active?.abort();
    active = new AbortController();
    return { gen: generation, controller: active };
  };

  return {
    async start() {
      const { gen, controller } = supersede();
      const cred = await deps.getCredential();
      if (gen !== generation) return state; // await 后重检：已被更新的 flow 顶替
      if (!cred) {
        setState({ phase: 'error', message: '飞书应用凭证未配置——先完成飞书应用配置' });
        return state;
      }

      let auth: DeviceAuthResponse;
      try {
        const scope = (await deps.loadScopes()).join(' ');
        if (gen !== generation) return state;
        auth = await deps.requestDeviceAuthorization({ appId: cred.appId, appSecret: cred.appSecret, scope });
      } catch (e) {
        if (gen !== generation) return state;
        setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
        return state;
      }
      if (gen !== generation) return state;

      const now = deps.now?.() ?? Date.now();
      setState({
        phase: 'pending',
        verificationUri: auth.verificationUri,
        verificationUriComplete: auth.verificationUriComplete,
        userCode: auth.userCode,
        expiresAt: now + auth.expiresIn * 1000,
      });

      // 后台轮询（不阻塞 start 返回）——结果到达前可能已被顶替/取消，每个 await 后都重检代次
      void (async () => {
        const r = await deps.pollDeviceToken({
          appId: cred.appId,
          appSecret: cred.appSecret,
          deviceCode: auth.deviceCode,
          interval: auth.interval,
          expiresIn: auth.expiresIn,
          signal: controller.signal,
        });
        if (gen !== generation) return;
        if (!r.ok) {
          setState(r.error === 'access_denied' ? { phase: 'denied' } : { phase: 'expired', message: r.message });
          return;
        }
        const info = await deps.fetchUserInfo(r.token.accessToken).catch(() => null);
        if (gen !== generation) return;
        const grantedAt = deps.now?.() ?? Date.now();
        await deps.setToken({
          appId: cred.appId,
          userOpenId: info?.openId ?? '',
          ...(info?.name ? { userName: info.name } : {}),
          accessToken: r.token.accessToken,
          refreshToken: r.token.refreshToken,
          expiresAt: grantedAt + r.token.expiresIn * 1000,
          refreshExpiresAt: grantedAt + r.token.refreshExpiresIn * 1000,
          scope: r.token.scope,
          grantedAt,
        });
        if (gen !== generation) return;
        setState({
          phase: 'authorized',
          ...(info?.name ? { userName: info.name } : {}),
          scope: r.token.scope,
          grantedAt,
        });
      })().catch((e) => {
        // 轮询链路非预期异常（device flow 自身已把可预见失败归进 DeviceFlowResult）——
        // 如实落 error 态，不让 flow 停在永远 pending
        if (gen !== generation) return;
        setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      });
      return state;
    },

    async cancel() {
      supersede();
      setState({ phase: 'idle' });
      return state;
    },

    async revoke() {
      supersede();
      await deps.clearToken();
      setState({ phase: 'idle' });
      return state;
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 生产：拿 user_info（best-effort；非 2xx / 解析失败 / 无 open_id 都回 null）。 */
async function fetchUserInfoProd(accessToken: string): Promise<{ openId: string; name?: string } | null> {
  const resp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { code?: number; data?: { open_id?: string; name?: string } };
  const openId = data.data?.open_id;
  if (data.code !== 0 || !openId) return null;
  return { openId, ...(data.data?.name ? { name: data.data.name } : {}) };
}

/** 生产单例（ws handlers 与 index.ts 广播接线共用）。 */
export const userAuthFlow = makeUserAuthFlow({
  getCredential: () => getFeishuCredential(),
  loadScopes: () => getRequiredScopes(),
  requestDeviceAuthorization: (params) => requestDeviceAuthorization(params),
  pollDeviceToken: (params) => pollDeviceToken(params),
  fetchUserInfo: fetchUserInfoProd,
  setToken: (t) => setUserToken(t),
  clearToken: () => clearUserToken(),
});
