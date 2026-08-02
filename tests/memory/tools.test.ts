/**
 * memory/tools.ts 单元测试（v2）
 *
 * record_memory 四值 type 全部走 op 路径：
 *   user-basic → add/update/remove-user-fact → user/profile.md ## 基本情况
 *   user-trait → append/replace-user-trait   → user/profile.md ## 特质叙述
 *   self       → append/update/remove-agent-persona → agents/twin/self.md
 *   episode    → create/supersede/correct-episode → agents/twin/episodes/ or projects/<id>/episodes/
 *
 * edit_memory 是 record_memory 的对侧——改 / 删 / 覆盖已有内容。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '@shared/agent/backend';
import type { MemoryRecordPayload } from '@shared/types';
import { makeToolContext } from '../helpers/toolContext';

const ORU_DIR = join(tmpdir(), `oru-test-tools-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'tools-owner';

function ctx(extras?: Partial<ToolContext>): ToolContext {
  return makeToolContext({ conversationId: 'conv-1', agentId: 'agent-1', ownerId: OWNER, ...extras });
}

describe('record_memory', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    const { __resetForTest } = await import('../../electron/main/memory/accessLog');
    __resetForTest();
  });

  it('episode 必须给 title / slug / episodeCategory / description', async () => {
    const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
    const tool = __makeRecordMemoryTool();

    const noTitle = await tool.execute({ scope: 'agent', content: '...' }, ctx());
    expect(noTitle.isError).toBe(true);
    expect(noTitle.text).toMatch(/title/);

    const noSlug = await tool.execute({ scope: 'agent', content: '...', title: 'X' }, ctx());
    expect(noSlug.isError).toBe(true);
    expect(noSlug.text).toMatch(/slug/);

    const noEpType = await tool.execute(
      { scope: 'agent', content: '...', title: 'X', slug: 'x' },
      ctx(),
    );
    expect(noEpType.isError).toBe(true);
    expect(noEpType.text).toMatch(/episodeCategory/);

    const noDesc = await tool.execute(
      { scope: 'agent', content: '...', title: 'X', slug: 'x', episodeCategory: 'user' },
      ctx(),
    );
    expect(noDesc.isError).toBe(true);
    expect(noDesc.text).toMatch(/description/);
  });

  it('episode 写入文件 + 索引同步 + v2 frontmatter 完整 + 推卡片 type=episode', async () => {
    const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
    const { readIndex, readEpisode } = await import('../../electron/main/memory/store');
    let pushed: { type?: string } | null = null;
    const tool = __makeRecordMemoryTool();
    const r = await tool.execute(
      {
        scope: 'agent',
        content: '今天讨论了 x',
        title: '讨论 x',
        slug: 'taolun-x',
        episodeCategory: 'user',
        description: '简短一句话',
        tags: ['x', 'y'],
      },
      ctx({ onMemoryRecord: async (p) => { pushed = p as { type?: string }; } }),
    );
    expect(r.isError).not.toBe(true);
    const idx = await readIndex(OWNER);
    const entry = idx.find((e) => e.title === '讨论 x');
    expect(entry).toBeDefined();
    const ep = await readEpisode(OWNER, entry!.relPath);
    const fm = ep!.frontmatter as Record<string, unknown>;
    expect(fm.type).toBe('user');
    expect(fm.description).toBe('简短一句话');
    expect(fm.title).toBe('讨论 x');
    expect(pushed).toMatchObject({ type: 'episode' });
  });

  // 回归：卡片 payload.relPath 必须是「完整路径」——查看（NoteDetailOverlay 精确匹配 episodes 列表）
  // 与撤销（memory.undo 直接 join(memoryRoot, relPath) 落盘）两个消费方都按完整路径工作。曾误传
  // applyCreateEpisode 回给 AI 的压缩路径（twin/<date>-slug），导致查看开空浮层、撤销静默假撤销。
  it('episode 卡片 payload.relPath 是完整路径（与 index 一致），非压缩路径', async () => {
    const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
    const { readIndex } = await import('../../electron/main/memory/store');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    let pushed: MemoryRecordPayload | null = null;
    const tool = __makeRecordMemoryTool();
    await tool.execute(
      {
        scope: 'agent',
        content: '内容',
        title: '完整路径回归',
        slug: 'full-path-regression',
        episodeCategory: 'user',
        description: '一句话',
      },
      ctx({ onMemoryRecord: async (p) => { pushed = p; } }),
    );
    const entry = (await readIndex(OWNER)).find((e) => e.title === '完整路径回归');
    expect(entry).toBeDefined();
    // 查看侧：完整路径进 agents/twin/episodes/ 且以 .md 结尾，恰等于 index / listEpisodes 里的 relPath
    expect(pushed!.relPath).toBe(entry!.relPath);
    expect(pushed!.relPath).toMatch(/^agents\/twin\/episodes\/.+\.md$/);
    // 撤销侧：memory.undo 直接 join(memoryRoot, relPath) 挪文件——该路径必须物理可达，否则静默假撤销
    await expect(fs.access(join(memoryRoot(OWNER), pushed!.relPath))).resolves.toBeUndefined();
  });

  it('不给 scope（或非 agent/project）报错', async () => {
    const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
    const tool = __makeRecordMemoryTool();
    const r = await tool.execute({ content: 'x' } as never, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/scope=agent.*scope=project/);
  });
});

describe('edit_memory（通用查找替换，与对话 edit_file 对齐）', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  async function seedProfile(body: string): Promise<void> {
    const { __makeWriteMemoryTool } = await import('../../electron/main/memory/tools');
    await __makeWriteMemoryTool().execute({ relPath: 'user/profile.md', content: body }, ctx());
  }

  it('唯一命中 → 替换并推 onMemoryRecord 卡片', async () => {
    const { __makeEditMemoryTool } = await import('../../electron/main/memory/tools');
    await seedProfile('## 事实\n- 现居成都\n- 职业工程师');
    let pushed: { relPath?: string } | null = null;
    const r = await __makeEditMemoryTool().execute(
      { relPath: 'user/profile.md', oldText: '- 现居成都', newText: '- 现居杭州' },
      ctx({ onMemoryRecord: async (p) => { pushed = p; } }),
    );
    expect(r.isError).not.toBe(true);
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const raw = await fs.readFile(join(memoryRoot(OWNER), 'user/profile.md'), 'utf-8');
    expect(raw).toContain('- 现居杭州');
    expect(raw).not.toContain('- 现居成都');
    expect(pushed).toMatchObject({ relPath: 'user/profile.md' });
  });

  it('0 命中 → isError，提示先 read 再试（不写盘）', async () => {
    const { __makeEditMemoryTool } = await import('../../electron/main/memory/tools');
    await seedProfile('## 事实\n- 现居成都');
    const r = await __makeEditMemoryTool().execute(
      { relPath: 'user/profile.md', oldText: '- 不存在', newText: 'x' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/没找到|read/);
  });

  it('多命中 → isError，提示给更长上下文（不写盘）', async () => {
    const { __makeEditMemoryTool } = await import('../../electron/main/memory/tools');
    await seedProfile('- 重复行\n- 重复行');
    const r = await __makeEditMemoryTool().execute(
      { relPath: 'user/profile.md', oldText: '- 重复行', newText: '- 改' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/多次|更长/);
  });

  it('newText 空串 = 删除该段', async () => {
    const { __makeEditMemoryTool } = await import('../../electron/main/memory/tools');
    await seedProfile('## 事实\n- 删我\n- 留我');
    const r = await __makeEditMemoryTool().execute(
      { relPath: 'user/profile.md', oldText: '- 删我\n', newText: '' },
      ctx(),
    );
    expect(r.isError).not.toBe(true);
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const raw = await fs.readFile(join(memoryRoot(OWNER), 'user/profile.md'), 'utf-8');
    expect(raw).not.toContain('删我');
    expect(raw).toContain('- 留我');
  });

  it('命中 self.md → 卡片 scope=agent', async () => {
    const { __makeWriteMemoryTool, __makeEditMemoryTool } = await import(
      '../../electron/main/memory/tools'
    );
    await __makeWriteMemoryTool().execute(
      { relPath: 'agents/twin/self.md', content: '我偏活泼。' },
      ctx(),
    );
    let pushed: { scope?: string } | null = null;
    await __makeEditMemoryTool().execute(
      { relPath: 'agents/twin/self.md', oldText: '偏活泼', newText: '偏沉稳' },
      ctx({ onMemoryRecord: async (p) => { pushed = p; } }),
    );
    expect(pushed).toMatchObject({ scope: 'agent' });
  });

  it('参数不齐 → isError（删除须显式传 newText 空串）', async () => {
    const { __makeEditMemoryTool } = await import('../../electron/main/memory/tools');
    const tool = __makeEditMemoryTool();
    expect((await tool.execute({ relPath: 'user/profile.md', oldText: 'a' } as never, ctx())).isError).toBe(true);
    expect((await tool.execute({ oldText: 'a', newText: 'b' } as never, ctx())).isError).toBe(true);
  });

  it('relPath 越界 → 优雅 isError', async () => {
    const { __makeEditMemoryTool } = await import('../../electron/main/memory/tools');
    const r = await __makeEditMemoryTool().execute(
      { relPath: '../../evil.md', oldText: 'a', newText: 'b' },
      ctx(),
    );
    expect(r.isError).toBe(true);
  });
});

describe('grep_memory', () => {
  it('找不到时返回提示', async () => {
    const { __makeGrepMemoryTool } = await import('../../electron/main/memory/tools');
    const tool = __makeGrepMemoryTool();
    const r = await tool.execute({ query: 'this-string-should-not-exist-anywhere-xyz' }, ctx());
    expect(r.text).toMatch(/未找到/);
  });

  it('能找到既有事件文件里的关键字', async () => {
    const { __makeRecordMemoryTool, __makeGrepMemoryTool } = await import(
      '../../electron/main/memory/tools'
    );
    const r1 = __makeRecordMemoryTool();
    await r1.execute(
      {
        scope: 'agent',
        type: 'episode',
        content: '聊到 OpenClaw 封号风险',
        title: 'OpenClaw',
        slug: 'openclaw-feng',
        episodeCategory: 'reference',
        description: 'OpenClaw 封号一则',
      },
      ctx(),
    );
    const grep = __makeGrepMemoryTool();
    const r = await grep.execute({ query: 'OpenClaw' }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.text).toMatch(/OpenClaw/);
  });

  it('scope=personal 走 user/ 目录（v2 路径）', async () => {
    const { __makeWriteMemoryTool, __makeGrepMemoryTool } = await import(
      '../../electron/main/memory/tools'
    );
    await __makeWriteMemoryTool().execute(
      { relPath: 'user/profile.md', content: '只在 user/ 出现的特殊字符串-zzz-grep-target' },
      ctx(),
    );
    const r = await __makeGrepMemoryTool().execute(
      { query: 'zzz-grep-target', scope: 'personal' },
      ctx(),
    );
    expect(r.isError).not.toBe(true);
    expect(r.text).toMatch(/user\/profile\.md/);
  });

  it('不返回 .backup* 迁移备份 / trash 回收站里的陈旧副本', async () => {
    const { __makeRecordMemoryTool, __makeGrepMemoryTool } = await import(
      '../../electron/main/memory/tools'
    );
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const MARK = 'marker-poison-zzz';
    // 活跃 episode：唯一串，应当被命中
    await __makeRecordMemoryTool().execute(
      {
        scope: 'agent',
        type: 'episode',
        content: `迁移污染回归 ${MARK}`,
        title: 'poison',
        slug: 'poison-regression',
        episodeCategory: 'reference',
        description: 'poison 回归',
      },
      ctx(),
    );
    // 模拟 v1→v2 迁移备份与回收站里残留同一串：scope=all 从 memoryRoot 整棵走会撞上，必须跳过
    const root = memoryRoot(OWNER);
    await fs.mkdir(join(root, '.backup-pre-v2', '2026-05-22'), { recursive: true });
    await fs.writeFile(join(root, '.backup-pre-v2', '2026-05-22', 'personal__facts.md'), `陈旧副本 ${MARK}\n`);
    await fs.mkdir(join(root, 'trash', '2026-05-22'), { recursive: true });
    await fs.writeFile(join(root, 'trash', '2026-05-22', 'old.md'), `回收站副本 ${MARK}\n`);

    const r = await __makeGrepMemoryTool().execute({ query: MARK }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.text).toMatch(/poison-regression/); // 活跃 episode 命中
    expect(r.text).not.toMatch(/backup-pre-v2/); // 不返回迁移备份
    expect(r.text).not.toMatch(/trash/); // 不返回回收站
  });
});

describe('read_memory', () => {
  it('路径越界拒绝', async () => {
    const { __makeReadMemoryTool } = await import('../../electron/main/memory/tools');
    const tool = __makeReadMemoryTool();
    const r = await tool.execute({ relPath: '../../../etc/passwd' }, ctx());
    expect(r.isError).toBe(true);
  });

  it('文件不存在返回错误', async () => {
    const { __makeReadMemoryTool } = await import('../../electron/main/memory/tools');
    const tool = __makeReadMemoryTool();
    const r = await tool.execute({ relPath: 'nonexistent.md' }, ctx());
    expect(r.isError).toBe(true);
  });

  it('能读到既有 episode（完整 relPath）', async () => {
    const { __makeRecordMemoryTool, __makeReadMemoryTool } = await import(
      '../../electron/main/memory/tools'
    );
    const r1 = __makeRecordMemoryTool();
    await r1.execute(
      {
        scope: 'agent',
        type: 'episode',
        content: '某段叙述',
        title: 'X',
        slug: 'read-x',
        episodeCategory: 'agent',
        description: '某段简短描述',
      },
      ctx(),
    );
    const { readIndex } = await import('../../electron/main/memory/store');
    const idx = await readIndex(OWNER);
    const target = idx.find((e) => e.title === 'X');
    expect(target).toBeDefined();
    const read = __makeReadMemoryTool();
    const r = await read.execute({ relPath: target!.relPath }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.text).toMatch(/某段叙述/);
  });

  it('能读到既有 episode（compressed path）', async () => {
    const { __makeRecordMemoryTool, __makeReadMemoryTool } = await import(
      '../../electron/main/memory/tools'
    );
    await __makeRecordMemoryTool().execute(
      {
        scope: 'agent',
        type: 'episode',
        content: '压缩路径读取内容',
        title: 'CompRead',
        slug: 'comp-read',
        episodeCategory: 'agent',
        description: 'compressed path 读取',
      },
      ctx(),
    );
    // compressed: twin/<today>-comp-read
    const today = new Date().toISOString().slice(0, 10);
    const compressed = `twin/${today}-comp-read`;
    const r = await __makeReadMemoryTool().execute({ relPath: compressed }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.text).toMatch(/压缩路径读取内容/);
  });

  it('能读 user/profile.md', async () => {
    const { __makeWriteMemoryTool, __makeReadMemoryTool } = await import(
      '../../electron/main/memory/tools'
    );
    await __makeWriteMemoryTool().execute(
      { relPath: 'user/profile.md', content: 'profile-read-fact' },
      ctx(),
    );
    const r = await __makeReadMemoryTool().execute({ relPath: 'user/profile.md' }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.text).toContain('profile-read-fact');
  });

  // 读/写坐标一致：档案类（profile/self）frontmatter 是系统自管元数据，edit/write 只认 body，
  // read_memory 也要只回 body——否则模型按读到的 frontmatter 边界锚定 oldText，edit 在剥离 body 里搜不到。
  it('档案类 read_memory 剥离 frontmatter，只回 body', async () => {
    const { __makeWriteMemoryTool, __makeReadMemoryTool } = await import(
      '../../electron/main/memory/tools'
    );
    await __makeWriteMemoryTool().execute(
      { relPath: 'user/profile.md', content: '## 事实\n- 现居成都' },
      ctx(),
    );
    const r = await __makeReadMemoryTool().execute({ relPath: 'user/profile.md' }, ctx());
    expect(r.text).toContain('## 事实');
    expect(r.text).not.toMatch(/^---/); // 不把系统 frontmatter（last-updated）泄给模型
    expect(r.text).not.toContain('last-updated');
  });

  // episode 的 frontmatter（sources/tags）是承重内容，read_memory 必须保持 raw（read_conversation 靠它取 convId）。
  it('episode read_memory 保留 raw frontmatter', async () => {
    const { __makeRecordMemoryTool, __makeReadMemoryTool } = await import(
      '../../electron/main/memory/tools'
    );
    await __makeRecordMemoryTool().execute(
      {
        scope: 'agent',
        type: 'episode',
        content: 'episode 正文',
        title: 'RawFm',
        slug: 'raw-fm',
        episodeCategory: 'agent',
        description: '带 frontmatter',
      },
      ctx(),
    );
    const today = new Date().toISOString().slice(0, 10);
    const r = await __makeReadMemoryTool().execute({ relPath: `twin/${today}-raw-fm` }, ctx());
    expect(r.text).toMatch(/^---/); // episode 仍带 frontmatter
    expect(r.text).toContain('episode 正文');
  });
});

// grep_memory：大小写不敏感 + 多词并集（搜索侧召回改进）
describe('grep_memory 多词 + 大小写', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
    const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
    const rec = __makeRecordMemoryTool();
    // 一条用"清晨"措辞的记忆——问句若用"起床"字面搜不到，需近义词
    await rec.execute(
      { type: 'episode', episodeCategory: 'user', scope: 'agent', title: '早起', slug: 'grep-morning', description: '作息', content: '用户每天清晨固定起身' },
      ctx(),
    );
    // 一条含英文大小写混排的记忆
    await rec.execute(
      { type: 'episode', episodeCategory: 'reference', scope: 'agent', title: 'VS Code', slug: 'grep-editor', description: '编辑器', content: '主力用 VS Code' },
      ctx(),
    );
  });

  it('单个原词搜不到（措辞错位）', async () => {
    const { __makeGrepMemoryTool } = await import('../../electron/main/memory/tools');
    const r = await __makeGrepMemoryTool().execute({ query: '起床' }, ctx());
    expect(r.text).toMatch(/未找到/);
  });

  it('多词并集：传一组近义词，命中任一即返回 + 标注命中词', async () => {
    const { __makeGrepMemoryTool } = await import('../../electron/main/memory/tools');
    const r = await __makeGrepMemoryTool().execute({ query: ['起床', '清晨', '作息'] }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.text).toContain('grep-morning');
    expect(r.text).toMatch(/\[命中 .*(清晨|作息)/); // 多词时标注是哪个词命中
  });

  it('大小写不敏感：小写 query 命中大写内容', async () => {
    const { __makeGrepMemoryTool } = await import('../../electron/main/memory/tools');
    const r = await __makeGrepMemoryTool().execute({ query: 'vs code' }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.text).toContain('grep-editor');
  });

  it('空搜索词 → 报错', async () => {
    const { __makeGrepMemoryTool } = await import('../../electron/main/memory/tools');
    const r = await __makeGrepMemoryTool().execute({ query: [] }, ctx());
    expect(r.isError).toBe(true);
  });
});
