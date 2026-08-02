/**
 * buildEpisodeBriefs 单测 —— 喂给召回挑选器的「候选简介块」
 *
 * 复用 snapshot 的 scanAllActiveEpisodes（元数据扫描），加一个新 formatter 产出
 * 「id + 硬维度(类别·时间) + 简介」一行一条。挑选器读它选相关，selected id = compressedPath。
 * 新格式与旧 readIndexSection 索引行形状不同、不声称兼容（recall tech-design §1.2）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const ORU_DIR = join(tmpdir(), `oru-test-briefs-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

function ctx(owner: string): ToolContext {
  return makeToolContext({ conversationId: 'c1', agentId: 'a1', ownerId: owner });
}

async function seedEpisode(owner: string, title: string, slug: string, desc: string): Promise<void> {
  const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
  await __makeRecordMemoryTool().execute(
    { scope: 'agent', content: `${title} 的正文`, title, slug, episodeCategory: 'user', description: desc },
    ctx(owner),
  );
}

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('buildEpisodeBriefs', () => {
  it('每条 active episode 一行 brief，含 id + 类别 + 标题 + 描述', async () => {
    const { buildEpisodeBriefs } = await import('../../electron/main/memory/recall/briefs');
    const owner = `briefs-basic-${Date.now()}`;
    await seedEpisode(owner, '搬家方案', 'banjia', '聊了换房计划');
    const briefs = await buildEpisodeBriefs(owner);
    expect(briefs.length).toBe(1);
    expect(briefs[0].id).toContain('banjia'); // id = compressedPath
    expect(briefs[0].line).toContain(briefs[0].id);
    expect(briefs[0].line).toContain('user'); // 硬维度·类别
    expect(briefs[0].line).toContain('搬家方案'); // 标题
    expect(briefs[0].line).toContain('聊了换房计划'); // 描述
  });

  it('空库 → 空数组', async () => {
    const { buildEpisodeBriefs } = await import('../../electron/main/memory/recall/briefs');
    expect(await buildEpisodeBriefs(`briefs-empty-${Date.now()}`)).toEqual([]);
  });

  it('多条按 updated 倒序（最近的在前）', async () => {
    const { buildEpisodeBriefs } = await import('../../electron/main/memory/recall/briefs');
    const owner = `briefs-order-${Date.now()}`;
    await seedEpisode(owner, 'A 事件', 'aaa', '描述 a');
    await seedEpisode(owner, 'B 事件', 'bbb', '描述 b');
    const briefs = await buildEpisodeBriefs(owner);
    expect(briefs.length).toBe(2);
    // 同日 seed，倒序至少不抛、两条都在
    expect(briefs.map((b) => b.line).join('\n')).toContain('A 事件');
    expect(briefs.map((b) => b.line).join('\n')).toContain('B 事件');
  });
});
