/**
 * applyOps 新增 op + 白名单单测
 *
 * 覆盖：
 * 1. write-agent-self 整段覆盖 self.md
 * 2. record 白名单允许 write-agent-self / write-user-portrait / project-basic / project-convention
 * 3. capture 拒绝 write-agent-self；dream 允许（跨对话视角进化人设）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-applyops-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const OWNER = 'applyops-owner';

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('OP_WHITELIST（档案 op 退役后只剩 episode 结构化 op）', () => {
  it('record/capture/dream 只含 episode op；ui 为空（前端走文档模型不再发 op）', async () => {
    const { OP_WHITELIST } = await import('../../shared/memory/operations');
    expect(OP_WHITELIST.record.has('create-episode')).toBe(true);
    expect(OP_WHITELIST.dream.has('merge-episodes')).toBe(true);
    expect(OP_WHITELIST.ui.size).toBe(0);
    const all = [...OP_WHITELIST.record, ...OP_WHITELIST.capture, ...OP_WHITELIST.dream];
    expect(all.some((o) => /user|persona|portrait|project-|trait/.test(o))).toBe(false);
  });
});

// ─── 决策 2：create-episode 分类校验（写入拦截 + 规则修正 + 分场景兜底） ──────

describe('create-episode 分类校验（决策 2）', () => {
  const mkPayload = (type: string, slug: string) => ({
    scope: 'agent' as const,
    type: type as 'user',
    title: `事件 ${slug}`,
    slug,
    description: '一句话',
    content: '正文',
  });

  it('record 写入非法分类 → 被拒、errCount=1、不落盘', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { listInvalidEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `badtype-reject-${Date.now()}`;

    const r = await applyOps(owner, [{ op: 'create-episode', payload: mkPayload('banana', 'bad-1') }], 'record');
    expect(r.errCount).toBe(1);
    expect(r.results[0].ok).toBe(false);
    if (!r.results[0].ok) expect(r.results[0].error).toMatch(/分类只能是/);
    // 没落盘：listInvalidEpisodes 空
    expect(await listInvalidEpisodes(owner)).toEqual([]);
  });

  it('别名命中（persona）→ 自动改 agent、进 index', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `alias-${Date.now()}`;

    const r = await applyOps(owner, [{ op: 'create-episode', payload: mkPayload('persona', 'alias-1') }], 'record');
    expect(r.errCount).toBe(0);
    const eps = await __scanAllActiveEpisodes(owner);
    expect(eps.find((e) => e.compressedPath.endsWith('alias-1'))?.type).toBe('agent');
  });

  it("种类词 'episode' 按 scope 缩小：agent scope → agent", async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `epword-${Date.now()}`;

    await applyOps(owner, [{ op: 'create-episode', payload: mkPayload('episode', 'epword-1') }], 'record');
    const eps = await __scanAllActiveEpisodes(owner);
    expect(eps.find((e) => e.compressedPath.endsWith('epword-1'))?.type).toBe('agent');
  });

  it('后台 capture 非法分类 → 不丢：原样落盘 + listInvalidEpisodes 列得出、但不进 index', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { listInvalidEpisodes, __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `capture-keep-${Date.now()}`;

    const r = await applyOps(owner, [{ op: 'create-episode', payload: mkPayload('banana', 'kept-1') }], 'capture');
    expect(r.errCount).toBe(0); // capture 不拒，落盘

    const invalid = await listInvalidEpisodes(owner);
    expect(invalid.some((x) => x.relPath.includes('kept-1') && x.rawType === 'banana')).toBe(true);

    // 不进召回（loadEpisodeMeta return null）
    const eps = await __scanAllActiveEpisodes(owner);
    expect(eps.find((e) => e.compressedPath.endsWith('kept-1'))).toBeUndefined();
  });

  it('correct-episode 同 slug 同日纠错：episode 不丢、active 留的是新内容（回归）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const owner = `correct-dup-${Date.now()}`;

    // 同会话先写一条
    const created = await applyOps(owner, [{ op: 'create-episode', payload: mkPayload('user', 'dup') }], 'record');
    const compressed = created.results[0].ok ? created.results[0].detail! : '';

    // 当场纠错：同 slug、新内容（valid 分类）。新旧路径相同——不能把 episode 弄丢
    const corrected = await applyOps(
      owner,
      [{ op: 'correct-episode', oldPath: compressed, payload: { ...mkPayload('feedback', 'dup'), content: '纠正后的新内容' } }],
      'record',
    );
    expect(corrected.errCount).toBe(0);

    // active 仍有这条（没消失），且是新内容、新分类
    const eps = await __scanAllActiveEpisodes(owner);
    const still = eps.find((e) => e.compressedPath.endsWith('dup'));
    expect(still).toBeDefined();
    expect(still?.type).toBe('feedback');
    const abs = join(memoryRoot(owner), await expandPath(owner, still!.compressedPath));
    const text = await fs.readFile(abs, 'utf-8');
    expect(text).toContain('纠正后的新内容');
  });

  it('supersede-episode 同 slug 同日：拒绝、原 episode 不丢（回归）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `supersede-dup-${Date.now()}`;

    const created = await applyOps(owner, [{ op: 'create-episode', payload: { ...mkPayload('user', 'ss-dup'), content: '原始内容' } }], 'record');
    const compressed = created.results[0].ok ? created.results[0].detail! : '';

    // 同 slug 同日 supersede——会落到同一路径，必须拒绝而不是把新内容标成被自己取代后丢掉
    const r = await applyOps(
      owner,
      [{ op: 'supersede-episode', oldPath: compressed, payload: { ...mkPayload('user', 'ss-dup'), content: '新内容' } }],
      'record',
    );
    expect(r.errCount).toBe(1);
    if (!r.results[0].ok) expect(r.results[0].error).toMatch(/路径相同|换一个 slug/);

    // 原 episode 仍在 active（没被静默吞掉）
    const eps = await __scanAllActiveEpisodes(owner);
    expect(eps.find((e) => e.compressedPath.endsWith('ss-dup'))).toBeDefined();
  });
});

// ─── merge-episodes newBody：合并互补内容不丢正文（回归目标问题本身） ──────

describe('merge-episodes newBody', () => {
  const mk = (slug: string, content: string) => ({
    scope: 'agent' as const,
    type: 'project' as const,
    title: `事件 ${slug}`,
    slug,
    description: '一句话',
    content,
  });

  it('newBody 把被并入条的互补内容捏进保留条；保留条正文=newBody，被并入条移出 active', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const owner = `merge-newbody-${Date.now()}`;

    // 两条互补 episode（各讲一个侧面）
    const into = await applyOps(owner, [{ op: 'create-episode', payload: mk('keep', '侧面A：结构决策') }], 'record');
    const from = await applyOps(owner, [{ op: 'create-episode', payload: mk('drop', '侧面B：排序决策') }], 'record');
    const intoPath = into.results[0].ok ? into.results[0].detail! : '';
    const fromPath = from.results[0].ok ? from.results[0].detail! : '';

    const merged = await applyOps(
      owner,
      [
        {
          op: 'merge-episodes',
          mergeInto: intoPath,
          mergeFrom: [fromPath],
          newBody: '综合正文：侧面A 结构决策 + 侧面B 排序决策',
        },
      ],
      'dream',
    );
    expect(merged.errCount).toBe(0);

    // 保留条仍在 active，正文已被 newBody 覆盖（含两个侧面）
    const eps = await __scanAllActiveEpisodes(owner);
    const survivor = eps.find((e) => e.compressedPath.endsWith('keep'));
    expect(survivor).toBeDefined();
    const abs = join(memoryRoot(owner), await expandPath(owner, survivor!.compressedPath));
    const text = await fs.readFile(abs, 'utf-8');
    expect(text).toContain('侧面A 结构决策 + 侧面B 排序决策');

    // 被并入条移出 active 召回（superseded）——互补内容不丢是因为已在 newBody 里
    expect(eps.find((e) => e.compressedPath.endsWith('drop'))).toBeUndefined();
  });

  it('不传 newBody：保留条正文原样不动（字面去重路径）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const owner = `merge-nobody-${Date.now()}`;

    const into = await applyOps(owner, [{ op: 'create-episode', payload: mk('keep2', '原始正文不该被动') }], 'record');
    const from = await applyOps(owner, [{ op: 'create-episode', payload: mk('drop2', '重复条') }], 'record');
    const intoPath = into.results[0].ok ? into.results[0].detail! : '';
    const fromPath = from.results[0].ok ? from.results[0].detail! : '';

    const merged = await applyOps(
      owner,
      [{ op: 'merge-episodes', mergeInto: intoPath, mergeFrom: [fromPath], newDescription: '新描述' }],
      'dream',
    );
    expect(merged.errCount).toBe(0);

    const eps = await __scanAllActiveEpisodes(owner);
    const survivor = eps.find((e) => e.compressedPath.endsWith('keep2'));
    const abs = join(memoryRoot(owner), await expandPath(owner, survivor!.compressedPath));
    const text = await fs.readFile(abs, 'utf-8');
    expect(text).toContain('原始正文不该被动');
  });
});

// ─── user-direct 标记只认布尔 true：模型吐字符串不得把自发记的误标成用户嘱记 ──────

describe('create-episode 的 userRequested 严格判定', () => {
  it('模型吐字符串 "false" → 仍落 twin-auto（真值判断会把它误标成用户亲口嘱记）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `udirect-strict-${Date.now()}`;

    const payload = {
      scope: 'agent' as const,
      type: 'user' as const,
      title: '事件',
      slug: 'str-false',
      description: '一句话',
      content: '正文',
      // 模型按 JSON 示例的占位形态吐出字符串——类型上非法，运行时真会发生
      userRequested: 'false' as unknown as boolean,
    };
    const r = await applyOps(owner, [{ op: 'create-episode', payload }], 'capture');
    expect(r.errCount).toBe(0);

    const eps = await __scanAllActiveEpisodes(owner);
    const created = eps.find((e) => e.compressedPath.endsWith('str-false'));
    const abs = join(memoryRoot(owner), await expandPath(owner, created!.compressedPath));
    expect(await fs.readFile(abs, 'utf-8')).toContain('source: twin-auto');
  });
});

// ─── merge 与 user-direct：护栏已拆（2026-07-28），合并方向只由信息完整度决定 ──────

describe('merge-episodes 与 user-direct 标记', () => {
  const mkFrom = (slug: string, userRequested = false) => ({
    scope: 'agent' as const,
    type: 'user' as const,
    title: `事件 ${slug}`,
    slug,
    description: '一句话',
    content: '正文',
    userRequested,
  });

  it('机器版重复条并进 user-direct 幸存者：放行；幸存者原话不动、机器副本移出 active', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const owner = `merge-udirect-fold-${Date.now()}`;

    // 幸存者是用户亲手嘱记的权威版；被并入是机器版重复条
    const into = await applyOps(owner, [{ op: 'create-episode', payload: { ...mkFrom('user-kept', true), content: '用户原话不许改' } }], 'record');
    const from = await applyOps(owner, [{ op: 'create-episode', payload: mkFrom('auto-dup', false) }], 'record');
    const intoPath = into.results[0].ok ? into.results[0].detail! : '';
    const fromPath = from.results[0].ok ? from.results[0].detail! : '';

    // 纯折叠：不带 newBody/newDescription
    const merged = await applyOps(
      owner,
      [{ op: 'merge-episodes', mergeInto: intoPath, mergeFrom: [fromPath] }],
      'dream',
    );
    expect(merged.errCount).toBe(0);

    const eps = await __scanAllActiveEpisodes(owner);
    const survivor = eps.find((e) => e.compressedPath.endsWith('user-kept'));
    expect(survivor).toBeDefined(); // user-direct 幸存者仍活跃
    const abs = join(memoryRoot(owner), await expandPath(owner, survivor!.compressedPath));
    expect(await fs.readFile(abs, 'utf-8')).toContain('用户原话不许改'); // 原话没被动
    expect(eps.find((e) => e.compressedPath.endsWith('auto-dup'))).toBeUndefined(); // 机器副本移出
  });

  // 回归（cnv_TymI7oJum2）：护栏在时，dream 想把完整版正文写进 user-direct 幸存者会被拒，
  // 只能反过来把完整的那条归档、留下空洞的那条。拆护栏后这一步必须放行且正文真的被写进去。
  it('并进 user-direct 幸存者时带 newBody（补全正文）→ 放行，幸存者拿到完整内容', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const owner = `merge-udirect-rewrite-${Date.now()}`;
    const into = await applyOps(owner, [{ op: 'create-episode', payload: { ...mkFrom('u-keep', true) } }], 'record');
    const from = await applyOps(owner, [{ op: 'create-episode', payload: mkFrom('a-dup', false) }], 'record');
    const r = await applyOps(
      owner,
      [{ op: 'merge-episodes', mergeInto: into.results[0].ok ? into.results[0].detail! : '', mergeFrom: [from.results[0].ok ? from.results[0].detail! : ''], newBody: '补全后的完整正文' }],
      'dream',
    );
    expect(r.errCount).toBe(0);
    const eps = await __scanAllActiveEpisodes(owner);
    const survivor = eps.find((e) => e.compressedPath.endsWith('u-keep'));
    const abs = join(memoryRoot(owner), await expandPath(owner, survivor!.compressedPath));
    const text = await fs.readFile(abs, 'utf-8');
    expect(text).toContain('补全后的完整正文');
    expect(text).toContain('source: user-direct'); // 标记仍在，只是不再据此禁止操作
  });

  it('user-direct 条出现在 mergeFrom → 放行，且是 superseded 留链、不是真删', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const owner = `merge-udirect-from-${Date.now()}`;
    const into = await applyOps(owner, [{ op: 'create-episode', payload: mkFrom('into-auto', false) }], 'record');
    const from = await applyOps(owner, [{ op: 'create-episode', payload: { ...mkFrom('from-udirect', true) } }], 'record');
    const r = await applyOps(
      owner,
      [{ op: 'merge-episodes', mergeInto: into.results[0].ok ? into.results[0].detail! : '', mergeFrom: [from.results[0].ok ? from.results[0].detail! : ''] }],
      'dream',
    );
    expect(r.errCount).toBe(0);
    // 移出 active，但文件仍躺在 archived/ 里——风险下限由可回溯性兜住，不是真删
    const eps = await __scanAllActiveEpisodes(owner);
    expect(eps.find((e) => e.compressedPath.endsWith('from-udirect'))).toBeUndefined();
    const all = await fs.readdir(memoryRoot(owner), { recursive: true });
    expect(all.some((n) => String(n).includes('archived') && String(n).includes('from-udirect'))).toBe(true);
  });
});

// ─── m1：project 维度 episode 的 projectId 必须是已注册项目（拦孤儿目录） ──────

describe('create-episode：scope=project 的 projectId 校验', () => {
  const mkProjectPayload = (projectId: string, slug: string) => ({
    scope: 'project' as const,
    projectId,
    type: 'project' as const,
    title: `事件 ${slug}`,
    slug,
    description: '一句话',
    content: '正文',
  });

  /** 给 owner 写一份含指定 projectId 的 config.json */
  async function registerProject(owner: string, projectId: string): Promise<void> {
    const { configPath } = await import('../../electron/main/runtime/paths');
    const path = configPath(owner);
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(
      path,
      JSON.stringify({ projects: [{ id: projectId, path: ORU_DIR }], activeId: projectId }),
    );
  }

  it('record 填了未注册的 projectId（AI 自己编的项目名）→ 被拒、不落盘', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `proj-orphan-${Date.now()}`;

    const r = await applyOps(
      owner,
      [{ op: 'create-episode', payload: mkProjectPayload('safety-redundancy-swiss-ppt', 'orphan-1') }],
      'record',
    );
    expect(r.errCount).toBe(1);
    if (!r.results[0].ok) expect(r.results[0].error).toMatch(/不是已注册项目/);
    expect((await __scanAllActiveEpisodes(owner)).find((e) => e.compressedPath.endsWith('orphan-1'))).toBeUndefined();
  });

  it('record 填了已注册的真实 projectId → 正常落盘', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const owner = `proj-real-${Date.now()}`;
    await registerProject(owner, 'prj_real01');

    const r = await applyOps(
      owner,
      [{ op: 'create-episode', payload: mkProjectPayload('prj_real01', 'real-1') }],
      'record',
    );
    expect(r.errCount).toBe(0);
    expect((await __scanAllActiveEpisodes(owner)).find((e) => e.compressedPath.endsWith('real-1'))).toBeDefined();
  });

  it('capture 同样拦未注册 projectId（后台抓取也不许造幽灵项目）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const owner = `proj-orphan-cap-${Date.now()}`;

    const r = await applyOps(
      owner,
      [{ op: 'create-episode', payload: mkProjectPayload('made-up-proj', 'orphan-cap-1') }],
      'capture',
    );
    expect(r.errCount).toBe(1);
    if (!r.results[0].ok) expect(r.results[0].error).toMatch(/不是已注册项目/);
  });

  // ─── projectId 撞 agent scope 名（2026-07-26 dream 跑偏的起点） ───────────
  //
  // projects/twin/ 与 agents/twin/ 被 compressPath 压成同一形态 twin/<slug>，展开时首段
  // 等于 DEFAULT_AGENT_NAME 就恒判 agent scope——落在 projects/twin/ 下的 episode 从此
  // 只写得进、读不出。dream 每晚在索引里看见它、每晚 read_memory 报「文件不存在」。

  it('projectId 撞 DEFAULT_AGENT_NAME → 被拒（record）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const { DEFAULT_AGENT_NAME } = await import('../../electron/main/memory/paths');
    const owner = `proj-collide-rec-${Date.now()}`;
    await registerProject(owner, DEFAULT_AGENT_NAME); // 就算它"已注册"也不该放行

    const r = await applyOps(
      owner,
      [{ op: 'create-episode', payload: mkProjectPayload(DEFAULT_AGENT_NAME, 'collide-1') }],
      'record',
    );
    expect(r.errCount).toBe(1);
    if (!r.results[0].ok) expect(r.results[0].error).toMatch(/不能是 "twin"/);
    expect((await __scanAllActiveEpisodes(owner)).find((e) => e.compressedPath.endsWith('collide-1'))).toBeUndefined();
  });

  it('dream 纠错时把 scope 填成撞名 project → 被拒，且原 episode 不进回收站（回归）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { __scanAllActiveEpisodes } = await import('../../electron/main/memory/snapshot');
    const { DEFAULT_AGENT_NAME } = await import('../../electron/main/memory/paths');
    const owner = `proj-collide-correct-${Date.now()}`;

    // dream 不能 create-episode（铁规：只整理不新建），它造出撞名条目的唯一路径是
    // correct / merge 时把新 payload 的 scope 填成 project——而那两条路都会先 moveToTrash
    // 旧文件再建新的，所以撞名必须拦在移走之前，否则纠错失败＝原条目凭空消失。
    const created = await applyOps(
      owner,
      [{ op: 'create-episode', payload: { scope: 'agent' as const, type: 'user' as const, title: '原条', slug: 'keep-me', description: 'd', content: '原始内容' } }],
      'record',
    );
    const compressed = created.results[0].ok ? created.results[0].detail! : '';
    expect(compressed).toBeTruthy();

    const r = await applyOps(
      owner,
      [{
        op: 'correct-episode',
        oldPath: compressed,
        evidence: '原文如此',
        payload: mkProjectPayload(DEFAULT_AGENT_NAME, 'keep-me'),
      }],
      'dream',
    );
    expect(r.errCount).toBe(1);
    if (!r.results[0].ok) expect(r.results[0].error).toMatch(/不能是 "twin"/);

    // 原条目仍在活跃区——没被 moveToTrash 吞掉
    const eps = await __scanAllActiveEpisodes(owner);
    expect(eps.find((e) => e.compressedPath.endsWith('keep-me'))).toBeDefined();
  });

  it('撞名一旦落盘就读不回来——这是上面必须拦死的理由（绕过 op 层直接写盘取证）', async () => {
    const { writeEpisode } = await import('../../electron/main/memory/store');
    const { compressPath, expandPath } = await import('../../electron/main/memory/compressedPath');
    const { DEFAULT_AGENT_NAME } = await import('../../electron/main/memory/paths');
    const owner = `proj-collide-proof-${Date.now()}`;

    const rel = await writeEpisode({
      ownerId: owner,
      scopeName: 'project',
      scopeId: DEFAULT_AGENT_NAME,
      slug: 'unreachable',
      frontmatter: { scope: 'agent', status: 'active', created: '2026-07-18', title: 'T', description: 'D' },
      body: '正文',
    });
    expect(rel).toContain(`projects/${DEFAULT_AGENT_NAME}/episodes/`);

    // 压缩后与 agent scope 同形，展开只会去 agents/ 下找 → ENOENT
    const compressed = compressPath(rel);
    expect(compressed).toBe(`${DEFAULT_AGENT_NAME}/2026-07-18-unreachable`);
    await expect(expandPath(owner, compressed)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('正常 projectId 的压缩路径可逆（不误伤）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const owner = `proj-roundtrip-${Date.now()}`;
    await registerProject(owner, 'prj_real02');

    const r = await applyOps(
      owner,
      [{ op: 'create-episode', payload: mkProjectPayload('prj_real02', 'roundtrip-1') }],
      'record',
    );
    expect(r.errCount).toBe(0);
    const compressed = r.results[0].ok ? r.results[0].detail! : '';
    expect(await expandPath(owner, compressed)).toContain('projects/prj_real02/episodes/');
  });
});
