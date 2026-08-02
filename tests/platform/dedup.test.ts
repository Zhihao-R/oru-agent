/**
 * 消息去重（tech design §4.3，§11 对抗）——平台重投（网络抖 / 重连后重推）同一 messageId
 * 必须只处理一次，否则破坏性操作会执行两遍。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageDedup } from '../../electron/main/platform/dedup';

describe('MessageDedup', () => {
  it('首次出现 admit=true（放行处理）', () => {
    const d = new MessageDedup();
    expect(d.admit('sk1', 'm1')).toBe(true);
  });

  it('同 sessionKey 同 messageId 重投 admit=false（忽略）', () => {
    const d = new MessageDedup();
    d.admit('sk1', 'm1');
    expect(d.admit('sk1', 'm1')).toBe(false);
    expect(d.admit('sk1', 'm1')).toBe(false);
  });

  it('同 messageId 不同 session 互不影响（各自首次都放行）', () => {
    const d = new MessageDedup();
    expect(d.admit('sk1', 'm1')).toBe(true);
    expect(d.admit('sk2', 'm1')).toBe(true);
  });

  it('容量上限淘汰最旧（超过 cap 后最早的条目可被再次 admit）', () => {
    const d = new MessageDedup(2);
    expect(d.admit('sk', 'a')).toBe(true);
    expect(d.admit('sk', 'b')).toBe(true);
    expect(d.admit('sk', 'c')).toBe(true); // 插入 c 淘汰最旧的 a → [b,c]
    expect(d.admit('sk', 'c')).toBe(false); // c 仍在
    expect(d.admit('sk', 'a')).toBe(true); // a 已被淘汰，视为首次
  });
});

describe('MessageDedup 落盘跨重启（S11 · G07）', () => {
  const dir = join(tmpdir(), `oru-test-dedup-${Date.now()}`);
  const path = join(dir, 'sub', 'platform-dedup-feishu.json'); // 子目录不存在→验 safeWriteAsync 自建

  beforeAll(async () => {
    await fs.mkdir(dir, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** admit 触发 fire-and-forget 回写；轮询等落盘完成（写链是异步的）。 */
  async function waitForFile(p: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (await fs.stat(p).then(() => true).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`dedup 文件未落盘：${p}`);
  }

  it('重启后（新实例从盘加载）同一条重投仍被挡', async () => {
    const d1 = new MessageDedup(500, path);
    expect(d1.admit('sk1', 'm1')).toBe(true);
    await waitForFile(path);

    // 模拟重启：全新实例只从盘加载，不共享内存
    const d2 = new MessageDedup(500, path);
    expect(d2.admit('sk1', 'm1')).toBe(false); // 跨重启仍去重
    expect(d2.admit('sk1', 'm2')).toBe(true); // 未见过的照常放行
  });

  it('落盘损坏 / 无文件 → 降级空集起步，不抛', () => {
    const missing = join(dir, 'nope', 'dedup.json');
    const d = new MessageDedup(500, missing); // 文件不存在
    expect(d.admit('sk', 'x')).toBe(true); // 空集起步，正常放行
  });
});
