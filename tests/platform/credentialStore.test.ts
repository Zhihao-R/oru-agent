/**
 * 平台凭证存储（红线 1）——App Secret / Bot Token 只在主进程、独立文件、永不进 config.json
 * （config.json 会推给渲染进程；凭证绝不能混进去）。hasCredential 给渲染进程查状态（不回传密文）。
 * 文件权限 0600（仅属主可读，纵深防御）。
 *
 * ORU_DIR 范式：顶层设 env + 动态 import（仿 tests/conversations/store.test.ts）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-cred-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('credentialStore — 飞书', () => {
  it('set→get 往返', async () => {
    const m = await import('../../electron/main/platform/credentialStore');
    await m.setFeishuCredential({ appId: 'cli_abc', appSecret: 's3cr3t' });
    expect(await m.getFeishuCredential()).toEqual({ appId: 'cli_abc', appSecret: 's3cr3t' });
  });

  it('hasCredential 反映存在性（不回传密文）', async () => {
    const m = await import('../../electron/main/platform/credentialStore');
    await m.setFeishuCredential({ appId: 'cli_x', appSecret: 'y' });
    expect(await m.hasCredential('feishu')).toBe(true);
    expect(await m.hasCredential('discord')).toBe(false);
  });

  it('clear 后取不到', async () => {
    const m = await import('../../electron/main/platform/credentialStore');
    await m.setFeishuCredential({ appId: 'cli_x', appSecret: 'y' });
    await m.clearCredential('feishu');
    expect(await m.getFeishuCredential()).toBeNull();
  });

  it('凭证文件不是 config.json（与设置物理分离，不会被推给渲染进程）', async () => {
    const m = await import('../../electron/main/platform/credentialStore');
    await m.setFeishuCredential({ appId: 'cli_x', appSecret: 'y' });
    const config = join(ORU_DIR, 'users', 'local-user', 'config.json');
    let configText = '';
    try {
      configText = await fs.readFile(config, 'utf-8');
    } catch {
      /* config 可能尚未建 */
    }
    expect(configText).not.toContain('s3cr3t');
    expect(configText).not.toContain('y');
  });

  it('凭证文件权限 0600（仅属主可读）', async () => {
    const m = await import('../../electron/main/platform/credentialStore');
    await m.setFeishuCredential({ appId: 'cli_x', appSecret: 'y' });
    const credPath = join(ORU_DIR, 'users', 'local-user', 'platform-credentials.json');
    const mode = (await fs.stat(credPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('credentialStore — Discord', () => {
  it('set→get→clear', async () => {
    const m = await import('../../electron/main/platform/credentialStore');
    await m.setDiscordCredential({ botToken: 'tok' });
    expect(await m.getDiscordCredential()).toEqual({ botToken: 'tok' });
    await m.clearCredential('discord');
    expect(await m.getDiscordCredential()).toBeNull();
  });
});
