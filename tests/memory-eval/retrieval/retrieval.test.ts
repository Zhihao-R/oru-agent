/**
 * 检索侧评估的可测部分单测（决策 1 / Task 1）
 *
 * 不需要 API key 的全部都在这里测：
 *  1. 语料不变量（≥500、覆盖 5 type、golden 指向真实 episode、时间跨度触发截断）
 *  2. **措辞错位守卫**——paraphrase query 与对应 episode 内容词零 bigram 重叠。
 *     这是合成语料最容易自欺的点：query 用词若无意中命中记忆，grep 会假装很准。
 *     这条断言机械地把"自欺"挡在外面——它失败就说明语料失真，必须改 corpus。
 *  3. judge.computeMetrics 三档指标的纯函数正确性
 *  4. 注入可见性 + 真实 buildSnapshot 截断（injection 档的 smoke，不需模型）
 *
 * ⚠ ORU_DIR 范式：顶层先设 env，记忆模块全部动态 import。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-retrieval-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

import { corpus, episodes, queries, goldenOf, type EpisodeFixture } from './corpus';
import { computeMetrics, collectMisses } from './judge';
import { injectedVisibleFor } from './retrieval';

// ─── 1. 语料不变量 ─────────────────────────────────────────

describe('corpus 不变量', () => {
  it('≥500 episode（压过 200 行注入截断线）', () => {
    expect(episodes.length).toBeGreaterThanOrEqual(500);
  });

  it('覆盖全部 5 种 type', () => {
    const types = new Set(episodes.map((e) => e.type));
    for (const t of ['user', 'feedback', 'project', 'reference', 'agent']) {
      expect(types.has(t as EpisodeFixture['type'])).toBe(true);
    }
  });

  it('每个 query 的 golden 都指向真实存在的 episode', () => {
    const allGolden = new Set(episodes.map(goldenOf));
    for (const q of queries) {
      for (const g of q.golden) {
        expect(allGolden.has(g), `golden 不存在：${g}（query="${q.q}"）`).toBe(true);
      }
    }
  });

  it('query 数量落在覆盖准则量级（≥15，覆盖 5 type × 失效模式）', () => {
    expect(queries.length).toBeGreaterThanOrEqual(15);
    // 三种失效模式都要有
    const modes = new Set(queries.map((q) => q.mode));
    expect(modes.has('paraphrase')).toBe(true);
    expect(modes.has('lexical')).toBe(true);
    expect(modes.has('truncation')).toBe(true);
  });

  it('时间跨度足够：存在 >3 天未更新的老 episode（触发 [N 天未更新]）', () => {
    const dates = episodes.map((e) => e.date).sort();
    // 最早一条远早于最近一条
    expect(dates[0] < '2026-02-01').toBe(true);
  });
});

// ─── 2. 措辞错位守卫（防自欺核心） ──────────────────────────

/**
 * 通用虚词 / 疑问词 / 代词 bigram —— 这些重叠不代表"grep 会命中内容"，从重叠判定里排除。
 *
 * ⚠ 这里**只允许放虚词**：代词、疑问词、助词、连接词、泛动作填充。
 * 绝不能放内容词（名词 / 领域动词）——内容词进停用表 = 真泄漏被静默放过，守卫就成了"假装严格"
 * （reviewer 点名的自欺点）。新增 query 若与 episode 共享一个不在表里的虚词 bigram 而误报，
 * 把那个**虚词** bigram 加进来；若共享的是内容词，那是真泄漏，去改 query 而不是加白名单。
 */
const STOPGRAMS = new Set([
  '我之', '之前', '那个', '的来', '来着', '你还', '还记', '记得', '得吗',
  '这事', '事你', '什么', '怎么', '么样', '是不', '不是', '这种', '东西', '一般',
  '平时', '通常', '后来', '的时', '时候', '我们', '我对', '我每', '我在', '我平',
  '我固', '这件', '件事', '这个', '一下', '记一', '一件', '我习', '我通',
  '是怎', '弄那', '个自', '是不是', '来的', '哪个', '叫什', '点钟', '几点', '钟爬',
  '爬起', '起来', '撑多', '多久', '久来', '到底', '是啥',
  '打算', '啥时', '交出', '出去', '应该', '什么样', '样的', '哪些', '不能',
  '能用', '怎样', '有什', '里大', '为什', '什么不', '不用', '哪一',
  '万一', '以后', '要按', '用什',
]);

/** 抽中文 bigram（连续两个 CJK 字符），过滤虚词 */
function contentBigrams(text: string): Set<string> {
  const chars = Array.from(text).filter((c) => /[一-鿿]/.test(c));
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const g = chars[i] + chars[i + 1];
    if (!STOPGRAMS.has(g)) grams.add(g);
  }
  return grams;
}

function overlap(q: string, ep: EpisodeFixture): string[] {
  const epGrams = contentBigrams(`${ep.title} ${ep.description} ${ep.body}`);
  const qGrams = contentBigrams(q);
  return [...qGrams].filter((g) => epGrams.has(g));
}

describe('措辞错位守卫', () => {
  const epByGolden = new Map(episodes.map((e) => [goldenOf(e), e] as const));

  it('每条 paraphrase query 与其 episode 零内容词重叠（grep 子串必 miss）', () => {
    for (const q of queries) {
      if (q.mode !== 'paraphrase') continue;
      const ep = epByGolden.get(q.golden[0])!;
      const ov = overlap(q.q, ep);
      expect(ov, `paraphrase query 措辞泄漏："${q.q}" 与 ${q.golden[0]} 共享内容词 ${ov.join(',')}`).toEqual([]);
    }
  });

  it('lexical query 确实与 episode 有重叠（对照组——否则不成其为对照）', () => {
    for (const q of queries) {
      if (q.mode !== 'lexical') continue;
      const ep = epByGolden.get(q.golden[0])!;
      expect(overlap(q.q, ep).length, `lexical query 反而零重叠："${q.q}"`).toBeGreaterThan(0);
    }
  });

  it('≥50% 的 query 与 episode 字面不重叠（金标准的硬约束）', () => {
    const nonOverlap = queries.filter((q) => overlap(q.q, epByGolden.get(q.golden[0])!).length === 0);
    expect(nonOverlap.length / queries.length).toBeGreaterThanOrEqual(0.5);
  });
});

// ─── 3. judge.computeMetrics 纯函数 ────────────────────────

describe('computeMetrics', () => {
  it('全部命中注入 → injectionRecall=100%、grepMissRate=0', () => {
    const m = computeMetrics([
      { q: 'a', mode: 'lexical', golden: ['twin/x'], injectedVisible: ['twin/x'], toolRecalled: [] },
    ]);
    expect(m.injectionRecall).toBe(1);
    expect(m.grepMissRate).toBe(0); // 分母（不在注入）为 0
  });

  it('注入挤出但 grep 捞回 → injectionRecall=0、toolRecall=100%、grepMissRate=0', () => {
    const m = computeMetrics([
      { q: 'a', mode: 'truncation', golden: ['twin/x'], injectedVisible: [], toolRecalled: ['twin/x'] },
    ]);
    expect(m.injectionRecall).toBe(0);
    expect(m.toolRecall).toBe(1);
    expect(m.grepMissRate).toBe(0);
  });

  it('注入挤出且 grep 也没捞回 → grepMissRate=100%', () => {
    const m = computeMetrics([
      { q: 'a', mode: 'paraphrase', golden: ['twin/x'], injectedVisible: [], toolRecalled: [] },
    ]);
    expect(m.grepMissRate).toBe(1);
    expect(m.grepMisses).toBe(1);
    expect(m.notInInjection).toBe(1);
  });

  it('多 golden 跨 query 聚合正确', () => {
    const m = computeMetrics([
      { q: 'a', mode: 'lexical', golden: ['p/1', 'p/2'], injectedVisible: ['p/1'], toolRecalled: ['p/2'] },
      { q: 'b', mode: 'paraphrase', golden: ['p/3'], injectedVisible: [], toolRecalled: [] },
    ]);
    expect(m.totalGolden).toBe(3);
    expect(m.injectedHits).toBe(1); // p/1
    expect(m.toolHits).toBe(1); // p/2
    expect(m.notInInjection).toBe(2); // p/2, p/3
    expect(m.grepMisses).toBe(1); // p/3
    expect(m.grepMissRate).toBeCloseTo(0.5);
  });

  it('collectMisses 列出注入挤出且工具没捞回的', () => {
    const misses = collectMisses([
      { q: 'hit', mode: 'lexical', golden: ['a/1'], injectedVisible: ['a/1'], toolRecalled: [] },
      { q: 'miss', mode: 'paraphrase', golden: ['a/2'], injectedVisible: [], toolRecalled: [] },
    ]);
    expect(misses).toHaveLength(1);
    expect(misses[0].q).toBe('miss');
    expect(misses[0].missed).toEqual(['a/2']);
  });
});

// ─── 4. 注入可见性 + 真实 buildSnapshot 截断（injection 档 smoke） ──

describe('injectedVisibleFor + 真实截断', () => {
  it('injectedVisibleFor 纯字符串包含判定', () => {
    const snap = '## Memory Index\n### user\n- twin/2026-01-01-foo: T - D\n';
    expect(injectedVisibleFor(snap, ['twin/2026-01-01-foo', 'twin/nope'])).toEqual(['twin/2026-01-01-foo']);
  });

  it('快照不再常驻事件索引（A7 砍 200 索引）——相关往事改走召回器，不靠静态注入可见性', async () => {
    // PRD §1/§5.2：老的「按比例+保底选 ≤200 行索引」是「不随规模 scale」的病灶（上千条只露两成、
    // 重要旧记忆静默掉出），已删。此处防回归：即便灌入大量 episode，buildSnapshot 也不再平铺它们。
    const owner = `noindex-${Date.now()}`;
    const { writeCorpusToDisk } = await import('./retrieval');
    const { buildSnapshot } = await import('../../../electron/main/memory/snapshot');
    const eps: EpisodeFixture[] = Array.from({ length: 30 }, (_, i) => ({
      scope: 'agent', type: 'user', slug: `ev-${i}`, date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
      title: `事件 ${i}`, description: `d${i}`, body: `b${i}`, tags: [],
    }));
    await writeCorpusToDisk(owner, eps);
    const snap = await buildSnapshot(owner, null);
    expect(snap).not.toContain('## Memory Index');
    // 任一 episode 的压缩路径都不应平铺进快照（它们由召回器按需注入，不再常驻）
    expect(injectedVisibleFor(snap, eps.map(goldenOf))).toEqual([]);
  }, 30_000);
});
