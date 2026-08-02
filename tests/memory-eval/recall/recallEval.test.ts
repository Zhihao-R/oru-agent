/**
 * 召回评估 + 硬不变量（PRD §7）
 *
 * CI 可判定部分：① 说记必记「始终在场」（常驻，独立于召回挑选）② 删了即忘 ③ harness 计量自检
 *（用 tier1 BuiltinRecaller 作「确定性全召回」，无需模型）。
 * 真模型找回率（四桶、N≈1000、问法错开）走 gated 入口（ORU_RECALL_EVAL=1 + 配好 memoryRecall 模型才跑）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRecaller } from '@shared/memory/recall';

const ORU_DIR = join(tmpdir(), `oru-test-recalleval-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

/** 空召回器：什么都不召回（验「常驻不依赖召回」） */
const NULL_RECALLER: MemoryRecaller = { recall: async () => ({ selected: [] }) };

describe('§7 硬不变量（确定性，无需模型）', () => {
  it('说记必记·始终在场：必记信息进常驻档案，找回率恒 1.0，且不靠召回挑选', async () => {
    const { buildRecallCorpus } = await import('./corpus');
    const { writeRecallCorpus, measureFindRate } = await import('./recallEval');
    const owner = `must-${Date.now()}`;
    const corpus = buildRecallCorpus({ fillers: 8 });
    await writeRecallCorpus(owner, corpus);
    // 即便召回器什么都不给，必记桶也应 1.0（它在常驻 snapshot 里）
    const rates = await measureFindRate(owner, corpus, NULL_RECALLER);
    expect(rates['must-remember'].rate).toBe(1);
  });

  it('删了即忘：召回到的 episode 删文件后，同语料下不再被召回', async () => {
    const { BuiltinRecaller } = await import('../../../electron/main/memory/recall/builtin');
    const { writeRecallCorpus, assembleContext, deleteEpisode } = await import('./recallEval');
    const { buildRecallCorpus } = await import('./corpus');
    const owner = `forget-${Date.now()}`;
    const corpus = buildRecallCorpus({ fillers: 5 }); // 总数 ≤50 → tier1 全召回（确定性、无模型）
    await writeRecallCorpus(owner, corpus);
    const recaller = new BuiltinRecaller();
    const recentEp = corpus.episodes.find((e) => e.slug === 'huanfang')!;

    const before = await assembleContext(owner, '随便问一句', recaller);
    expect(before).toContain('TOKEN_RECENT'); // 删前能召回

    await deleteEpisode(owner, recentEp);
    const after = await assembleContext(owner, '随便问一句', recaller);
    expect(after).not.toContain('TOKEN_RECENT'); // 删后即忘（每轮重扫，无记忆化）
  });

  it('harness 计量自检：tier1 全召回下 episode 三桶 + 必记桶都 1.0', async () => {
    const { BuiltinRecaller } = await import('../../../electron/main/memory/recall/builtin');
    const { writeRecallCorpus, measureFindRate } = await import('./recallEval');
    const { buildRecallCorpus } = await import('./corpus');
    const owner = `harness-${Date.now()}`;
    const corpus = buildRecallCorpus({ fillers: 5 }); // ≤50 → tier1 全召回
    await writeRecallCorpus(owner, corpus);
    // 当前项目 = 跨项目桶所属项目：四桶都在候选范围内（全局 + 该项目），验 harness 计量本身正确。
    const rates = await measureFindRate(owner, corpus, new BuiltinRecaller(), corpus.crossProjectId);
    // tier1 把范围内全部 active episode 都带上 → 三个 episode 桶都找得到；必记走常驻
    expect(rates.recent.rate).toBe(1);
    expect(rates.distant.rate).toBe(1);
    expect(rates['cross-project'].rate).toBe(1);
    expect(rates['must-remember'].rate).toBe(1);
  });

  it('项目维粗筛（G20）：不在该项目回合，跨项目桶被排除（0），其余桶不受影响', async () => {
    const { BuiltinRecaller } = await import('../../../electron/main/memory/recall/builtin');
    const { writeRecallCorpus, measureFindRate } = await import('./recallEval');
    const { buildRecallCorpus } = await import('./corpus');
    const owner = `g20-${Date.now()}`;
    const corpus = buildRecallCorpus({ fillers: 5 });
    await writeRecallCorpus(owner, corpus);
    // 无当前项目（自由聊天 / 别的项目）：跨项目桶（prj_alpha 专属）应被粗筛排除，全局桶照进。
    const rates = await measureFindRate(owner, corpus, new BuiltinRecaller(), null);
    expect(rates.recent.rate).toBe(1); // 全局往事照进
    expect(rates.distant.rate).toBe(1); // 全局往事照进
    expect(rates['cross-project'].rate).toBe(0); // 其他项目的记忆不泄漏进本回合
    expect(rates['must-remember'].rate).toBe(1); // 必记走常驻，与召回无关
  });

  it('空召回器：episode 三桶找回率 0（证明它们确实靠召回、不在常驻），必记仍 1.0', async () => {
    const { writeRecallCorpus, measureFindRate } = await import('./recallEval');
    const { buildRecallCorpus } = await import('./corpus');
    const owner = `null-${Date.now()}`;
    const corpus = buildRecallCorpus({ fillers: 5 });
    await writeRecallCorpus(owner, corpus);
    const rates = await measureFindRate(owner, corpus, NULL_RECALLER);
    expect(rates.recent.rate).toBe(0);
    expect(rates.distant.rate).toBe(0);
    expect(rates['cross-project'].rate).toBe(0);
    expect(rates['must-remember'].rate).toBe(1);
  });
});

// 真模型找回率（四桶、问法错开、N≈1000）——gated：需 ORU_RECALL_EVAL=1 且配好 memoryRecall 模型。
// 跑法：ORU_RECALL_EVAL=1 npx vitest run tests/memory-eval/recall/recallEval.test.ts
describe.skipIf(process.env.ORU_RECALL_EVAL !== '1')('§7.1 真模型找回率（手动 eval）', () => {
  it('1000 条规模下，四桶找回率打印 + 必记桶不退化', async () => {
    const { BuiltinRecaller } = await import('../../../electron/main/memory/recall/builtin');
    const { writeRecallCorpus, measureFindRate } = await import('./recallEval');
    const { buildRecallCorpus } = await import('./corpus');
    const owner = `realeval-${Date.now()}`;
    const corpus = buildRecallCorpus({ fillers: 1000 }); // >50 → tier2 真 picker 模型
    await writeRecallCorpus(owner, corpus);
    const rates = await measureFindRate(owner, corpus, new BuiltinRecaller());
    // 机器可判定的打印——人看四桶率判断是否达标，并据此决定是否上语义档（§5.3 信号③）
    // eslint-disable-next-line no-console
    console.log('[recall-eval] find-rate by bucket:', JSON.stringify(rates, null, 2));
    expect(rates['must-remember'].rate).toBe(1); // 必记任何规模不退化（硬不变量）
  }, 600_000);
});
