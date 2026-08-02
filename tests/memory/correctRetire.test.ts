/**
 * dream 纠错与淘汰 · 后端回归测试
 *
 * dream 纠错与淘汰 + 对话侧开放（S35·G102）· 后端回归测试
 * 对应技术方案 docs/tech/2026-06-12-dream-correct-retire-tech-design.md §4，叠加 S35 变更：
 * - retire-episode：dream + record（对话侧）白名单；capture/ui 拒绝（G67/G102）
 * - correct-episode：capture 拒绝（通道二只追加，G67）；record/dream 允许
 * - source 接线：userRequested → user-direct；supersede/correct 继承旧条标记
 *   （user-direct 硬护栏 2026-07-28 拆除，标记只余「用户嘱记过」的语义，不再禁止 dream 操作）
 * - corrected-at：dream 纠错产物带标记；evidence 进 changelog 不落 episode
 * - changelog：dream 全部写动作 + 任何 origin 的 correct/retire 各一行（G68 依据留痕）
 * - 读取侧：retired 不进 active 列表，includeSuperseded=true 可见（带 retiredReason）
 * - 归档：标记 superseded/retired 即物理移入 archived（G37）——readFm 回落 archived 兄弟路径
 *
 * 真实 tmp ORU_DIR + 动态 import，与 applyOps.test.ts 同模式。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EpisodeCreatePayload } from '../../shared/memory/operations';

const ORU_DIR = join(tmpdir(), `oru-test-correct-retire-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const OWNER = 'cr-owner';

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

/** 造一条 episode（经真实 applyOps），返回完整 relPath */
async function seedEpisode(slug: string, opts?: { userRequested?: boolean }): Promise<string> {
  const { applyOps } = await import('../../electron/main/memory/applyOps');
  const { expandPath } = await import('../../electron/main/memory/compressedPath');
  const payload: EpisodeCreatePayload = {
    scope: 'agent',
    type: 'user',
    title: `标题 ${slug}`,
    slug,
    description: `描述 ${slug}`,
    content: `正文 ${slug}`,
    sources: ['cnv_test'],
    userRequested: opts?.userRequested,
  };
  const r = await applyOps(OWNER, [{ op: 'create-episode', payload }], 'capture');
  expect(r.errCount).toBe(0);
  const compressed = (r.results[0] as { detail?: string }).detail ?? '';
  return expandPath(OWNER, compressed);
}

async function readFm(relPath: string): Promise<Record<string, unknown>> {
  const { memoryRoot } = await import('../../electron/main/memory/paths');
  const { readMarkdownFile } = await import('../../electron/main/fs/frontmatter');
  // G37：取代/退休即移入 archived——按活跃路径读不到时回落 archived 兄弟路径
  let f = await readMarkdownFile(join(memoryRoot(OWNER), relPath));
  if (!f && relPath.includes('/episodes/') && !relPath.includes('/episodes/archived/')) {
    const arch = relPath.replace(/\/episodes\/([^/]+)$/, '/episodes/archived/$1');
    f = await readMarkdownFile(join(memoryRoot(OWNER), arch));
  }
  return (f?.data ?? {}) as Record<string, unknown>;
}

async function readChangelogRaw(): Promise<string> {
  const { changelogPath } = await import('../../electron/main/memory/changelog');
  return fs.readFile(changelogPath(OWNER), 'utf-8').catch(() => '');
}

async function trashFiles(): Promise<string[]> {
  const { memoryRoot } = await import('../../electron/main/memory/paths');
  const dir = join(memoryRoot(OWNER), 'trash');
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let names: import('node:fs').Dirent[] = [];
    try {
      names = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      if (n.isDirectory()) await walk(join(d, n.name));
      else out.push(n.name);
    }
  }
  await walk(dir);
  return out;
}

describe('source 接线与继承', () => {
  it('userRequested=true → source=user-direct；缺省 → twin-auto', async () => {
    const relA = await seedEpisode('src-direct', { userRequested: true });
    const relB = await seedEpisode('src-auto');
    expect((await readFm(relA)).source).toBe('user-direct');
    expect((await readFm(relB)).source).toBe('twin-auto');
  });

  it('record_memory 的 schema 把 userRequested 列为必填（强迫表态，防静默虚设）', async () => {
    const { createMemoryTools } = await import('../../electron/main/memory/tools');
    const record = createMemoryTools().find((t) => t.name === 'record_memory');
    const schema = record?.inputSchema as { required?: string[] };
    expect(schema.required).toContain('userRequested');
  });

  it('显式 userRequested=false 也继承（false 是"这次非用户要求"，不是撤销保护）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const oldRel = await seedEpisode('inherit-false', { userRequested: true });
    const r = await applyOps(
      OWNER,
      [
        {
          op: 'supersede-episode',
          oldPath: oldRel,
          payload: {
            scope: 'agent',
            type: 'user',
            title: '演化',
            slug: 'inherit-false-v2',
            description: 'x',
            content: 'x',
            userRequested: false, // 模型显式给 false
          },
        },
      ],
      // capture 已收敛为只追加（G67），supersede 改由 record 走——继承语义与 origin 无关
      'record',
    );
    expect(r.errCount).toBe(0);
    const newRel = await expandPath(OWNER, (r.results[0] as { detail?: string }).detail ?? '');
    expect((await readFm(newRel)).source).toBe('user-direct');
  });

  it('record 的 correct 对 user-direct 放行（对话内用户亲口纠正）且新条继承标记；capture 被白名单拒', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const mkCorrect = (oldPath: string, slug: string) =>
      ({
        op: 'correct-episode' as const,
        oldPath,
        evidence: '用户当场说记错了',
        payload: {
          scope: 'agent' as const,
          type: 'user' as const,
          title: '当场纠正',
          slug,
          description: 'x',
          content: 'x',
        },
      });
    // 对话侧（record）：correct 放行 + 继承 user-direct
    const oldRel = await seedEpisode('inherit-cor', { userRequested: true });
    const r = await applyOps(OWNER, [mkCorrect(oldRel, 'inherit-cor-v2')], 'record');
    expect(r.errCount).toBe(0);
    const newRel = await expandPath(OWNER, (r.results[0] as { detail?: string }).detail ?? '');
    expect((await readFm(newRel)).source).toBe('user-direct');
    // capture（通道二）只追加，correct 被白名单拒（G67）
    const capRel = await seedEpisode('inherit-cor-cap');
    const rc = await applyOps(OWNER, [mkCorrect(capRel, 'inherit-cor-cap-v2')], 'capture');
    expect(rc.errCount).toBe(1);
    expect((rc.results[0] as { error?: string }).error).toContain('not allowed');
  });

  it('user-direct 条目被 supersede（record，未显式表态）→ 新条继承 user-direct', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const oldRel = await seedEpisode('inherit-sup', { userRequested: true });
    const r = await applyOps(
      OWNER,
      [
        {
          op: 'supersede-episode',
          oldPath: oldRel,
          payload: {
            scope: 'agent',
            type: 'user',
            title: '演化后',
            slug: 'inherit-sup-v2',
            description: '演化后的描述',
            content: '演化后的正文',
          },
        },
      ],
      'record',
    );
    expect(r.errCount).toBe(0);
    const newRel = await expandPath(OWNER, (r.results[0] as { detail?: string }).detail ?? '');
    expect((await readFm(newRel)).source).toBe('user-direct');
  });
});

describe('retire-episode', () => {
  it('dream 淘汰：status/retired-at/retired-reason 落盘 + 索引行消失 + changelog 一行', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { memoryIndexPath } = await import('../../electron/main/memory/paths');
    const rel = await seedEpisode('retire-me');
    const idxBefore = await fs.readFile(memoryIndexPath(OWNER), 'utf-8');
    expect(idxBefore).toContain('retire-me');

    const r = await applyOps(
      OWNER,
      [{ op: 'retire-episode', path: rel, reason: '对话内短期约定，过期不可感知' }],
      'dream',
    );
    expect(r.errCount).toBe(0);

    const fm = await readFm(rel);
    expect(fm.status).toBe('retired');
    expect(fm['retired-reason']).toBe('对话内短期约定，过期不可感知');
    expect(typeof fm['retired-at']).toBe('string');

    const idxAfter = await fs.readFile(memoryIndexPath(OWNER), 'utf-8');
    expect(idxAfter).not.toContain('retire-me');

    const log = await readChangelogRaw();
    expect(log).toContain('收起');
    expect(log).toContain('对话内短期约定，过期不可感知');
  });

  it('retire 白名单：capture / ui 拒绝，record（对话侧）允许（G102）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    // capture / ui：不在白名单，拒绝、状态不变
    const relBlocked = await seedEpisode('retire-wl-blocked');
    for (const origin of ['capture', 'ui'] as const) {
      const r = await applyOps(OWNER, [{ op: 'retire-episode', path: relBlocked, reason: 'x' }], origin);
      expect(r.errCount).toBe(1);
      expect((r.results[0] as { error?: string }).error).toContain('not allowed');
    }
    expect((await readFm(relBlocked)).status).toBe('active');
    // record：对话侧开放，用户当场收起即时生效
    const relRecord = await seedEpisode('retire-wl-record');
    const rr = await applyOps(
      OWNER,
      [{ op: 'retire-episode', path: relRecord, reason: '进行中状态已结束' }],
      'record',
    );
    expect(rr.errCount).toBe(0);
    expect((await readFm(relRecord)).status).toBe('retired');
  });

  it('reason 为空 → 拒绝', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const rel = await seedEpisode('retire-noreason');
    const r = await applyOps(OWNER, [{ op: 'retire-episode', path: rel, reason: '  ' }], 'dream');
    expect(r.errCount).toBe(1);
    expect((await readFm(rel)).status).toBe('active');
  });
});

// 护栏（source=user-direct 的条目 dream 一律不可动）2026-07-28 拆除。它保护的是承载事实的
// 那个文件而非事实本身，实测把合并方向逼反：dream 想把空洞条并进完整条被拒，只能反过来交出
// 退化结果。下面这组钉住「拆除后仍不丢数据」——每个写动作都可回溯（superseded 留链、correct
// 进回收站），且 user-direct 标记继续继承。
describe('user-direct 条目：dream 可整理，痕迹与可回溯性不丢', () => {
  it('retire user-direct → 放行（不是真删：状态标 retired，仍可 includeSuperseded 读回）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const rel = await seedEpisode('guard-retire', { userRequested: true });
    const r = await applyOps(
      OWNER,
      [{ op: 'retire-episode', path: rel, reason: '已升格进档案且无独立价值' }],
      'dream',
    );
    expect(r.errCount).toBe(0);
    expect((await readFm(rel)).status).toBe('retired');
  });

  it('correct user-direct → 放行，旧版进回收站、新版继承 user-direct 标记', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const rel = await seedEpisode('guard-correct', { userRequested: true });
    const r = await applyOps(
      OWNER,
      [
        {
          op: 'correct-episode',
          oldPath: rel,
          evidence: '用户原话：其实是硕士',
          payload: {
            scope: 'agent',
            type: 'user',
            title: '纠正后',
            slug: 'guard-correct-v2',
            description: '纠正后',
            content: '纠正后正文',
          },
        },
      ],
      'dream',
    );
    expect(r.errCount).toBe(0);
    // 旧版进回收站（可回溯），新版继承标记——用户意愿不因一次纠错而丢
    expect((await trashFiles()).some((n) => n.includes('guard-correct'))).toBe(true);
    const newRel = await expandPath(OWNER, (r.results[0] as { detail?: string }).detail ?? '');
    expect((await readFm(newRel)).source).toBe('user-direct');
  });

  // 回归：真实会话 cnv_TymI7oJum2 里 dream 三次 merge 全被护栏顶回，最终保留了信息量近乎为零的
  // 那条、把完整的那条归档。这里钉住「完整内容能被写进 user-direct 幸存者」——护栏在时这一步必拒。
  it('把完整内容并进 user-direct 幸存者（带 newBody）→ 放行，幸存者拿到完整正文', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { compressPath } = await import('../../electron/main/memory/compressedPath');
    const direct = await seedEpisode('merge-direct-sparse', { userRequested: true });
    const auto = await seedEpisode('merge-auto-full');
    const r = await applyOps(
      OWNER,
      [
        {
          op: 'merge-episodes',
          mergeInto: compressPath(direct),
          mergeFrom: [compressPath(auto)],
          newBody: '代尔夫特理工风景园林硕士 + 重庆大学本科',
        },
      ],
      'dream',
    );
    expect(r.errCount).toBe(0);
    const directFm = await readFm(direct);
    expect(directFm.status).toBe('active');
    expect(directFm.source).toBe('user-direct'); // 标记仍在，只是不再据此禁止操作
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { readMarkdownFile } = await import('../../electron/main/fs/frontmatter');
    const f = await readMarkdownFile(join(memoryRoot(OWNER), direct));
    expect(f?.content).toContain('代尔夫特理工风景园林硕士');
    expect((await readFm(auto)).status).toBe('superseded');
  });

  it('user-direct 出现在 mergeFrom → 放行，且是 superseded（进 archived 留链）而非真删', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { compressPath } = await import('../../electron/main/memory/compressedPath');
    const direct = await seedEpisode('merge-from-direct', { userRequested: true });
    const auto = await seedEpisode('merge-into-auto');
    const r = await applyOps(
      OWNER,
      [{ op: 'merge-episodes', mergeInto: compressPath(auto), mergeFrom: [compressPath(direct)] }],
      'dream',
    );
    expect(r.errCount).toBe(0);
    const fm = await readFm(direct);
    expect(fm.status).toBe('superseded');
    expect(fm['superseded-by']).toBeTruthy();
  });

  it('单个 op 失败不阻断同批其他 op：[retire 不存在的, retire 正常的] → 前者拒后者成', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const auto = await seedEpisode('batch-auto');
    const r = await applyOps(
      OWNER,
      [
        { op: 'retire-episode', path: 'agent/2026-01-01-nonexistent', reason: 'x' },
        { op: 'retire-episode', path: auto, reason: '寒暄' },
      ],
      'dream',
    );
    expect(r.errCount).toBe(1);
    expect(r.okCount).toBe(1);
    expect((await readFm(auto)).status).toBe('retired');
  });

  it('twin-auto 条目 dream 照常可 retire', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const rel = await seedEpisode('guard-pass');
    const r = await applyOps(
      OWNER,
      [{ op: 'retire-episode', path: rel, reason: '进行中状态已结束（来源对话已给出结果）' }],
      'dream',
    );
    expect(r.errCount).toBe(0);
    expect((await readFm(rel)).status).toBe('retired');
  });
});

describe('dream 纠错：corrected-at / evidence / changelog', () => {
  it('dream correct：新条带 corrected-at、不含 evidence；旧版进回收站；changelog 行含原文引用', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const rel = await seedEpisode('correct-me');
    const r = await applyOps(
      OWNER,
      [
        {
          op: 'correct-episode',
          oldPath: rel,
          evidence: '这是我第二次徒步',
          payload: {
            scope: 'agent',
            type: 'user',
            title: '改正后',
            slug: 'correct-me-fixed',
            description: '改正后的描述',
            content: '改正后的正文',
          },
        },
      ],
      'dream',
    );
    expect(r.errCount).toBe(0);

    const newRel = await expandPath(OWNER, (r.results[0] as { detail?: string }).detail ?? '');
    const fm = await readFm(newRel);
    expect(typeof fm['corrected-at']).toBe('string');
    // evidence 只进 changelog，不落 episode（frontmatter 与正文都不含）
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const raw = await fs.readFile(join(memoryRoot(OWNER), newRel), 'utf-8');
    expect(raw).not.toContain('这是我第二次徒步');

    expect((await trashFiles()).some((n) => n.includes('correct-me'))).toBe(true);

    const log = await readChangelogRaw();
    // 行格式：校对「标题」 旧路径 → 新路径：依据「原文」——新路径是前端「校对依据」的匹配锚点
    expect(log).toContain('校对「改正后」');
    expect(log).toContain('correct-me-fixed：依据「这是我第二次徒步」');
  });

  it('dream correct 保留旧条的 created——纠错不改变事件发生时间，列表日期不跳变', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const { agentEpisodesDir } = await import('../../electron/main/memory/paths');
    const { writeMarkdownFile } = await import('../../electron/main/fs/frontmatter');
    // 直接造一条 created=2026-01-15 的旧 episode
    const abs = join(agentEpisodesDir(OWNER), '2026-01-15-keep-created.md');
    await writeMarkdownFile(
      abs,
      {
        scope: 'agent', status: 'active', created: '2026-01-15', updated: '2026-01-15',
        source: 'twin-auto', title: '旧事', description: 'x', type: 'user', sources: [],
      },
      '旧正文',
    );
    const r = await applyOps(
      OWNER,
      [
        {
          op: 'correct-episode',
          oldPath: 'agents/twin/episodes/2026-01-15-keep-created.md',
          evidence: '原文',
          payload: { scope: 'agent', type: 'user', title: '改正', slug: 'keep-created-v2', description: 'x', content: 'x' },
        },
      ],
      'dream',
    );
    expect(r.errCount).toBe(0);
    const newRel = await expandPath(OWNER, (r.results[0] as { detail?: string }).detail ?? '');
    expect(newRel).toContain('2026-01-15'); // 文件名日期保留
    expect((await readFm(newRel)).created).toBe('2026-01-15');
  });

  it('record 的 correct 写 changelog 含依据（G68），但不带 corrected-at（那是 dream 专属标记）', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { expandPath } = await import('../../electron/main/memory/compressedPath');
    const rel = await seedEpisode('correct-record');
    const r = await applyOps(
      OWNER,
      [
        {
          op: 'correct-episode',
          oldPath: rel,
          evidence: '用户当场说：不是杭州，是苏州',
          payload: {
            scope: 'agent',
            type: 'user',
            title: '对话内纠正',
            slug: 'correct-record-v2',
            description: 'x',
            content: 'x',
          },
        },
      ],
      'record',
    );
    expect(r.errCount).toBe(0);
    // 依据落 changelog（可查），对话侧纠正也留痕
    const log = await readChangelogRaw();
    expect(log).toContain('校对「对话内纠正」');
    expect(log).toContain('依据「用户当场说：不是杭州，是苏州」');
    // corrected-at 是 dream 纠错产物的标记，record 侧不打
    const newRel = await expandPath(OWNER, (r.results[0] as { detail?: string }).detail ?? '');
    expect((await readFm(newRel))['corrected-at']).toBeUndefined();
  });
});

describe('changelog 形态', () => {
  it('dream 的 merge / retire 各记一行 changelog；夜记插在当夜标题之后、明细之前', async () => {
    // 注：档案升格（fact/portrait/self/项目）已改走 write/edit_memory 文档模型、不经 applyOps，
    // 故不再进 changelog 明细（由夜记叙述概括）；这里只验 episode 结构化 op 的逐行记录 + 夜记排序。
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { writeNightNote } = await import('../../electron/main/memory/changelog');
    const { compressPath } = await import('../../electron/main/memory/compressedPath');
    const a = await seedEpisode('cl-merge-a');
    const b = await seedEpisode('cl-merge-b');
    const c = await seedEpisode('cl-retire-c');
    await applyOps(
      OWNER,
      [
        { op: 'merge-episodes', mergeInto: compressPath(b), mergeFrom: [compressPath(a)] },
        { op: 'retire-episode', path: compressPath(c), reason: '寒暄，不构成长期记忆' },
      ],
      'dream',
    );
    const log = await readChangelogRaw();
    expect(log).toContain(`合并 ${compressPath(a)} → ${compressPath(b)}`);
    expect(log).toContain(`收起 ${compressPath(c)}`);

    await writeNightNote(OWNER, '今晚把几条徒步笔记并成了一条。');
    const log2 = await readChangelogRaw();
    const date = new Date().toISOString().slice(0, 10);
    const headingIdx = log2.indexOf(`## ${date}`);
    const noteIdx = log2.indexOf('今晚把几条徒步笔记并成了一条。');
    const firstDetailIdx = log2.indexOf('\n- ', headingIdx);
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    expect(noteIdx).toBeGreaterThan(headingIdx);
    expect(noteIdx).toBeLessThan(firstDetailIdx);
  });
});

describe('读取侧排除', () => {
  it('retired 不进 active 列表；includeSuperseded=true 时可见并带 retiredReason', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { listAllEpisodesWithSuperseded } = await import('../../electron/main/memory/store');
    const rel = await seedEpisode('list-retired');
    await applyOps(
      OWNER,
      [{ op: 'retire-episode', path: rel, reason: '寒暄，不构成长期记忆' }],
      'dream',
    );
    const active = await listAllEpisodesWithSuperseded(OWNER, false);
    expect(active.some((e) => e.relPath.includes('list-retired'))).toBe(false);
    const all = await listAllEpisodesWithSuperseded(OWNER, true);
    // G37：retire 即移入 archived，relPath 变成 archived 路径——按 slug 匹配
    const hit = all.find((e) => e.relPath.includes('list-retired'));
    expect(hit?.relPath).toContain('/episodes/archived/');
    expect(hit?.status).toBe('retired');
    expect(hit?.retiredReason).toBe('寒暄，不构成长期记忆');
  });
});

describe('dreamTools 薄壳守卫', () => {
  function toolCtx(): import('@shared/agent/backend').ToolContext {
    // satisfies 真接口——ToolContext 加必填字段时这里会红，不裸 as 蒙混
    return {
      conversationId: 'dream_test',
      agentId: 'agt_test',
      ownerId: OWNER,
      usage: 'memoryDream',
      approvalMode: 'work',
      abortSignal: new AbortController().signal,
    } satisfies import('@shared/agent/backend').ToolContext;
  }

  it('correct_episode 缺 evidence → isError，不落盘', async () => {
    const { __makeCorrectEpisodeTool } = await import('../../electron/main/memory/dreamTools');
    const rel = await seedEpisode('tool-noevidence');
    const tool = __makeCorrectEpisodeTool();
    const r = await tool.execute(
      {
        oldPath: rel,
        scope: 'agent',
        type: 'user',
        title: 'x',
        slug: 'tool-noevidence-v2',
        description: 'x',
        content: 'x',
      },
      await toolCtx(),
    );
    expect(r.isError).toBe(true);
    expect((await readFm(rel)).status).toBe('active');
  });

  it('retire_episode 缺 reason → isError，不落盘', async () => {
    const { __makeRetireEpisodeTool } = await import('../../electron/main/memory/dreamTools');
    const rel = await seedEpisode('tool-noreason');
    const tool = __makeRetireEpisodeTool();
    const r = await tool.execute({ path: rel }, await toolCtx());
    expect(r.isError).toBe(true);
    expect((await readFm(rel)).status).toBe('active');
  });

  // 对话侧 ctx（usage=twinMain）——工具按 usage 推导 origin='record'（S35·G102）
  function convCtx(): import('@shared/agent/backend').ToolContext {
    return {
      conversationId: 'conv_test',
      agentId: 'agt_test',
      ownerId: OWNER,
      usage: 'twinMain',
      approvalMode: 'work',
      abortSignal: new AbortController().signal,
    } satisfies import('@shared/agent/backend').ToolContext;
  }

  it('对话侧 retire_episode 收起 user-direct 条目（用户在场即时生效，G102）', async () => {
    const { __makeRetireEpisodeTool } = await import('../../electron/main/memory/dreamTools');
    const rel = await seedEpisode('conv-retire', { userRequested: true }); // user-direct
    const r = await __makeRetireEpisodeTool().execute(
      { path: rel, reason: '用户说这条不用留了' },
      convCtx(),
    );
    expect(r.isError).not.toBe(true);
    expect((await readFm(rel)).status).toBe('retired');
  });

  it('对话侧 correct_episode 纠正 user-direct 条目并把依据落 changelog', async () => {
    const { __makeCorrectEpisodeTool } = await import('../../electron/main/memory/dreamTools');
    const rel = await seedEpisode('conv-correct', { userRequested: true });
    const r = await __makeCorrectEpisodeTool().execute(
      {
        oldPath: rel,
        evidence: '用户当场纠正为苏州',
        scope: 'agent',
        type: 'user',
        title: '纠正后',
        slug: 'conv-correct-v2',
        description: 'x',
        content: 'x',
      },
      convCtx(),
    );
    expect(r.isError).not.toBe(true);
    const log = await readChangelogRaw();
    expect(log).toContain('校对「纠正后」');
    expect(log).toContain('依据「用户当场纠正为苏州」');
  });
});

describe('query_episodes 对 retired 的排除', () => {
  it('默认不出 retired；includeArchived=true 时可见', async () => {
    const { applyOps } = await import('../../electron/main/memory/applyOps');
    const { createMemoryTools } = await import('../../electron/main/memory/tools');
    const rel = await seedEpisode('query-retired');
    await applyOps(OWNER, [{ op: 'retire-episode', path: rel, reason: '寒暄' }], 'dream');
    const query = createMemoryTools().find((t) => t.name === 'query_episodes');
    expect(query).toBeDefined();
    const ctx = {
      conversationId: 'cnv_q',
      agentId: 'agt_q',
      ownerId: OWNER,
      usage: 'twinMain',
      approvalMode: 'work',
      abortSignal: new AbortController().signal,
    } satisfies import('@shared/agent/backend').ToolContext;
    const r1 = await query!.execute({}, ctx);
    expect(r1.text).not.toContain('query-retired');
    const r2 = await query!.execute({ includeArchived: true }, ctx);
    expect(r2.text).toContain('query-retired');
  });
});

describe('archiver 存量兜底（S35·G37 后：去掉 90 天门槛，扫任何仍在活跃目录的已标记条目）', () => {
  it('活跃目录里的 retired 条目（任意年龄）→ 兜底移入 episodes/archived/', async () => {
    const { archiveOldSuperseded } = await import('../../electron/main/memory/archiver');
    const { agentEpisodesDir } = await import('../../electron/main/memory/paths');
    const { writeMarkdownFile } = await import('../../electron/main/fs/frontmatter');
    const dir = agentEpisodesDir(OWNER);
    // 直接造两个 retired 遗留文件（跳过 markEpisodeRetired 的即时移入）：一个很旧、一个今天——
    // 都该被兜底搬走（不再有 90 天门槛）
    const today = new Date().toISOString().slice(0, 10);
    const files = [
      { name: '2025-01-01-old-retired.md', retiredAt: '2025-01-05' },
      { name: `${today}-fresh-retired.md`, retiredAt: today },
    ];
    for (const fdesc of files) {
      await writeMarkdownFile(
        join(dir, fdesc.name),
        {
          scope: 'agent', status: 'retired', created: '2025-01-01', updated: '2025-01-01',
          'retired-at': fdesc.retiredAt, 'retired-reason': 'x', source: 'twin-auto',
        },
        '旧正文',
      );
    }
    const moved = await archiveOldSuperseded(OWNER);
    expect(moved).toBeGreaterThanOrEqual(2);
    for (const fdesc of files) {
      await expect(fs.access(join(dir, fdesc.name))).rejects.toThrow();
      await expect(fs.access(join(dir, 'archived', fdesc.name))).resolves.toBeUndefined();
    }
  });
});
