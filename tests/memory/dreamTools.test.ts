/**
 * dream v2 新增/扩展工具的单元测试
 *
 * 覆盖 Step 1（读工具）：
 *   - query_episodes 的 sources 过滤
 *   - read_conversation 按 convId 读对话片段
 * 以及 Step 2（dream-origin 写工具）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const ORU_DIR = join(tmpdir(), `oru-test-dreamtools-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'dream-tools-owner';

function ctx(extras?: Partial<ToolContext>): ToolContext {
  return makeToolContext({ conversationId: 'conv-1', agentId: 'agent-1', ownerId: OWNER, ...extras });
}

/**
 * 直接往磁盘写一条 episode fixture——用真实的 stringifyFrontmatter（gray-matter），
 * 让 frontmatter 的数组字段（sources/tags）落成生产同款 block 格式，而非手拼 inline。
 */
async function writeEpisode(
  relDir: string,
  slug: string,
  fm: Record<string, unknown>,
  body = '正文',
): Promise<void> {
  const { memoryRoot } = await import('../../electron/main/memory/paths');
  const { stringifyFrontmatter } = await import('../../electron/main/fs/frontmatter');
  const dir = join(memoryRoot(OWNER), relDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${slug}.md`), stringifyFrontmatter(fm, body), 'utf-8');
}

describe('query_episodes — sources 过滤', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
    await writeEpisode('agents/twin/episodes', '2026-06-01-a', {
      type: 'agent',
      status: 'active',
      title: '标题A',
      description: '描述A',
      sources: ['cnv_a'],
    });
    await writeEpisode('agents/twin/episodes', '2026-06-01-b', {
      type: 'agent',
      status: 'active',
      title: '标题B',
      description: '描述B',
      sources: ['cnv_b'],
    });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('只返回 sources 命中的 episode', async () => {
    const { __makeQueryEpisodesTool } = await import('../../electron/main/memory/tools');
    const r = await __makeQueryEpisodesTool().execute({ sources: ['cnv_a'] }, ctx());
    expect(r.text).toContain('标题A');
    expect(r.text).not.toContain('标题B');
  });

  it('OR 命中——sources 数组任一匹配即返回', async () => {
    const { __makeQueryEpisodesTool } = await import('../../electron/main/memory/tools');
    const r = await __makeQueryEpisodesTool().execute({ sources: ['cnv_a', 'cnv_zzz'] }, ctx());
    expect(r.text).toContain('标题A');
  });

  it('sources 不命中返回未找到', async () => {
    const { __makeQueryEpisodesTool } = await import('../../electron/main/memory/tools');
    const r = await __makeQueryEpisodesTool().execute({ sources: ['cnv_nope'] }, ctx());
    expect(r.text).toContain('未找到');
  });
});

/** 往磁盘写一段对话 jsonl fixture */
async function writeConversation(
  agentId: string,
  convId: string,
  msgs: Array<{ role: string; text: string; createdAt: number }>,
): Promise<void> {
  const { convDir } = await import('../../electron/main/runtime/paths');
  const dir = join(convDir(OWNER), agentId);
  await fs.mkdir(dir, { recursive: true });
  const lines = msgs
    .map((m, i) =>
      JSON.stringify({
        id: `${convId}-${i}`,
        role: m.role,
        conversationId: convId,
        text: m.text,
        createdAt: m.createdAt,
      }),
    )
    .join('\n');
  await fs.writeFile(join(dir, `${convId}.jsonl`), `${lines}\n`, 'utf-8');
}

describe('read_conversation', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
    await writeConversation('twin', 'cnv_chat', [
      { role: 'user', text: '帮我把配色改成绿色', createdAt: 1000 },
      { role: 'assistant', text: '好的，已经把主色换成绿色', createdAt: 2000 },
      { role: 'user', text: '再深一点', createdAt: 3000 },
    ]);
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('按 convId 读回 user/assistant 文本', async () => {
    const { __makeReadConversationTool } = await import('../../electron/main/memory/dreamTools');
    const r = await __makeReadConversationTool().execute({ convId: 'cnv_chat' }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.text).toContain('帮我把配色改成绿色');
    expect(r.text).toContain('已经把主色换成绿色');
    expect(r.text).toContain('再深一点');
  });

  it('sinceMs 只取该时间戳之后的消息', async () => {
    const { __makeReadConversationTool } = await import('../../electron/main/memory/dreamTools');
    const r = await __makeReadConversationTool().execute(
      { convId: 'cnv_chat', sinceMs: 2500 },
      ctx(),
    );
    expect(r.text).toContain('再深一点');
    expect(r.text).not.toContain('帮我把配色改成绿色');
  });

  it('越界 convId 优雅报错——不抛异常', async () => {
    const { __makeReadConversationTool } = await import('../../electron/main/memory/dreamTools');
    const r = await __makeReadConversationTool().execute({ convId: 'cnv_missing' }, ctx());
    expect(r.text).toContain('未找到对话');
  });
});

describe('dream 写工具集形态（档案升格已下沉到 write/edit_memory）', () => {
  it('createDreamWriteTools 只含 merge（correct/retire 已拆出对话共享，S35·G102）', async () => {
    const { createDreamWriteTools, createEpisodeCorrectionTools } = await import(
      '../../electron/main/memory/dreamTools'
    );
    // merge 需全局视角，仍 dream 专属
    expect(createDreamWriteTools().map((t) => t.name)).toEqual(['merge_episodes']);
    // correct/retire 拆到对话 + dream 共享组
    expect(createEpisodeCorrectionTools().map((t) => t.name)).toEqual([
      'correct_episode',
      'retire_episode',
    ]);
  });
  // dream 升格档案改用主对话同款 write_memory / edit_memory（沙箱 + 文档模型），
  // 其行为已在 tools.test / documentIo.test / writeMemoryTool.test 充分覆盖，此处不重复。
});

describe('dream 写工具 — merge_episodes', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
    await writeEpisode('agents/twin/episodes', '2026-06-02-into', {
      type: 'agent',
      status: 'active',
      title: '换绿主题',
      description: '把配色改成绿色',
      sources: ['cnv_into'],
    });
    await writeEpisode('agents/twin/episodes', '2026-06-02-from', {
      type: 'agent',
      status: 'active',
      title: '调深绿色',
      description: '绿色再深一点',
      sources: ['cnv_from'],
    });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('合并后 mergeFrom 被标 superseded、mergeInto 仍活跃', async () => {
    const { __makeMergeEpisodesTool } = await import('../../electron/main/memory/dreamTools');
    // merge_episodes 只在 dream 侧注册，origin 经 originForUsage 由 usage 推导——测试 ctx
    // 须带 usage='memoryDream' 才落 'dream' 白名单（否则推成 'record'、不含 merge-episodes）
    const r = await __makeMergeEpisodesTool().execute(
      { mergeInto: 'twin/2026-06-02-into', mergeFrom: ['twin/2026-06-02-from'] },
      ctx({ usage: 'memoryDream' }),
    );
    expect(r.isError).not.toBe(true);

    const { memoryRoot } = await import('../../electron/main/memory/paths');
    // 标 superseded 即物理移入 archived/（S35·G37）——from 从活跃目录搬到 archived 子目录
    const fromText = await fs.readFile(
      join(memoryRoot(OWNER), 'agents/twin/episodes/archived/2026-06-02-from.md'),
      'utf-8',
    );
    const intoText = await fs.readFile(
      join(memoryRoot(OWNER), 'agents/twin/episodes/2026-06-02-into.md'),
      'utf-8',
    );
    expect(fromText).toMatch(/status:\s*superseded/);
    expect(intoText).toMatch(/status:\s*active/);
    // 活跃目录已不再有 from（确证是「移入」而非「留原地改状态」）
    await expect(
      fs.access(join(memoryRoot(OWNER), 'agents/twin/episodes/2026-06-02-from.md')),
    ).rejects.toThrow();
  });
});
