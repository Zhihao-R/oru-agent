/**
 * BuiltinRecaller + fetchMemoryBodies 单测 —— 内置召回流水线装配
 *
 * tier 1 全带 / tier 2 跑挑选器；按 id 取全文走 ensureWithinRoot 沙箱（伪造/越界挡掉）；
 * 删了即不召回。设计见 recall PRD §5 / impl-plan A5。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend } from '@shared/agent/backend';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const ORU_DIR = join(tmpdir(), `oru-test-builtin-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

function ctx(owner: string): ToolContext {
  return makeToolContext({ conversationId: 'c1', agentId: 'a1', ownerId: owner });
}

async function seedEpisode(owner: string, title: string, slug: string): Promise<void> {
  const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
  await __makeRecordMemoryTool().execute(
    { scope: 'agent', content: `${title} 的正文内容`, title, slug, episodeCategory: 'user', description: `${title} 描述` },
    ctx(owner),
  );
}

/**
 * 播一条项目域 episode（scope: 'project'）——直接落盘（record 工具要求 projectId 已注册，
 * 本测试只验召回管线按 compressedPath 首段派生归属，不引入项目注册的重设置）。
 */
async function seedProjectEpisode(owner: string, projectId: string, title: string, slug: string): Promise<void> {
  const abs = join(ORU_DIR, 'users', owner, 'memory', 'projects', projectId, 'episodes', `2026-05-10-${slug}.md`);
  await fs.mkdir(dirname(abs), { recursive: true });
  const content =
    `---\ntype: project\ntitle: ${title}\ndescription: ${title} 描述\nupdated: '2026-05-10'\nstatus: active\nscope: 'project:${projectId}'\n---\n${title} 的正文内容\n`;
  await fs.writeFile(abs, content, 'utf-8');
}

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('fetchMemoryBodies 沙箱 + 删了即跳过', () => {
  it('越界 id（../ 逃逸）被挡掉，不抛', async () => {
    const { fetchMemoryBodies } = await import('../../electron/main/memory/recall/builtin');
    const got = await fetchMemoryBodies(`fb-escape-${Date.now()}`, ['../../etc/passwd', '../secret.md']);
    expect(got).toEqual([]);
  });

  it('文件不存在（已删）→ 跳过', async () => {
    const { fetchMemoryBodies } = await import('../../electron/main/memory/recall/builtin');
    const got = await fetchMemoryBodies(`fb-missing-${Date.now()}`, ['agents/twin/episodes/2026-01-01-nope.md']);
    expect(got).toEqual([]);
  });

  it('取到正文（去 frontmatter）', async () => {
    const { fetchMemoryBodies } = await import('../../electron/main/memory/recall/builtin');
    const owner = `fb-ok-${Date.now()}`;
    await seedEpisode(owner, '搬家', 'banjia');
    const { buildEpisodeBriefs } = await import('../../electron/main/memory/recall/briefs');
    const briefs = await buildEpisodeBriefs(owner);
    const got = await fetchMemoryBodies(owner, [briefs[0].id]);
    expect(got.length).toBe(1);
    expect(got[0].body).toContain('搬家 的正文内容');
    expect(got[0].body).not.toContain('---'); // 无 frontmatter
  });
});

describe('BuiltinRecaller', () => {
  it('候选为空 → 空结果', async () => {
    const { BuiltinRecaller } = await import('../../electron/main/memory/recall/builtin');
    const r = await new BuiltinRecaller().recall({
      ownerId: `br-empty-${Date.now()}`,
      conversationWindow: [{ role: 'user', text: 'x' }],
    });
    expect(r).toEqual({ selected: [] });
  });

  it('tier 1（候选 ≤ 上限）：跳过挑选直接全带，不调模型', async () => {
    const { BuiltinRecaller } = await import('../../electron/main/memory/recall/builtin');
    const owner = `br-tier1-${Date.now()}`;
    await seedEpisode(owner, '事件一', 'ev1');
    await seedEpisode(owner, '事件二', 'ev2');
    let called = false;
    const backend: Pick<AgentBackend, 'runOneShot' | 'backendType'> = {
      backendType: 'anthropic',
      runOneShot: async () => {
        called = true;
        return { text: '{}' };
      },
    };
    const r = await new BuiltinRecaller({ directInjectMax: 50, pickerBackend: backend }).recall({
      ownerId: owner,
      conversationWindow: [{ role: 'user', text: '随便问' }],
    });
    expect(called).toBe(false); // tier 1 不跑挑选器
    expect(r.selected.length).toBe(2); // 全带
    expect(r.selected.map((m) => m.body).join()).toContain('事件一 的正文内容');
  });

  it('项目维粗筛（G20）：activeProjectId 只圈全局 + 当前项目，排除其他项目', async () => {
    const { BuiltinRecaller } = await import('../../electron/main/memory/recall/builtin');
    const owner = `br-proj-${Date.now()}`;
    await seedEpisode(owner, '全局往事', 'global-ep'); // scope agent（全局）
    await seedProjectEpisode(owner, 'projA', 'A 项目往事', 'a-ep');
    await seedProjectEpisode(owner, 'projB', 'B 项目往事', 'b-ep');
    // 当前项目 = projA：tier 1 全带（候选已被粗筛到全局 + A 两条）
    const r = await new BuiltinRecaller({ directInjectMax: 50 }).recall({
      ownerId: owner,
      conversationWindow: [{ role: 'user', text: '随便问' }],
      activeProjectId: 'projA',
    });
    const bodies = r.selected.map((m) => m.body).join();
    expect(bodies).toContain('全局往事 的正文内容'); // 全局照进
    expect(bodies).toContain('A 项目往事 的正文内容'); // 当前项目进
    expect(bodies).not.toContain('B 项目往事'); // 其他项目排除
  });

  it('项目维粗筛（G20）：无当前项目（自由聊天）只圈全局，排除所有项目条目', async () => {
    const { BuiltinRecaller } = await import('../../electron/main/memory/recall/builtin');
    const owner = `br-proj-none-${Date.now()}`;
    await seedEpisode(owner, '全局往事', 'global-ep');
    await seedProjectEpisode(owner, 'projA', 'A 项目往事', 'a-ep');
    const r = await new BuiltinRecaller({ directInjectMax: 50 }).recall({
      ownerId: owner,
      conversationWindow: [{ role: 'user', text: '随便问' }],
      // 不传 activeProjectId = 无当前项目
    });
    const bodies = r.selected.map((m) => m.body).join();
    expect(bodies).toContain('全局往事 的正文内容');
    expect(bodies).not.toContain('A 项目往事'); // 无当前项目时项目条目全排除
  });

  it('tier 2（候选超上限）：跑挑选器，按选中 id 取全文 + hint 给邻居标题', async () => {
    const { BuiltinRecaller } = await import('../../electron/main/memory/recall/builtin');
    const { buildEpisodeBriefs } = await import('../../electron/main/memory/recall/briefs');
    const owner = `br-tier2-${Date.now()}`;
    await seedEpisode(owner, '搬家方案', 'banjia');
    await seedEpisode(owner, '健身计划', 'fitness');
    const briefs = await buildEpisodeBriefs(owner);
    const banjia = briefs.find((b) => b.id.includes('banjia'))!;
    const fitness = briefs.find((b) => b.id.includes('fitness'))!;
    const backend: Pick<AgentBackend, 'runOneShot' | 'backendType'> = {
      backendType: 'anthropic',
      runOneShot: async () => ({ text: JSON.stringify({ selected: [banjia.id], hints: [fitness.id] }) }),
    };
    const r = await new BuiltinRecaller({ directInjectMax: 1, pickerBackend: backend }).recall({
      ownerId: owner,
      conversationWindow: [{ role: 'user', text: '上次聊的搬家' }],
    });
    expect(r.selected.length).toBe(1);
    expect(r.selected[0].body).toContain('搬家方案 的正文内容');
    expect(r.hint?.neighbors).toEqual(['健身计划']); // near-miss 邻居标题
  });
});
