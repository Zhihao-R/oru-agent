// ⚠️ 严禁在本文件顶部静态 import 任何会读 process.env.ORU_DIR 的模块
// （runtime/paths.ts 在 module load 时 freeze ORU_DIR；本文件全部用 await import 动态加载）
// 参考：electron/main/__smoke_isolate__.ts 的同款保护模式
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-avatar-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

describe('Agent.avatarPath persistence', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    const { __clearCacheForTest } = await import('../../electron/main/agent/store/agents');
    __clearCacheForTest();
  });

  it('rehydrate 补 avatarPath 为 null（老数据无此字段）', async () => {
    const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
    const agent = await ensureDefaultAgent();
    expect(agent.avatarPath).toBe(null);
  });

  it('updateAgent 能写入 avatarPath，重新 load 后保留', async () => {
    const { ensureDefaultAgent, updateAgent, getAgent, __clearCacheForTest } = await import(
      '../../electron/main/agent/store/agents'
    );
    const agent = await ensureDefaultAgent();
    await updateAgent(agent.id, { avatarPath: '/tmp/avatar.png' });
    __clearCacheForTest();
    const reloaded = await getAgent(agent.id);
    expect(reloaded.avatarPath).toBe('/tmp/avatar.png');
  });

  it('saveAgentAvatar 写入 base64 PNG 到正确路径', async () => {
    const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
    const { saveAgentAvatar } = await import('../../electron/main/agent/store/avatar');
    const { avatarsDir } = await import('../../electron/main/runtime/paths');
    const { getCurrentOwnerId } = await import('../../electron/main/identity/getCurrentOwnerId');

    const agent = await ensureDefaultAgent();
    const ownerId = getCurrentOwnerId();
    // 1×1 PNG（最小有效 PNG）
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const filePath = await saveAgentAvatar(ownerId, agent.id, base64);
    expect(filePath.startsWith(avatarsDir(ownerId))).toBe(true);
    expect(filePath.endsWith('.png')).toBe(true);
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('saveAgentAvatar 空字符串抛 AVATAR_EMPTY', async () => {
    const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
    const { saveAgentAvatar, AvatarUploadError } = await import('../../electron/main/agent/store/avatar');
    const { getCurrentOwnerId } = await import('../../electron/main/identity/getCurrentOwnerId');
    const agent = await ensureDefaultAgent();
    const ownerId = getCurrentOwnerId();
    await expect(saveAgentAvatar(ownerId, agent.id, '')).rejects.toThrow(AvatarUploadError);
    await expect(saveAgentAvatar(ownerId, agent.id, '')).rejects.toMatchObject({ code: 'AVATAR_EMPTY' });
  });

  it('saveAgentAvatar 超过 8MB 抛 AVATAR_TOO_LARGE', async () => {
    const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
    const { saveAgentAvatar, AvatarUploadError } = await import('../../electron/main/agent/store/avatar');
    const { getCurrentOwnerId } = await import('../../electron/main/identity/getCurrentOwnerId');
    const agent = await ensureDefaultAgent();
    const ownerId = getCurrentOwnerId();
    const huge = 'A'.repeat(8 * 1024 * 1024 + 1);
    await expect(saveAgentAvatar(ownerId, agent.id, huge)).rejects.toThrow(AvatarUploadError);
    await expect(saveAgentAvatar(ownerId, agent.id, huge)).rejects.toMatchObject({ code: 'AVATAR_TOO_LARGE' });
  });

  it('saveAgentAvatar 非 PNG 数据抛 AVATAR_NOT_PNG', async () => {
    const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
    const { saveAgentAvatar, AvatarUploadError } = await import('../../electron/main/agent/store/avatar');
    const { getCurrentOwnerId } = await import('../../electron/main/identity/getCurrentOwnerId');
    const agent = await ensureDefaultAgent();
    const ownerId = getCurrentOwnerId();
    // 这是 valid base64（"hello world"），但不是 PNG
    const notPng = Buffer.from('hello world').toString('base64');
    await expect(saveAgentAvatar(ownerId, agent.id, notPng)).rejects.toThrow(AvatarUploadError);
    await expect(saveAgentAvatar(ownerId, agent.id, notPng)).rejects.toMatchObject({ code: 'AVATAR_NOT_PNG' });
  });
});
