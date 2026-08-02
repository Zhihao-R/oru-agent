/**
 * 飞书 user token 存储（S5 · user 身份自管）——OAuth user_access_token / refresh_token
 * 存独立 0600 文件 feishu-user-token.json（对齐 credentialStore 红线 1：只在主进程、
 * 绝不进 config.json；渲染进程只能查「是否已授权」布尔 + 昵称等元数据，拿不到密文）。
 *
 * 承重（必测）：
 * - set→get 往返；clear 后取不到。
 * - 文件权限 0600；密文不落 config.json。
 * - appId 错位即失效：token 只在其签发的应用下有意义，换应用后 get 必须回 null
 *   （clearCredential 连带清是运维面，读面再兜一层纵深防御）。
 * - tokenStatus 三态：valid（>5min）/ needs_refresh（access 将过期但 refresh 有效）/ expired。
 *
 * ORU_DIR 范式：顶层设 env + 动态 import（仿 credentialStore.test.ts）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-uat-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

const TOKEN = {
  appId: 'cli_abc',
  userOpenId: 'ou_user1',
  userName: '小测',
  accessToken: 'u-access-token-1',
  refreshToken: 'u-refresh-token-1',
  expiresAt: Date.now() + 7200_000,
  refreshExpiresAt: Date.now() + 30 * 24 * 3600_000,
  scope: 'docs:doc offline_access',
  grantedAt: Date.now(),
};

describe('feishuUserToken — 存取', () => {
  it('set→get 往返', async () => {
    const m = await import('../../electron/main/platform/feishuUserToken');
    await m.setUserToken(TOKEN);
    expect(await m.getUserToken('cli_abc')).toEqual(TOKEN);
  });

  it('clear 后取不到', async () => {
    const m = await import('../../electron/main/platform/feishuUserToken');
    await m.setUserToken(TOKEN);
    await m.clearUserToken();
    expect(await m.getUserToken('cli_abc')).toBeNull();
  });

  it('appId 错位 → null（换应用后旧 token 绝不可用）', async () => {
    const m = await import('../../electron/main/platform/feishuUserToken');
    await m.setUserToken(TOKEN);
    expect(await m.getUserToken('cli_other')).toBeNull();
  });

  it('hasUserToken 反映存在性（含 appId 匹配）', async () => {
    const m = await import('../../electron/main/platform/feishuUserToken');
    await m.setUserToken(TOKEN);
    expect(await m.hasUserToken('cli_abc')).toBe(true);
    expect(await m.hasUserToken('cli_other')).toBe(false);
    await m.clearUserToken();
    expect(await m.hasUserToken('cli_abc')).toBe(false);
  });

  it('token 文件权限 0600（仅属主可读）', async () => {
    const m = await import('../../electron/main/platform/feishuUserToken');
    await m.setUserToken(TOKEN);
    const p = join(ORU_DIR, 'users', 'local-user', 'feishu-user-token.json');
    expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
  });

  it('密文不落 config.json（config 会推给渲染进程）', async () => {
    const m = await import('../../electron/main/platform/feishuUserToken');
    await m.setUserToken(TOKEN);
    let configText = '';
    try {
      configText = await fs.readFile(join(ORU_DIR, 'users', 'local-user', 'config.json'), 'utf-8');
    } catch {
      /* config 可能尚未建 */
    }
    expect(configText).not.toContain('u-access-token-1');
    expect(configText).not.toContain('u-refresh-token-1');
  });
});

describe('feishuUserToken — tokenStatus 三态', () => {
  it('access 距过期 >5min → valid', async () => {
    const { tokenStatus } = await import('../../electron/main/platform/feishuUserToken');
    const now = Date.now();
    expect(tokenStatus({ ...TOKEN, expiresAt: now + 10 * 60_000 }, now)).toBe('valid');
  });
  it('access 将过期（≤5min）但 refresh 有效 → needs_refresh', async () => {
    const { tokenStatus } = await import('../../electron/main/platform/feishuUserToken');
    const now = Date.now();
    expect(tokenStatus({ ...TOKEN, expiresAt: now + 4 * 60_000 }, now)).toBe('needs_refresh');
    expect(tokenStatus({ ...TOKEN, expiresAt: now - 1000 }, now)).toBe('needs_refresh');
  });
  it('refresh 也过期 → expired', async () => {
    const { tokenStatus } = await import('../../electron/main/platform/feishuUserToken');
    const now = Date.now();
    expect(tokenStatus({ ...TOKEN, expiresAt: now - 1000, refreshExpiresAt: now - 1 }, now)).toBe('expired');
  });
});

// 注：原「条件写（CAS，refreshToken 为因果凭据）」describe 块随设计演进移除——
// feishuUserToken.ts 的写接口已收敛为无条件 setUserToken/clearUserToken，CAS 防竞态的承重
// 已转移至 feishuUat.ts 的 per-app 单飞锁（refreshWithLock：existing→重读），对应并发承重
// 在 tests/platform/feishuUat.test.ts「并发两个 needs_refresh → 刷新端点只打一次」覆盖。
// 死测试（引用生产已不存在的 rotateUserTokenIfCurrent/clearUserTokenIfCurrent）删除收尾。
