import { describe, it, expect, vi } from 'vitest';
import type { ChecklistItem, ChecklistEdit } from '@shared/types';
import {
  buildWorkNudge,
  buildReportNudge,
  allSatisfied,
  runLoop,
  type LoopV3Deps,
} from '../../electron/main/loop/runLoop';

function item(over: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return {
    id: over.id,
    statement: over.statement ?? `项 ${over.id}`,
    status: over.status ?? 'pending',
    verdict: over.verdict,
  };
}

// ─── 纯函数：干活轮 nudge 骨架（§3.5）───────────────────────────
describe('buildWorkNudge', () => {
  const checklist = [item({ id: 'c1', statement: '有第三节案例' }), item({ id: 'c2', statement: '总结呼应开篇' })];

  it('含总目标 + 当前验收标准全文', () => {
    const n = buildWorkNudge('写一份周报', checklist, 0);
    expect(n).toContain('写一份周报');
    expect(n).toContain('有第三节案例');
    expect(n).toContain('总结呼应开篇');
  });

  it('硬要求只剩摊证据；todo 判断权归工具判据（T4：判据句在、硬性句不在）', () => {
    const first = buildWorkNudge('写一份周报', checklist, 0);
    expect(first).toMatch(/摊进对话|证据/);
    // 首轮：引用 todo 工具自身判据，不再硬性要求先列
    expect(first).toMatch(/判据/);
    expect(first).toMatch(/todo/i);
    expect(first).not.toMatch(/先用 todo 工具把.*列出来/);

    // 后续轮：更新以「若在维护」为前提
    const later = buildWorkNudge('写一份周报', checklist, 2);
    expect(later).toMatch(/若你在维护/);
    expect(later).not.toMatch(/^- 更新你的 todo/m);
  });

  it('首轮无打回理由；后续轮把上轮逐项打回理由带上', () => {
    const first = buildWorkNudge('g', checklist, 0);
    expect(first).not.toMatch(/上一轮|被打回/);

    const rejected = [
      item({ id: 'c1', status: 'satisfied' }),
      item({ id: 'c2', status: 'pending', verdict: { reason: '没看到总结段落' } }),
    ];
    const later = buildWorkNudge('g', rejected, 2);
    expect(later).toContain('没看到总结段落');
  });
});

describe('buildReportNudge · 汇报轮含审查结果', () => {
  it('列出逐项达标情况供主 agent 汇报', () => {
    const done = [
      item({ id: 'c1', statement: '有第三节案例', status: 'satisfied' }),
      item({ id: 'c2', statement: '总结呼应开篇', status: 'satisfied', verdict: { reason: '末段回扣主旨' } }),
    ];
    const n = buildReportNudge(done);
    expect(n).toContain('有第三节案例');
    expect(n).toMatch(/达标|汇报|完成/);
  });
});

describe('allSatisfied', () => {
  it('全 satisfied → true；有一个 pending → false', () => {
    expect(allSatisfied([item({ id: 'a', status: 'satisfied' })])).toBe(true);
    expect(allSatisfied([item({ id: 'a', status: 'satisfied' }), item({ id: 'b', status: 'pending' })])).toBe(false);
  });
});

// ─── 内核循环 ───────────────────────────────────────────────
function makeDeps(over: Partial<LoopV3Deps> = {}): LoopV3Deps {
  return {
    maxRounds: 5,
    goal: 'g',
    checklist: [item({ id: 'c1' })],
    runWorkTurn: vi.fn(async () => {}),
    review: vi.fn(async (cl) => cl.map((it) => ({ ...it, status: 'satisfied' as const }))),
    runReportTurn: vi.fn(async () => {}),
    onProgress: vi.fn(),
    ...over,
  };
}

describe('runLoop · 收敛', () => {
  it('审查两轮 pending 后 satisfied → 恰好 3 干活轮 + 3 审查 + 1 汇报轮；汇报后不再审查', async () => {
    let call = 0;
    const review = vi.fn(async (cl: ChecklistItem[]) => {
      call += 1;
      const satisfied = call >= 3;
      return cl.map((it) => ({ ...it, status: satisfied ? ('satisfied' as const) : ('pending' as const) }));
    });
    const runWorkTurn = vi.fn(async () => {});
    const runReportTurn = vi.fn(async () => {});
    const outcome = await runLoop(makeDeps({ review, runWorkTurn, runReportTurn }));

    expect(runWorkTurn).toHaveBeenCalledTimes(3);
    expect(review).toHaveBeenCalledTimes(3);
    expect(runReportTurn).toHaveBeenCalledTimes(1);
    expect(outcome.stopReason).toBe('all-satisfied');
    expect(outcome.rounds).toBe(3);
  });

  it('汇报轮 nudge 含审查结果', async () => {
    const runReportTurn = vi.fn(async () => {});
    await runLoop(
      makeDeps({
        checklist: [item({ id: 'c1', statement: '开头抓人' })],
        runReportTurn,
      }),
    );
    const nudge = (runReportTurn as ReturnType<typeof vi.fn>).mock.calls[0][0].nudge as string;
    expect(nudge).toContain('开头抓人');
  });
});

describe('runLoop · 轮数上限', () => {
  it('恒 pending → 到上限中止，起 maxRounds 个干活轮、无汇报轮', async () => {
    const review = vi.fn(async (cl: ChecklistItem[]) => cl.map((it) => ({ ...it, status: 'pending' as const })));
    const runWorkTurn = vi.fn(async () => {});
    const runReportTurn = vi.fn(async () => {});
    const outcome = await runLoop(makeDeps({ maxRounds: 3, review, runWorkTurn, runReportTurn }));

    expect(runWorkTurn).toHaveBeenCalledTimes(3);
    expect(runReportTurn).not.toHaveBeenCalled();
    expect(outcome.stopReason).toBe('max-rounds');
    expect(outcome.rounds).toBe(3);
  });

  it('改标准后轮数不归零（上限管本次 loop 总消耗）', async () => {
    const edits: ChecklistEdit[] = [{ op: 'revise', id: 'c1', statement: '改后的标准' }];
    let pulled = false;
    const pullControl = vi.fn(() => {
      if (pulled) return {};
      pulled = true;
      return { edits };
    });
    const review = vi.fn(async (cl: ChecklistItem[]) => cl.map((it) => ({ ...it, status: 'pending' as const })));
    const runWorkTurn = vi.fn(async () => {});
    const outcome = await runLoop(makeDeps({ maxRounds: 3, review, runWorkTurn, pullControl }));

    // 改标准发生在某轮边界，但计数照走到 3——不因改标准重置
    expect(runWorkTurn).toHaveBeenCalledTimes(3);
    expect(outcome.rounds).toBe(3);
  });
});

// seed 续跑已随恢复路径退役（2026-07-28 去特殊化 T3）：「继续」起的是全新 loop、轮数重新计。

describe('runLoop · 快照与进度', () => {
  it('每轮 review 后落快照 + 报进度；不改动入参清单', async () => {
    const input = [item({ id: 'c1' })];
    const snapshots: number[] = [];
    const persistSnapshot = vi.fn(async (s: { round: number }) => {
      snapshots.push(s.round);
    });
    const onProgress = vi.fn();
    await runLoop(makeDeps({ checklist: input, persistSnapshot, onProgress }));

    expect(snapshots).toEqual([1]); // 首轮即 satisfied 收敛
    expect(onProgress).toHaveBeenCalled();
    expect(input[0].status).toBe('pending'); // 入参未被内核就地改写
  });
});
