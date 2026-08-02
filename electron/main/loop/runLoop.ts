/**
 * 可见循环内核 runLoop（v3）——把一次 loop 驱动成主对话上的若干个「干活轮 + 审查」。
 *
 * v2 的「后台三黑箱 + held 状态机 + 派工账本 + 拓扑批次调度」整体退场（见
 * docs/tech/2026-07-24-loop-v3-可见循环重构实施方案.md §1/§4）。v3 只做一件事：
 *   干活轮（一次可见主回合）→ 审查（读对话记录逐项盲判）→ 全 satisfied？
 *     是 → 汇报轮（审查结果做 nudge）→ 收敛
 *     否 → 到轮数上限？到 → 中止；没到 → 打回理由做 nudge 起下一干活轮
 *
 * 内核只管编排与判定；干活轮怎么跑（占闸、复用主回合装配）、审查怎么读 transcript，都由注入的 deps 承接，
 * 便于纯逻辑单测。abort 透传：runWorkTurn / review abort 时 throw，内核不 catch——用户叫停由编排层
 * 在 catch 里落 user-stopped 终态（对齐「abort 透传」既有约定，见 §3.2）。
 *
 * todo 与收敛判定零绑定：todo 是主 agent 干活轮自己的草稿纸（列不列按 todo 工具自身判据，
 * loop 不硬性要求——2026-07-28 去特殊化 T4），审查只看验收标准。
 */
import type { ChecklistItem, ChecklistEdit, LoopStopReason } from '@shared/types';
import { applyChecklistEdit } from './checklistEdit';
import { newTaskId } from '@shared/ids';

/** 轮边界拉取的控制意图——v3 只剩「改标准」（通病否决整链退场）。 */
export type LoopControlIntents = { edits?: ChecklistEdit[] };

export type LoopV3Deps = {
  maxRounds: number;
  goal: string;
  /** 编译产出的验收标准（续跑时 = 快照里的清单）。 */
  checklist: ChecklistItem[];
  /** 跑一个可见干活轮（占闸内复用主回合装配）；abort 时 throw 透传。 */
  runWorkTurn: (args: { round: number; nudge: string }) => Promise<void>;
  /** 独立审查员：读从 loop 起点以来的完整对话记录，逐项判 satisfied/pending，合并回清单。 */
  review: (checklist: ChecklistItem[], signal?: AbortSignal) => Promise<ChecklistItem[]>;
  /** 收敛后的汇报轮（审查结果做 nudge）；此后不再调审查员。 */
  runReportTurn: (args: { nudge: string }) => Promise<void>;
  /** 报进度（伴随卡逐项 verdict）。 */
  onProgress: (round: number, checklist: ChecklistItem[]) => void;
  /** 轮边界落运行态快照（跨重启轻量恢复）。 */
  persistSnapshot?: (snapshot: { round: number; checklist: ChecklistItem[] }) => Promise<void> | void;
  /** 轮边界拉取控制意图（改标准；拉后即清空累积）。 */
  pullControl?: () => LoopControlIntents;
  /** 取消信号，透传给 review。 */
  signal?: AbortSignal;
};

export type LoopOutcome = {
  checklist: ChecklistItem[];
  rounds: number;
  stopReason: LoopStopReason;
};

// ─── 纯函数（单独 TDD）───────────────────────────────────────

export function allSatisfied(checklist: ChecklistItem[]): boolean {
  return checklist.every((it) => it.status === 'satisfied');
}

/**
 * 干活轮 nudge 的固定骨架（§3.5）：总目标 + 当前验收标准全文 + 上轮逐项打回理由（首轮无）
 * + 两条硬要求（摊证据、首轮列 todo / 后续更新勾选）。纯函数。
 */
export function buildWorkNudge(goal: string, checklist: ChecklistItem[], round: number): string {
  const isFirst = round === 0;
  const list = checklist
    .map((it) => {
      const reason = it.status === 'pending' ? it.verdict?.reason?.trim() : undefined;
      return reason ? `- ${it.statement}\n  （上一轮被打回，理由：${reason}）` : `- ${it.statement}`;
    })
    .join('\n');

  // todo 判断权归还（2026-07-28 去特殊化 T4）：值不值得列由 todo 工具自身的判据定
  // （三步以上 / 一次交办好几件才列），loop 不另设硬性要求——列了就做一步标一步。
  const todoLine = isFirst
    ? '- 这轮的活值得列计划清单（按 todo 工具自身的判据）就用 todo 列出来，做一步标一步；小活不必列。'
    : '- 若你在维护 todo 清单：勾掉做完的、补上新发现的。';

  return `总目标：${goal}

对照下面这份验收标准，用你的工具**实际去做**把还没达标的推进到达标（别只口头描述）：

${list}

两条硬要求：
- 干完把关键产出与验证证据摊进对话（用 subagent 的话，把它的产出摘要也带回主对话）——审查员只看得到摊在对话里的东西，口头宣称不算。
${todoLine}`;
}

/** 汇报轮 nudge（§1「收敛后以审查结果为引导再响应一轮」）：逐项达标情况供主 agent 汇报。纯函数。 */
export function buildReportNudge(checklist: ChecklistItem[]): string {
  const list = checklist
    .map((it) => {
      const reason = it.verdict?.reason?.trim();
      return reason ? `- ${it.statement} —— ${reason}` : `- ${it.statement}`;
    })
    .join('\n');
  return `这一轮的验收标准已全部达标：

${list}

请向用户简要汇报这次 loop 做了什么、达成了什么（用平常对话的口吻，别复述这份清单本身）。`;
}

// ─── 内核循环 ───────────────────────────────────────────────

export async function runLoop(deps: LoopV3Deps): Promise<LoopOutcome> {
  let checklist = deps.checklist.map((it) => ({ ...it }));
  let round = 0;

  /** 轮顶消费改标准意图（下一轮生效；revise 把原 satisfied 项解锁回 pending）。 */
  const drainControl = (): void => {
    const intents = deps.pullControl?.();
    for (const e of intents?.edits ?? []) {
      checklist = applyChecklistEdit(checklist, e, { newId: () => newTaskId() });
    }
  };

  while (true) {
    // 轮顶先消费改标准——本轮按新清单干（不打断上一轮，改标准下一轮生效）。
    drainControl();

    // ① 干活轮（可见主回合）。abort → throw 透传（编排层落 user-stopped）。
    await deps.runWorkTurn({ round, nudge: buildWorkNudge(deps.goal, checklist, round) });
    round += 1;

    // ② 审查：读对话记录逐项盲判，合并回清单。
    checklist = await deps.review(checklist, deps.signal);
    deps.onProgress(round, checklist);
    await deps.persistSnapshot?.({ round, checklist });

    // ③ 全 satisfied → 汇报轮 → 收敛（此后不再调审查）。
    if (allSatisfied(checklist)) {
      await deps.runReportTurn({ nudge: buildReportNudge(checklist) });
      return { checklist, rounds: round, stopReason: 'all-satisfied' };
    }

    // ④ 到轮数上限 → 中止（改标准不归零：round 一路累加，上限管本次 loop 总消耗）。
    if (round >= deps.maxRounds) {
      return { checklist, rounds: round, stopReason: 'max-rounds' };
    }
  }
}
