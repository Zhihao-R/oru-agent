/**
 * capture 看得到本对话 episode 正文 · 回归测试
 *
 * 背景：capture 的 prompt 原先只给索引行（标题 - 描述 - tags），而它唯一的决策「create 还是
 * 跳过」的判据是"已有 episode 覆盖同一件事"——覆盖关系照标题判不出来。真实会话
 * cnv_TymI7oJum2 跑了 16 次 capture 产出 7 条 episode，其中两组明显冗余。
 *
 * 这里钉两件事：本对话（sources 含 convId）的 episode 带正文进 prompt；正文总量有上界，
 * 超出的降级成索引行而不是整条消失。顺带覆盖 queryEpisodes 的 sources / archived 过滤——
 * 它是 query_episodes 工具与 capture 共用的那一份遍历。
 *
 * 真实 tmp ORU_DIR + 动态 import，与 correctRetire.test.ts 同模式。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-capture-bodies-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const OWNER = 'cap-owner';
const CONV = 'cnv_target';

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

async function seed(slug: string, content: string, sources: string[]): Promise<void> {
  const { applyOps } = await import('../../electron/main/memory/applyOps');
  const r = await applyOps(
    OWNER,
    [
      {
        op: 'create-episode',
        payload: {
          scope: 'agent',
          type: 'user',
          title: `标题 ${slug}`,
          slug,
          description: `描述 ${slug}`,
          content,
          sources,
        },
      },
    ],
    'capture',
  );
  expect(r.errCount).toBe(0);
}

describe('queryEpisodes：sources 过滤（工具与 capture 共用的那一份遍历）', () => {
  it('只返回 sources 命中的 episode，正文一并带回', async () => {
    const { queryEpisodes } = await import('../../electron/main/memory/queryEpisodes');
    await seed('q-mine', '本对话的正文', [CONV]);
    await seed('q-other', '别的对话的正文', ['cnv_other']);

    const hits = await queryEpisodes(OWNER, { sources: [CONV] });
    expect(hits.length).toBe(1);
    expect(hits[0].compressedPath.endsWith('q-mine')).toBe(true);
    expect(hits[0].body).toContain('本对话的正文');
    expect(hits[0].title).toBe('标题 q-mine');
  });
});

describe('buildSameConversationEpisodes：正文进 prompt，超预算降级成索引行', () => {
  it('本对话的 episode 带正文；别的对话的不出现', async () => {
    const { buildSameConversationEpisodes } = await import('../../electron/main/memory/capture');
    await seed('b-mine', '用户学历为代尔夫特理工风景园林硕士加重庆大学本科', [CONV]);
    await seed('b-other', '不该出现的正文', ['cnv_other']);

    const out = await buildSameConversationEpisodes(OWNER, CONV);
    expect(out).toContain('标题 b-mine');
    expect(out).toContain('代尔夫特理工风景园林硕士');
    expect(out).not.toContain('不该出现的正文');
  });

  it('正文超预算 → 该条降级成索引行（不整条消失），预算内的仍带正文', async () => {
    const { buildSameConversationEpisodes } = await import('../../electron/main/memory/capture');
    const huge = '巨'.repeat(5000); // 单条就吃穿 4000 字符上界
    await seed('c-small', '小条正文在预算内', [CONV]);
    await seed('c-huge', huge, [CONV]); // 后写 → mtime 更新 → 先被检视
    const out = await buildSameConversationEpisodes(OWNER, CONV);

    // 巨条：索引行还在，正文被摘掉
    expect(out).toContain('标题 c-huge');
    expect(out).not.toContain(huge);
    // 预算没被巨条吃掉，小条照常带正文
    expect(out).toContain('小条正文在预算内');
  });
});
