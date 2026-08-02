/**
 * 飞书用户授权状态机（S5 · 设置页「飞书用户身份」入口后端）——device flow 的生命周期管理：
 * 发起（顶替旧 flow）→ pending（展示链接/user_code）→ 轮询 → authorized / denied / expired / error；
 * cancel / revoke 回 idle。
 *
 * 承重（必测）：
 *  - 无凭证 → error，不发起请求。
 *  - start → pending（带 verificationUri/userCode/expiresAt），scope 来自 loadScopes 并集。
 *  - 轮询成功 → setToken（字段映射 + grantedAt）+ authorized 态；昵称 best-effort（抓不到也授权成功）。
 *  - access_denied → denied；expired → expired；request 抛错 → error；都不写 token。
 *  - 顶替：旧 flow 被新 flow / cancel 顶掉后，其迟到结果一律作废（await 后重检代次）。
 *  - revoke → 清 token + idle。
 *  - subscribe：每次状态迁移都推。
 *
 * 依赖全注入（凭证 / device flow 两步 / user_info / token store / now），不碰真网络。
 */
import { describe, it, expect, vi } from 'vitest';
import type { FeishuCredential } from '../../electron/main/platform/credentialStore';
import type { StoredUserToken } from '../../electron/main/platform/feishuUserToken';
import type { DeviceAuthResponse, DeviceFlowResult } from '../../electron/main/platform/feishuDeviceFlow';
import { makeUserAuthFlow, type UserAuthFlowDeps } from '../../electron/main/platform/feishuUserAuth';

const CRED: FeishuCredential = { appId: 'cli_abc', appSecret: 's3cr3t' };
const NOW = 1_000_000_000;

const DEVICE_AUTH: DeviceAuthResponse = {
  deviceCode: 'dc-1',
  userCode: 'UC-23',
  verificationUri: 'https://accounts.feishu.cn/oauth/v1/device',
  verificationUriComplete: 'https://accounts.feishu.cn/oauth/v1/device?code=UC-23',
  expiresIn: 300,
  interval: 5,
};

const TOKEN_OK: DeviceFlowResult = {
  ok: true,
  token: { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200, refreshExpiresIn: 604800, scope: 'docs:doc offline_access' },
};

function makeDeps(opts: {
  credential?: FeishuCredential | null;
  pollResult?: DeviceFlowResult | (() => Promise<DeviceFlowResult>);
  requestError?: Error;
  userInfo?: { openId: string; name?: string } | null;
}) {
  const setToken = vi.fn(async (_t: StoredUserToken) => {});
  const clearToken = vi.fn(async () => {});
  const pollDeviceToken = vi.fn<UserAuthFlowDeps['pollDeviceToken']>(async () =>
    typeof opts.pollResult === 'function' ? opts.pollResult() : (opts.pollResult ?? TOKEN_OK),
  );
  const requestDeviceAuthorization = vi.fn<UserAuthFlowDeps['requestDeviceAuthorization']>(async () => {
    if (opts.requestError) throw opts.requestError;
    return DEVICE_AUTH;
  });
  const deps: UserAuthFlowDeps = {
    getCredential: async () => (opts.credential === undefined ? CRED : opts.credential),
    loadScopes: async () => ['docs:doc', 'im:message'],
    requestDeviceAuthorization,
    pollDeviceToken,
    fetchUserInfo: async () => (opts.userInfo === undefined ? { openId: 'ou_u1', name: '小测' } : opts.userInfo),
    setToken,
    clearToken,
    now: () => NOW,
  };
  return { deps, setToken, clearToken, pollDeviceToken, requestDeviceAuthorization };
}

describe('userAuthFlow 状态机', () => {
  it('无凭证 → error（不发起 device authorization）', async () => {
    const { deps, requestDeviceAuthorization } = makeDeps({ credential: null });
    const flow = makeUserAuthFlow(deps);
    const s = await flow.start();
    expect(s.phase).toBe('error');
    expect(requestDeviceAuthorization).not.toHaveBeenCalled();
  });

  it('start → pending：链接 / user_code / expiresAt 齐全，scope 来自 loadScopes 并集', async () => {
    const { deps, requestDeviceAuthorization, pollDeviceToken } = makeDeps({
      pollResult: () => new Promise<DeviceFlowResult>(() => {}), // 挂住：停在 pending
    });
    const flow = makeUserAuthFlow(deps);
    const s = await flow.start();
    expect(s.phase).toBe('pending');
    if (s.phase !== 'pending') return;
    expect(s.verificationUriComplete).toBe(DEVICE_AUTH.verificationUriComplete);
    expect(s.userCode).toBe('UC-23');
    expect(s.expiresAt).toBe(NOW + 300_000);
    expect(requestDeviceAuthorization).toHaveBeenCalledWith({
      appId: 'cli_abc',
      appSecret: 's3cr3t',
      scope: 'docs:doc im:message',
    });
    expect(pollDeviceToken).toHaveBeenCalledOnce(); // 后台轮询已起
  });

  it('轮询成功 → 写 token（字段映射 + grantedAt）→ authorized（含昵称/scope）', async () => {
    const { deps, setToken } = makeDeps({});
    const flow = makeUserAuthFlow(deps);
    const events: string[] = [];
    flow.subscribe((s) => events.push(s.phase));
    await flow.start();
    await vi.waitFor(() => expect(flow.getState().phase).toBe('authorized'));
    expect(events).toEqual(['pending', 'authorized']);
    expect(setToken).toHaveBeenCalledTimes(1);
    expect(setToken.mock.calls[0]![0]).toEqual({
      appId: 'cli_abc',
      userOpenId: 'ou_u1',
      userName: '小测',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: NOW + 7200_000,
      refreshExpiresAt: NOW + 604800_000,
      scope: 'docs:doc offline_access',
      grantedAt: NOW,
    });
    const s = flow.getState();
    if (s.phase !== 'authorized') throw new Error('unreachable');
    expect(s.userName).toBe('小测');
    expect(s.scope).toBe('docs:doc offline_access');
  });

  it('user_info 抓不到 → 授权仍成功（昵称留空，token 照写）', async () => {
    const { deps, setToken } = makeDeps({ userInfo: null });
    const flow = makeUserAuthFlow(deps);
    await flow.start();
    await vi.waitFor(() => expect(flow.getState().phase).toBe('authorized'));
    expect(setToken).toHaveBeenCalledTimes(1);
    expect(setToken.mock.calls[0]![0].userName).toBeUndefined();
  });

  it('access_denied → denied，不写 token', async () => {
    const { deps, setToken } = makeDeps({ pollResult: { ok: false, error: 'access_denied', message: '用户拒绝了授权' } });
    const flow = makeUserAuthFlow(deps);
    await flow.start();
    await vi.waitFor(() => expect(flow.getState().phase).toBe('denied'));
    expect(setToken).not.toHaveBeenCalled();
  });

  it('expired → expired（带服务端 message），不写 token', async () => {
    const { deps, setToken } = makeDeps({ pollResult: { ok: false, error: 'expired_token', message: '授权码已过期，请重新发起' } });
    const flow = makeUserAuthFlow(deps);
    await flow.start();
    await vi.waitFor(() => expect(flow.getState().phase).toBe('expired'));
    expect(setToken).not.toHaveBeenCalled();
  });

  it('request 抛错 → error（带 message）', async () => {
    const { deps } = makeDeps({ requestError: new Error('Device authorization failed: bad client') });
    const flow = makeUserAuthFlow(deps);
    const s = await flow.start();
    expect(s.phase).toBe('error');
    if (s.phase === 'error') expect(s.message).toContain('bad client');
  });

  it('cancel → idle；旧轮询的迟到成功结果作废（不写 token、不迁 authorized）', async () => {
    let resolvePoll!: (r: DeviceFlowResult) => void;
    const { deps, setToken, pollDeviceToken } = makeDeps({
      pollResult: () => new Promise<DeviceFlowResult>((r) => (resolvePoll = r)),
    });
    const flow = makeUserAuthFlow(deps);
    await flow.start();
    await flow.cancel();
    expect(flow.getState().phase).toBe('idle');
    // 取消后旧轮询才回包——必须作废
    resolvePoll(TOKEN_OK);
    await Promise.resolve();
    await Promise.resolve();
    expect(flow.getState().phase).toBe('idle');
    expect(setToken).not.toHaveBeenCalled();
    // 取消时向轮询传了 abort signal
    expect(pollDeviceToken.mock.calls[0]![0].signal?.aborted).toBe(true);
  });

  it('新 start 顶替进行中的旧 flow：旧结果作废', async () => {
    let resolveOld!: (r: DeviceFlowResult) => void;
    let call = 0;
    const { deps, setToken } = makeDeps({
      pollResult: () =>
        new Promise<DeviceFlowResult>((r) => {
          call++;
          if (call === 1) resolveOld = r;
          // 第二次挂住：停在新 flow 的 pending
        }),
    });
    const flow = makeUserAuthFlow(deps);
    await flow.start();
    await flow.start(); // 顶替
    resolveOld(TOKEN_OK); // 旧 flow 的迟到成功——作废
    await Promise.resolve();
    await Promise.resolve();
    expect(flow.getState().phase).toBe('pending');
    expect(setToken).not.toHaveBeenCalled();
  });

  it('revoke → 清 token + idle（进行中的 flow 也被顶掉）', async () => {
    const { deps, clearToken } = makeDeps({
      pollResult: () => new Promise<DeviceFlowResult>(() => {}),
    });
    const flow = makeUserAuthFlow(deps);
    await flow.start();
    await flow.revoke();
    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(flow.getState().phase).toBe('idle');
  });
});
