/**
 * Loop 模式独立审查员（v3 可见循环）——「验收」侧：读「验收标准 + 从 loop 起点以来的完整对话记录」
 * 盲判每一项达标没达标。无工具、无记忆、每轮新调用（学 Claude Code /goal 评估器）。
 *
 * ⚠ 沿革（防未来 session 误改）：2026-07-13 曾拍板「审查员带只读文件工具」——彼时清单型任务证据面为空，
 * one-shot 无工具的「不臆测」铁律逼它对文件类标准恒判 pending 到假交棒，故给只读工具让它亲自读产出核对。
 * 2026-07-24 v3 反转此拍板（PM 对话）：干活轮已搬进主对话流**可见执行**，关键产出与验证证据摊在对话里，
 * 审查员读对话记录即可盲判，不再需要工具。新兜底：干活轮 nudge 硬要求「把关键产出与验证证据摊进对话」，
 * 审查判 pending 时 reason 点名缺什么证据 → 主 agent 下一轮自纠（代价最坏浪费一轮）。
 * **别把「无工具」当疏漏改回去**——它是可见循环的地基，不是遗漏。详见 2026-07-24-loop-v3 实施方案 §3.3/§6。
 *
 * 纯函数（截断 / prompt 构建 / 响应解析）单独 TDD；LLM 调用照 compileChecklist 先例接 instrumentOneShot。
 */
import type { ChecklistItem } from '@shared/types';
import { getBackendFor } from '../agent/backends';
import { instrumentOneShot } from '../debug/instrument';
import { newMessageId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';

const REVIEW_TIMEOUT_MS = 120_000;

/**
 * 审查取样的字符预算（超窗截断阈值）——超出则从最旧轮起降级取样。这是「单次审查取样」上限，
 * 不是「盘上全量」：存储里 transcript 永远全量，截的只是喂给审查模型的这一次视图（§3.3）。
 * 阈值按审查模型窗口实测调（§7 开放项）；默认保守取值。
 */
export const REVIEW_TRANSCRIPT_BUDGET = 180_000;

/** 审查员读的对话记录单条（从 loop 起点以来，逐干活轮）——从存储 history 投影，解耦 store 便于测试。 */
export type ReviewTranscriptTurn = {
  /** 第几轮干活（1 起）。 */
  round: number;
  /** 主 agent 该轮的文本产出（含 subagent 产出摘要）。 */
  text: string;
  /** 该轮工具调用：调用名 + 结果全文。 */
  toolCalls: { name: string; detail: string }[];
};

export const REVIEW_SYSTEM_PROMPT = `你是 Loop 模式的独立审查员。干活的人在主对话里已经做完若干轮，现在由你——一个独立、冷静的第三方——只依据摊在对话里的证据，对照验收标准逐项核对每一项达标没达标。

铁律：
- **按时间序读**：对话记录按干活轮排列，后面轮次的产出覆盖前面的——同一处被反复改过，以最后一次为准，别拿早已被推翻的旧状态判。
- **只认摊出的证据**：判定只依据对话记录里真实出现的东西（工具调用与结果、写进对话的产出与验证）。干活的人**口头宣称**「我做到了 X」不算证据；证据不足以下判时，判 pending，并把**缺什么证据**写进 reason（例如「没看到 report.md 第三节的实际内容，请把它贴进对话」）。
- **理由具体到项、可执行**：pending 的 reason 要让干活的人一看就知道下一轮该补什么，别写「不够好」这种空话。
- 只有两种判定：satisfied（这一项确有证据支撑、达标了）/ pending（还没达标或证据不足）。没有第三种——主观「够不够好」拿不准的，也判 pending 并说明你需要什么才能确认，别替用户拍板放行。
- 你的**最后一条回复必须是一个纯 JSON 对象** { "verdicts": [{ "id", "verdict", "reason" }] }，不要包含 JSON 之外的文字。`;

/** 逐项判定输出 schema（satisfied | pending 两态）——期望形状的单一文档与测试断言依据。 */
export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'verdict', 'reason'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['satisfied', 'pending'] },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

// ─── 纯函数：超窗截断 ───────────────────────────────────────────

const SUMMARY_CAP = 60;

/** 工具结果 detail 压成摘要行（首行、截断）——超窗时保留调用名与摘要、掐掉全文。 */
function summarizeDetail(detail: string): string {
  const firstLine = detail.split('\n')[0] ?? '';
  return firstLine.length > SUMMARY_CAP ? `${firstLine.slice(0, SUMMARY_CAP)}…` : firstLine;
}

function turnSize(t: ReviewTranscriptTurn): number {
  return t.text.length + t.toolCalls.reduce((n, c) => n + c.name.length + c.detail.length, 0);
}

/** 按降级档位重塑一轮：0=全量、1=工具 detail 压摘要、2=整轮降为纯文本（丢工具调用）。 */
function degradeTurn(t: ReviewTranscriptTurn, level: 0 | 1 | 2): ReviewTranscriptTurn {
  if (level === 0) return t;
  if (level === 1) {
    return { ...t, toolCalls: t.toolCalls.map((c) => ({ name: c.name, detail: summarizeDetail(c.detail) })) };
  }
  return { ...t, toolCalls: [] };
}

/**
 * 超窗截断（§3.3）：transcript 超预算时从**最旧的轮**开始先掐工具结果 detail（保留调用名与摘要行），
 * 再整轮降为「主 agent 文本」；**最近两轮永远全量**。返回降级后的取样 + 是否发生压缩。纯函数。
 */
export function truncateTranscript(
  turns: ReviewTranscriptTurn[],
  budget: number,
): { turns: ReviewTranscriptTurn[]; compressed: boolean } {
  const total = turns.reduce((n, t) => n + turnSize(t), 0);
  if (total <= budget) return { turns, compressed: false };

  const PROTECTED = 2; // 最近两轮不降级
  const protectedFrom = Math.max(0, turns.length - PROTECTED);
  const levels: (0 | 1 | 2)[] = turns.map(() => 0);
  const sizeNow = () => turns.reduce((n, t, i) => n + turnSize(degradeTurn(t, levels[i])), 0);

  // 先把所有旧轮压到档位 1（最旧先），仍超再压到档位 2（最旧先）；旧轮全压到底还超只能作罢（最近两轮护住）。
  while (sizeNow() > budget) {
    let bumped = false;
    let done = false;
    for (let lvl = 1; lvl <= 2 && !done; lvl += 1) {
      for (let i = 0; i < protectedFrom; i += 1) {
        if (levels[i] < lvl) {
          levels[i] = lvl as 0 | 1 | 2;
          bumped = true;
          if (sizeNow() <= budget) {
            done = true;
            break;
          }
        }
      }
    }
    if (!bumped) break;
  }
  return { turns: turns.map((t, i) => degradeTurn(t, levels[i])), compressed: true };
}

// ─── 纯函数：prompt 构建 / 响应解析 ─────────────────────────────

/** 把一轮渲染成 prompt 文本块。 */
function renderTurn(t: ReviewTranscriptTurn): string {
  const tools = t.toolCalls.length
    ? t.toolCalls.map((c) => `  · 工具 ${c.name}：${c.detail}`).join('\n')
    : '  （无工具调用）';
  return `【第 ${t.round} 轮】\n${t.text || '（无文本）'}\n${tools}`;
}

/** 把验收标准 + 对话记录拼成审查 prompt。纯函数。compressed=true 时如实声明更早轮次已压缩。 */
export function buildReviewPrompt(
  checklist: Pick<ChecklistItem, 'id' | 'statement'>[],
  transcript: ReviewTranscriptTurn[],
  compressed: boolean,
): string {
  const itemsBlock = checklist.map((it) => `- [${it.id}] ${it.statement}`).join('\n');
  const transcriptBlock = transcript.length ? transcript.map(renderTurn).join('\n\n') : '（还没有干活记录）';
  const compressNote = compressed
    ? '\n\n> 注意：为放进上下文，更早轮次已压缩（工具结果只保留摘要，最早几轮只留主 agent 文本）。最近两轮为全量。判不准时以「证据不足」判 pending。\n'
    : '';

  return `请对照下面的验收标准，逐项核对干活的人做到没做到。只依据对话记录里摊出的证据，按时间序读、后面覆盖前面。

## 验收标准

${itemsBlock}

## 对话记录（从 loop 起点以来，逐轮）
${compressNote}
${transcriptBlock}

对每个检查项给出 verdict（satisfied / pending）和具体、可执行的 reason；证据不足一律 pending 并写清缺什么证据。`;
}

function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return raw;
  return raw.slice(start, end + 1);
}

/**
 * 解析审查员逐项判定，把判定合并回清单。纯函数、不抛：
 * - 漏判的项 → pending（回喂下一轮，不冒充满足）。
 * - 未知 verdict 值 → pending（无 uncertain 出口，主观项也是 pending + 说明缺什么）。
 * - 整段不可解析 → 全部 pending（loop 不被坏 JSON 杀死，下一轮再判）。
 * satisfied 无理由时不带 verdict（无内容的 verdict 是噪声）。
 */
export function parseReviewOutput(raw: string, checklist: ChecklistItem[]): ChecklistItem[] {
  const byId = new Map<string, { verdict: string; reason: string }>();
  try {
    const parsed = JSON.parse(extractJson(raw)) as {
      verdicts?: Array<{ id?: string; verdict?: string; reason?: string }>;
    };
    for (const v of parsed.verdicts ?? []) {
      if (typeof v.id === 'string') byId.set(v.id, { verdict: v.verdict ?? '', reason: v.reason ?? '' });
    }
  } catch {
    // 落空 → 全部 pending（见下）；不抛。
  }

  return checklist.map((it) => {
    const v = byId.get(it.id);
    const note = v?.reason ? { reason: v.reason } : undefined;
    if (v?.verdict === 'satisfied') return { ...it, status: 'satisfied' as const, verdict: note };
    return { ...it, status: 'pending' as const, verdict: note };
  });
}

// ─── LLM 调用工厂 ─────────────────────────────────────────────

/** 造一个 review 函数（内核 LoopDeps['review']）：读全量 transcript → 截断取样 → 盲判逐项。 */
export function makeReviewer(opts: {
  agentId: string;
  conversationId: string;
  agentName: string;
  /** 拉取从 loop 起点以来的完整对话记录（编排层从存储 history 投影）。 */
  getTranscript: () => Promise<ReviewTranscriptTurn[]>;
  /** 截断预算，缺省 REVIEW_TRANSCRIPT_BUDGET。 */
  budget?: number;
}): (checklist: ChecklistItem[], signal?: AbortSignal) => Promise<ChecklistItem[]> {
  return async (checklist, signal) => {
    const full = await opts.getTranscript();
    // 已停就别再发起后端查询（getTranscript 读盘那会儿用户可能刚按停）——abort 卫生，早退。
    if (signal?.aborted) throw new Error('loop 审查轮取消');
    const { turns, compressed } = truncateTranscript(full, opts.budget ?? REVIEW_TRANSCRIPT_BUDGET);
    const prompt = buildReviewPrompt(checklist, turns, compressed);

    const backend = await getBackendFor('loopReviewer');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REVIEW_TIMEOUT_MS);
    const onAbort = () => ac.abort();
    if (signal?.aborted) ac.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await instrumentOneShot(
        backend,
        {
          roundId: newMessageId(),
          conversationId: opts.conversationId,
          ownerId: getCurrentOwnerId(),
          agentId: opts.agentId,
          agentName: opts.agentName,
          source: 'loop_reviewer',
          userText: prompt,
        },
        () => backend.runOneShot({ prompt, systemContext: REVIEW_SYSTEM_PROMPT, outputSchema: REVIEW_OUTPUT_SCHEMA }, ac.signal),
        REVIEW_SYSTEM_PROMPT,
      );
      return parseReviewOutput(result, checklist);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
