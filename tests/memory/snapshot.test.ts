/**
 * memory/snapshot.ts 单元测试（v2 期望）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-snapshot-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'snapshot-owner';

describe('buildSnapshot', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('全空时返回空字符串', async () => {
    const { buildSnapshot } = await import('../../electron/main/memory/snapshot');
    const fresh = `${OWNER}-empty-${Date.now()}`;
    const snap = await buildSnapshot(fresh, null);
    expect(snap).toBe('');
  });

  it('Agent-profile + User-profile 拼装出新格式 sections', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { buildSnapshot } = await import('../../electron/main/memory/snapshot');

    const owner = `${OWNER}-v2-${Date.now()}`;
    // 两个档案都走统一内核 writeMemoryDocument seeding
    await writeMemoryDocument(owner, 'agents/twin/self.md', '我是 Twin');
    // 文档模型 seeding：写自由分章正文（两段格式也被 parseProfileDoc 当作两节正确读出）
    await writeMemoryDocument(owner, 'user/profile.md', '## 基本情况\n- 家在杭州\n\n## 特质叙述\nPM ruanzhihao');

    const snap = await buildSnapshot(owner, null);
    // 顶层标题与第一层各节同级（C3：## 而非 #——快照内部子节早已压到 ###，顶层不越级）
    expect(snap.startsWith('## 记忆系统注入')).toBe(true);
    // v2：section 标题里附 v2 相对路径
    expect(snap).toContain('## Twin 自己（agents/twin/self.md）');
    expect(snap).toContain('我是 Twin');
    expect(snap).toContain('## 关于你（user/profile.md）');
    expect(snap).toContain('### 基本情况');
    expect(snap).toContain('家在杭州');
    expect(snap).toContain('### 特质叙述');
    expect(snap).toContain('PM ruanzhihao');
    // 注入头部速查表
    // 已删除注入头部速查表（B）：标题里的路径就是 LLM 的入口；工具描述里 read_memory 自己也写明了用法。
  });

  it('self.md 也走 ProfileDoc 注入：自由分章 ## 小节降级为 ###，不与快照 ## 标题同级（防层级打散）', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { buildSnapshot } = await import('../../electron/main/memory/snapshot');
    const owner = `${OWNER}-self-doc-${Date.now()}`;
    await writeMemoryDocument(owner, 'agents/twin/self.md', '我偏活泼。\n\n## 表达风格\n爱用比喻。');
    const snap = await buildSnapshot(owner, null);
    expect(snap).toContain('## Twin 自己（agents/twin/self.md）'); // 快照自身 H2
    expect(snap).toContain('我偏活泼。'); // 印象
    expect(snap).toMatch(/^### 表达风格$/m); // self 的小节降级为 ###（行首三级标题）
    expect(snap).not.toMatch(/^## 表达风格$/m); // 绝不是行首 H2（否则与快照 ## 同级、打散层级）
  });

  it('用户档案自由分章：印象 + 自定义小节全部注入、不丢（ProfileDoc，复现压扁事故的反面）', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { buildSnapshot } = await import('../../electron/main/memory/snapshot');
    const owner = `${OWNER}-doc-${Date.now()}`;
    await writeMemoryDocument(
      owner,
      'user/profile.md',
      '对你的整体印象一段。\n\n## 饮食习惯\n糙米配豆类。\n\n## 作息\n早睡早起。',
    );
    const snap = await buildSnapshot(owner, null);
    expect(snap).toContain('## 关于你（user/profile.md）');
    expect(snap).toContain('对你的整体印象一段。'); // 印象置顶
    expect(snap).toContain('### 饮食习惯');
    expect(snap).toContain('糙米配豆类。');
    expect(snap).toContain('### 作息'); // 自定义小节不被丢
    expect(snap).toContain('早睡早起。');
  });

  it('指定 currentProjectId 时注入对应 project-profile', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { buildSnapshot } = await import('../../electron/main/memory/snapshot');

    const owner = `${OWNER}-proj-${Date.now()}`;
    // 改走统一内核 seeding：写与旧 renderProfileBody 等价的三段 markdown
    await writeMemoryDocument(owner, 'projects/oru/profile.md',
      '## 基本信息\n- 阶段：v0.1\n\n## 约定\n- 用 ts\n\n## 当前进度\n\nv0.1 spec 收尾',
    );

    const snap = await buildSnapshot(owner, 'oru');
    // v2：当前项目标题也附路径
    expect(snap).toContain('## 当前项目 oru（projects/oru/profile.md）');
    expect(snap).toContain('### 基本信息');
    expect(snap).toContain('阶段：v0.1');
    expect(snap).toContain('### 约定');
    expect(snap).toContain('用 ts');
    expect(snap).toContain('### 当前进度');
    expect(snap).toContain('v0.1 spec 收尾');

    const snap2 = await buildSnapshot(owner, null);
    expect(snap2).not.toContain('当前项目');
  });

  it('总长度不超过约定预算（含小量 buffer）——读取侧截断兜住存量超限档案', async () => {
    // 写入侧现有硬上限（S35·G35）挡不进 20000 字的档案，但存量文件 / 直接编辑仍可能超预算——
    // 直接写盘模拟这类超限档案，验读取侧截断仍是最终兜底（写入侧落地后读取侧不撤，档案页口径）。
    const { writeMarkdownFile } = await import('../../electron/main/fs/frontmatter');
    const { agentSelfPath, userProfilePath } = await import('../../electron/main/memory/paths');
    const { buildSnapshot, SNAPSHOT_TOTAL_BUDGET } = await import(
      '../../electron/main/memory/snapshot'
    );
    const owner = `${OWNER}-budget-${Date.now()}`;
    const huge = '一'.repeat(10000);
    await writeMarkdownFile(agentSelfPath(owner), { 'last-updated': '2026-01-01' }, huge);
    await writeMarkdownFile(
      userProfilePath(owner),
      { 'last-updated': '2026-01-01' },
      `## 基本情况\n- ${huge}\n\n## 特质叙述\n${huge}`,
    );

    const snap = await buildSnapshot(owner, null);
    expect(snap.length).toBeLessThan(SNAPSHOT_TOTAL_BUDGET + 2000);
  });
});

// ─── 决策 2：分类归一 + 读取侧体检 ──────────────────────────

describe('normalizeEpisodeType（规则修正，纯函数）', () => {
  it('合法值原样返回；大小写差异算 corrected', async () => {
    const { normalizeEpisodeType } = await import('../../electron/main/memory/snapshot');
    expect(normalizeEpisodeType('user')).toEqual({ type: 'user', corrected: false });
    expect(normalizeEpisodeType('User')).toEqual({ type: 'user', corrected: true });
  });

  it('别名命中（persona→agent / ref→reference）', async () => {
    const { normalizeEpisodeType } = await import('../../electron/main/memory/snapshot');
    expect(normalizeEpisodeType('persona').type).toBe('agent');
    expect(normalizeEpisodeType('ref').type).toBe('reference');
  });

  it("种类词 'episode' 按 scope 缩小", async () => {
    const { normalizeEpisodeType } = await import('../../electron/main/memory/snapshot');
    expect(normalizeEpisodeType('episode', 'project').type).toBe('project');
    expect(normalizeEpisodeType('episode', 'agent').type).toBe('agent');
    expect(normalizeEpisodeType('episode').type).toBe('agent'); // 缺 scope 默认 agent
  });

  it('修不了的非法值 / 非字符串 → null', async () => {
    const { normalizeEpisodeType } = await import('../../electron/main/memory/snapshot');
    expect(normalizeEpisodeType('banana').type).toBeNull();
    expect(normalizeEpisodeType(undefined).type).toBeNull();
    expect(normalizeEpisodeType(42).type).toBeNull();
  });
});

describe('loadEpisodeMeta 读取侧 + listInvalidEpisodes', () => {
  async function writeRawEpisode(owner: string, slug: string, type: string) {
    const { agentEpisodesDir } = await import('../../electron/main/memory/paths');
    const { writeMarkdownFile } = await import('../../electron/main/fs/frontmatter');
    const abs = join(agentEpisodesDir(owner), `2026-05-10-${slug}.md`);
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await writeMarkdownFile(
      abs,
      { scope: 'agent', type, status: 'active', created: '2026-05-10', updated: '2026-05-10', title: `T ${slug}`, description: `D ${slug}` },
      '正文',
    );
  }

  it('合法 type 进 index；别名 type 修正后进 index', async () => {
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `read-ok-${Date.now()}`;
    await writeRawEpisode(owner, 'valid', 'feedback');
    await writeRawEpisode(owner, 'aliased', 'persona');
    const eps = await __scanAllActiveEpisodes(owner);
    expect(eps.find((e) => e.compressedPath.endsWith('valid'))?.type).toBe('feedback');
    expect(eps.find((e) => e.compressedPath.endsWith('aliased'))?.type).toBe('agent');
  });

  it('修不了的非法 type → 不进 index，但 listInvalidEpisodes 列得出（不静默消失）', async () => {
    const { __scanAllActiveEpisodes, listInvalidEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `read-bad-${Date.now()}`;
    await writeRawEpisode(owner, 'broken', 'banana');
    const eps = await __scanAllActiveEpisodes(owner);
    expect(eps.find((e) => e.compressedPath.endsWith('broken'))).toBeUndefined();

    const invalid = await listInvalidEpisodes(owner);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].rawType).toBe('banana');
    expect(invalid[0].relPath).toContain('broken');
  });
});

