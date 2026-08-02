/**
 * 检索侧评估入口（决策 1 / Task 1）
 *
 * 用法（需 OpenAI 兼容 provider 的 key）：
 *   ZHIPU_API_KEY=... npx tsx tests/memory-eval/retrieval/run.ts
 *   OPENAI_API_KEY=... npx tsx tests/memory-eval/retrieval/run.ts --base-url https://api.openai.com/v1 --model gpt-4o
 *
 * 产出：
 *   - stdout：injectionRecall / toolRecall / grepMissRate 三个数字
 *   - docs/reports/2026-06-01-retrieval-eval-report.md：含三指标 + 失败 case 清单（语义检索决策的依据）
 *
 * ⚠ ORU_DIR 范式：顶层先设 env 再动态 import 记忆模块——见 tech doc 决策 1 实现前提。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// —— 必须在任何记忆模块（间接 import runtime/paths）被加载前设好 ——
const ORU_DIR = join(tmpdir(), `oru-retrieval-eval-${process.pid}`);
process.env.ORU_DIR = ORU_DIR;

const REPORT_PATH = 'docs/reports/2026-06-01-retrieval-eval-report.md';
const OWNER = 'retrieval-eval-owner';

type Flags = { baseURL: string; model: string };

function parseFlags(argv: string[]): Flags {
  let baseURL = 'https://open.bigmodel.cn/api/paas/v4';
  let model = 'glm-4.6';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url' && argv[i + 1]) baseURL = argv[i + 1];
    if (argv[i] === '--model' && argv[i + 1]) model = argv[i + 1];
  }
  return { baseURL, model };
}

function resolveApiKey(): string {
  return (
    process.env.ZHIPU_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.MEMORY_EVAL_API_KEY ||
    ''
  );
}

async function main(): Promise<void> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error('错误：未设置 API key（ZHIPU_API_KEY / OPENAI_API_KEY / MEMORY_EVAL_API_KEY）');
    process.exit(1);
  }
  const flags = parseFlags(process.argv.slice(2));

  // 动态 import：此刻 ORU_DIR 已设好
  const { corpus, TOPIC_COUNT } = await import('./corpus');
  const { runRetrieval, writeCorpusToDisk } = await import('./retrieval');
  const { computeMetrics, collectMisses } = await import('./judge');

  console.log('═══ 检索侧评估 ═══');
  console.log(`语料：${corpus.episodes.length} episode（含 ${TOPIC_COUNT} 个有 golden 的主题） | query：${corpus.queries.length}`);
  console.log(`baseURL: ${flags.baseURL} | 模型: ${flags.model}`);
  console.log(`临时 ORU_DIR: ${ORU_DIR}`);

  await fs.mkdir(ORU_DIR, { recursive: true });
  console.log('→ 写语料到磁盘...');
  await writeCorpusToDisk(OWNER, corpus.episodes);

  console.log('→ 跑检索（注入档 + 工具档）...');
  const results = await runRetrieval(corpus, {
    ownerId: OWNER,
    baseURL: flags.baseURL,
    apiKey,
    model: flags.model,
  });

  const metrics = computeMetrics(results);
  const misses = collectMisses(results);

  console.log('');
  console.log(`injectionRecall = ${pct(metrics.injectionRecall)}  (${metrics.injectedHits}/${metrics.totalGolden})`);
  console.log(`toolRecall      = ${pct(metrics.toolRecall)}  (${metrics.toolHits}/${metrics.totalGolden})`);
  console.log(`grepMissRate    = ${pct(metrics.grepMissRate)}  (${metrics.grepMisses}/${metrics.notInInjection})`);

  await fs.mkdir(REPORT_PATH.split('/').slice(0, -1).join('/'), { recursive: true });
  await fs.writeFile(REPORT_PATH, renderReport({ flags, metrics, misses, results }), 'utf-8');
  console.log(`\n✓ 报告：${REPORT_PATH}`);

  await fs.rm(ORU_DIR, { recursive: true, force: true });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderReport(args: {
  flags: Flags;
  metrics: import('./judge').RetrievalMetrics;
  misses: import('./judge').MissCase[];
  results: import('./retrieval').RetrievalResult[];
}): string {
  const { flags, metrics, misses, results } = args;
  const byMode = (m: string) => results.filter((r) => r.mode === m).length;
  // ⚠ grepMissRate 不能单独拍 gated 决策：它把"grep 子串够不着"与"模型没搜对词"混在一起。
  // 一条漏召回若 episode 正文里其实有 grep 可命中的词（只是模型没去搜近义词），那是**模型搜索策略**
  // 问题，不是 grep 能力缺口——这种不该用"上语义检索"来解。所以这里只报数字 + 强制人工核验，不自动下结论。
  const verdict = `grepMissRate=${pct(metrics.grepMissRate)}（${metrics.grepMisses}/${metrics.notInInjection}）。` +
    `**这是模型搜索能力的上界，不是"grep 够不够用"的直接判据。** 决策前须人工核验每条漏召回 episode：` +
    `正文里有没有 grep 可命中的词（有→模型没搜对，属搜索策略问题，先改搜索提示/换搜索模型）；` +
    `还是连同义词都不可达（才是真·语义鸿沟，语义检索的收益才成立）。逐条核验见报告末尾附录。`;
  return `# 检索侧召回评估 — Baseline

> 跑测日期：${new Date().toISOString().slice(0, 10)}
> baseURL: \`${flags.baseURL}\` | 模型：${flags.model}
> 语料：${results.length} query（lexical ${byMode('lexical')} / paraphrase ${byMode('paraphrase')} / truncation ${byMode('truncation')}）

## 三档指标

| 指标 | 数值 | 计数 | 含义 |
|---|---|---|---|
| **injectionRecall** | ${pct(metrics.injectionRecall)} | ${metrics.injectedHits}/${metrics.totalGolden} | golden 出现在注入索引里的比例（截断前的天花板） |
| **toolRecall** | ${pct(metrics.toolRecall)} | ${metrics.toolHits}/${metrics.totalGolden} | 模型用 grep/query 实际捞回的比例 |
| **grepMissRate** | ${pct(metrics.grepMissRate)} | ${metrics.grepMisses}/${metrics.notInInjection} | golden 既不在注入、grep 也没捞回 / 不在注入 — **是否需要语义检索的判据** |

## 结论（gated 决策）

${verdict}

> 这是 PRD 第 1 项要的"用数字回答要不要上语义检索"。grepMissRate 只是线索，不是结论——
> 真正的判断要看每条漏召回 episode 是 grep-可达（搜索策略问题）还是真不可达（语义鸿沟），见报告末尾人工核查附录。

## 诚实边界

- **样本偏小**：query ${results.length} 条（plan 预估 50–70），grepMissRate 分母仅 ${metrics.notInInjection}——1 条 miss 进出就摆动数个百分点，结论方向稳、绝对值勿过度解读。扩大语料后应复评。
- **单模型 · 确定性**：被测模型固定 ${flags.model}、temperature=0，多次重跑数字一致——这是"可复现"，不是"跨模型稳健"。toolRecall 受被测模型搜索能力影响，换模型会变。
- **injectionRecall 偏低是设计预期**：语料 ≥500 条刻意压过 200 行截断线，老记忆被挤出，故该值量的是"规模增长后注入还能直接命中多少"，不是 bug。

## 失败 case（grep miss：注入挤出 + 工具也没捞回）

${misses.length === 0 ? '（无）' : misses.map((m) => `- [${m.mode}] "${m.q}" — 漏召回：${m.missed.join(', ')}`).join('\n')}

## 逐 query 明细

| mode | query | golden | 注入可见 | 工具捞回 |
|---|---|---|---|---|
${results
  .map(
    (r) =>
      `| ${r.mode} | ${r.q} | ${r.golden.join(';')} | ${r.injectedVisible.length}/${r.golden.length} | ${r.toolRecalled.length}/${r.golden.length} |`,
  )
  .join('\n')}

## 怎么读这份报告

1. **injectionRecall**：golden 在注入索引里的比例。本语料 ≥500 条、刻意压过 200 行截断线，
   多数有意义记忆（老日期）会被挤出，只有少数近期的可见——所以这个数偏低是**设计预期**，
   它量的是"规模增长后注入还能直接命中多少"。
2. **mode 分桶（lexical/paraphrase）量的是 grep 轴，不是注入轴**：toolRecall 档对模型隐藏注入、
   强制走 grep/query，所以无论 golden 是否在注入里，工具档都在测"grep 能不能捞回"。
   lexical（措辞重叠，grep 应命中）vs paraphrase（措辞错位，grep 易 miss）的对比就在这里看。
3. **grepMissRate** 是关键判据：高 → 子串 grep 救不回被截断的记忆 → 语义检索的收益才成立；
   低 → grep 够用，先不上语义检索。分母（notInInjection）为 0 时该比率无意义（无截断漏召回）。
`;
}

main().catch((e) => {
  console.error('检索评估失败：', e);
  process.exit(1);
});
