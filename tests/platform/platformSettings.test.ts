/**
 * 平台非密配置访问器——白名单 / 远程默认 agent 读写，落在 Settings.platforms。
 * fail-closed：未配置时白名单为空、远程 agent 为 null。ORU_DIR 范式。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-platsettings-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('platformSettings', () => {
  it('未配置：白名单空、远程 agent null（fail-closed）', async () => {
    const m = await import('../../electron/main/platform/platformSettings');
    expect(await m.loadWhitelist()).toEqual([]);
    expect(await m.resolveRemoteAgentId()).toBeNull();
  });

  it('白名单 set→get 往返，不动其它平台字段', async () => {
    const m = await import('../../electron/main/platform/platformSettings');
    await m.setRemoteAgentId('agent-1');
    await m.saveWhitelist([{ id: 'un_a', platform: 'feishu' }, { id: 'un_b' }]);
    expect(await m.loadWhitelist()).toEqual([{ id: 'un_a', platform: 'feishu' }, { id: 'un_b' }]);
    expect(await m.resolveRemoteAgentId()).toBe('agent-1'); // saveWhitelist 不抹掉 remoteAgentId
  });

  it('迁移：磁盘上旧版裸字符串数组 → 读时归一为 { id } 条目', async () => {
    const m = await import('../../electron/main/platform/platformSettings');
    const store = await import('../../electron/main/projects/store');
    // 直接写入旧版形态（裸字符串），绕过 saveWhitelist 的新形写入
    await store.updateSettings({ platforms: { remoteDefaultAgentId: null, whitelist: ['un_old1', 'un_old2'] as unknown as never } });
    store.__clearCacheForTest(); // 逼 reload 拿磁盘最新
    expect(await m.loadWhitelist()).toEqual([{ id: 'un_old1' }, { id: 'un_old2' }]);
  });

  it('并发 addToWhitelist 不丢条目（RMW 入锁，C1 回归）', async () => {
    const m = await import('../../electron/main/platform/platformSettings');
    await m.saveWhitelist([]); // 清空起点
    // 10 条并发追加：非原子 RMW 会「各读空列表、各写单条、后写覆盖先写」只剩 1 条
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => m.addToWhitelist({ id: `un_c${i}`, platform: 'feishu', source: 'manual' })),
    );
    const ids = (await m.loadWhitelist()).map((e) => e.id).sort();
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => `un_c${i}`).sort());
  });

  it('addToWhitelist 同 id 幂等：不重复、不覆盖已有昵称', async () => {
    const m = await import('../../electron/main/platform/platformSettings');
    await m.saveWhitelist([{ id: 'un_dup', displayName: '张三', platform: 'feishu' }]);
    await m.addToWhitelist({ id: 'un_dup', platform: 'feishu', source: 'manual' }); // 再加同 id
    const list = await m.loadWhitelist();
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe('张三'); // 不被无昵称的手动条目覆盖
  });

  it('backfillWhitelistChatId：只补缺失的 chatId，不覆盖已有、按 id/userId 匹配', async () => {
    const m = await import('../../electron/main/platform/platformSettings');
    await m.saveWhitelist([{ id: 'un_x' }, { id: 'un_y', chatId: 'oc_old' }]);
    await m.backfillWhitelistChatId('un_x', 'ou_x', 'oc_new'); // un_x 缺 → 补
    await m.backfillWhitelistChatId('un_y', 'ou_y', 'oc_should_ignore'); // un_y 已有 → 不动
    const list = await m.loadWhitelist();
    expect(list.find((e) => e.id === 'un_x')?.chatId).toBe('oc_new');
    expect(list.find((e) => e.id === 'un_y')?.chatId).toBe('oc_old'); // 未被覆盖
  });

  it('clearWhitelistForPlatform：只清该平台条目，留其它平台与无平台旧数据', async () => {
    const m = await import('../../electron/main/platform/platformSettings');
    await m.saveWhitelist([
      { id: 'f1', platform: 'feishu' },
      { id: 'd1', platform: 'discord' },
      { id: 'legacy' }, // 无 platform（旧数据）
    ]);
    await m.clearWhitelistForPlatform('feishu');
    const ids = (await m.loadWhitelist()).map((e) => e.id).sort();
    expect(ids).toEqual(['d1', 'legacy']); // 飞书那条清掉，discord 与 legacy 保留
  });

  it('凭证不落 config.json（白名单/agent 可以，但密文不经此）', async () => {
    const m = await import('../../electron/main/platform/platformSettings');
    await m.saveWhitelist([{ id: 'x' }]);
    const config = await fs.readFile(join(ORU_DIR, 'users', 'local-user', 'config.json'), 'utf-8');
    expect(config).toContain('"whitelist"');
    expect(config).not.toMatch(/appSecret|botToken/);
  });
});
