/**
 * Subagent 底部聚合指示条（2026-07-29 拍板）——运行中的 subagent 沉到输入区上方，不占消息流。
 *
 * 两条运行时都收进同一条条（委派工具收敛 §6.1）：同步对话期 subagent（ChatMessage kind='subagent'）
 * 与后台异步子 agent（TaskStore 里本对话派出的 SubagentTask，status 在 INFLIGHT）。
 * 活物沉底、死物入流（与审批 dock、LoopBar 同一条规则）：运行中（含等确认）由本条聚合呈现，
 * 终态由各自完成卡承载——同步出 SubagentChip 完成卡、异步沿用 task-report 报告卡（P2 定案）。
 * 收起态一行只答「几个在进行、有没有要我这边的」；点条展开逐行看标题与当前动作；点条外收起。
 * 条内不做审批（归待决策停靠面板）、不做停止（停 subagent 走对话，与 loop 条同规矩）。
 * 设计与拍板记录：docs/prd/2026-07-29-subagent运行指示与完成卡-prd.md；
 * 视觉真源：docs/superpowers/mockups/2026-07-29-subagent底部聚合指示-demo.html（形态 A）；
 * 委派收敛：docs/tech/2026-08-02-委派工具收敛-tech-design.md §6
 */
import { Check, ChevronDown, ChevronRight, GitFork, Pause, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActionProposal, ChatMessage, SubagentActivity, SubagentTask } from "@shared/types";
import { toolActivityText } from "@shared/agent/toolActivity";
import { cn } from "@/lib/cn";
import { useIsReadonly } from "@/lib/approvalMode";
import { useChatStore } from "@/stores/chatStore";
import { useTaskStore } from "@/stores/taskStore";

const FLASH_MS = 1500;

/** 异步子 agent 视为「运行中」的状态集（委派收敛 §6.1） */
const TASK_INFLIGHT: ReadonlySet<SubagentTask['status']> = new Set([
  'pending',
  'running',
  'awaiting_twin',
  'awaiting_user',
]);

type FlashEntry = { id: string; title: string; ok: boolean; startedAt: number; activity?: SubagentActivity };

/** 归一行：同步/异步两源统一成同构渲染数据 */
type RowData = {
  id: string;
  title: string;
  startedAt: number;
  awaiting: boolean;
  activity?: SubagentActivity;
};

type PrevEntry = { title: string; startedAt: number; kind: 'sync' | 'async'; taskId?: string };

function isActiveChip(m: ChatMessage): boolean {
  return (
    m.kind === "subagent" &&
    m.subagent != null &&
    (m.subagent.status === "running" || m.subagent.status === "awaiting_approval")
  );
}

export function SubagentBar({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation("chat");
  const messages = useChatStore((s) => s.conversations[conversationId]);
  const tasks = useTaskStore((s) => s.tasks);
  const progressByTask = useTaskStore((s) => s.progressByTask);
  const proposalsByConv = useTaskStore((s) => s.proposalsByConv);
  // readonly 下 code 排队是「真审批」（归流内 CodeProposalCard 承载），不归「排队中」行——避免双呈现
  const isReadonly = useIsReadonly();

  const active = useMemo<RowData[]>(() => {
    const sync: RowData[] = (messages ?? [])
      .filter(isActiveChip)
      .map((m) => ({
        id: m.id,
        title: m.subagent!.description,
        startedAt: m.subagent!.startedAt ?? 0,
        awaiting: m.subagent!.status === "awaiting_approval",
        activity: m.subagent!.activity,
      }));
    // async 行统一以 proposalId 作键（运行行与排队行同一键，避免「排队 + 运行」双行并存）。
    // 排队→运行无缝接管：proposal.statusChanged(executing) 先到、task.started 后到，起跑瞬间
    // 既满足「排队（pending）」又还不到「有 task」——这里用 Map 以 proposalId 去重合并，
    // pending 排队源与 inflight task 源合流，不闪没、不双行。
    const asyncById = new Map<string, RowData>();
    // 源1：已起跑/运行中以 task 承载（status ∈ INFLIGHT），取真 proposalTitle
    for (const task of Object.values(tasks)) {
      if (task.conversationId !== conversationId) continue;
      if (!TASK_INFLIGHT.has(task.status)) continue;
      const key = task.proposalId ?? task.id;
      const p = progressByTask[task.id];
      const activity: SubagentActivity | undefined = p
        ? { source: p.source ?? 'speech', text: p.text, toolName: p.toolName, toolObject: p.toolObject }
        : undefined;
      asyncById.set(key, {
        id: key,
        title: task.proposalTitle,
        startedAt: task.startedAt,
        awaiting: task.status === "awaiting_user",
        activity,
      });
    }
    // 源2：排队未起跑（pending）或起跑中间帧（executing、task 未建）的 code 派工只有 proposal、
    // 无 task，标题用 proposal.title（改动点3）。executing 也收——后端先发 proposal.statusChanged(executing)、
    // 隔两个 await 才发 task.started，中间帧若只收 pending 会闪没（方案承诺"executing 不删行"）。
    // executing 且有 task 时已被上方源1 的 asyncById.has 挡住，不会重复。
    for (const p of (proposalsByConv[conversationId] ?? []) as ActionProposal[]) {
      if (p.kind !== 'code') continue;
      if (p.status !== 'pending' && p.status !== 'executing') continue;
      // readonly 下 code 排队是「真审批」（归流内 CodeProposalCard 承载），不归「排队中」行
      if (isReadonly) continue;
      const key = p.id;
      // 同 proposal 已有运行行则不重复（排队→运行接管由 task 承载）
      if (asyncById.has(key)) continue;
      asyncById.set(key, { id: key, title: p.title, startedAt: p.createdAt, awaiting: false });
    }
    const async: RowData[] = [...asyncById.values()];
    return [...sync, ...async].sort((a, b) => a.startedAt - b.startedAt);
  }, [messages, tasks, progressByTask, proposalsByConv, isReadonly, conversationId]);

  // 终态闪退：diff 出「上轮还在、这轮消失」的行，原位闪 1.5s。首次挂载 prev 为空集，
  // 天然不误闪；切会话靠 key 重挂双保险。timer 按 id 独立（批量清理会误伤先完成的），
  // 注册与清理同处可见；卸载时全清。
  const [flash, setFlash] = useState<FlashEntry[]>([]);
  const prevActiveRef = useRef<ReadonlyMap<string, PrevEntry>>(new Map());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const prev = prevActiveRef.current;
    const next = new Map<string, PrevEntry>();
    for (const c of messages ?? []) {
      if (isActiveChip(c) && c.subagent)
        next.set(c.id, { title: c.subagent.description, startedAt: c.subagent.startedAt ?? 0, kind: 'sync' });
    }
    // async 源（运行 + 排队）统一以 proposalId 作键，与上行 active 计算同源，保证闪退按键正确。
    // 排队源（proposal pending、无 task）不在此列——它还在排队时 prev/next 都有、不消失；
    // 起跑接管切 task 时同一 key 仍在（由运行源续上），不会误闪。
    for (const task of Object.values(tasks)) {
      if (task.conversationId !== conversationId) continue;
      if (TASK_INFLIGHT.has(task.status))
        next.set(task.proposalId ?? task.id, { title: task.proposalTitle, startedAt: task.startedAt, kind: 'async', taskId: task.id });
    }
    for (const p of (proposalsByConv[conversationId] ?? []) as ActionProposal[]) {
      // 与 active 源2 同口径：pending + 起跑中间帧 executing 都算"存在"，避免中间帧误闪没；
      // readonly 的 code 排队是「真审批」归流内卡，不进 prev/next（对称、不误闪）
      if (p.kind === 'code' && !isReadonly && (p.status === 'pending' || p.status === 'executing'))
        next.set(p.id, { title: p.title, startedAt: p.createdAt, kind: 'async' });
    }
    prevActiveRef.current = next;

    const disappeared = [...prev.keys()].filter((id) => !next.has(id));
    if (disappeared.length === 0) return;
    const entries: FlashEntry[] = [];
    for (const id of disappeared) {
      const p = prev.get(id);
      if (!p) continue;
      let ok: boolean | undefined;
      let activity: SubagentActivity | undefined;
      if (p.kind === 'sync') {
        // 查不到终态消息就不闪（如清空对话的竞态）——宁可不闪，不错报「✕ 失败」
        const terminal = (messages ?? []).find((m) => m.id === id);
        if (!terminal?.subagent) continue;
        ok = terminal.subagent.status === "completed";
        activity = terminal.subagent.activity;
      } else {
        const terminal = p.taskId != null ? tasks[p.taskId] : undefined;
        if (!terminal) continue;
        ok = terminal.status === "done";
        const pr = p.taskId != null ? progressByTask[p.taskId] : undefined;
        if (pr)
          activity = { source: pr.source ?? 'speech', text: pr.text, toolName: pr.toolName, toolObject: pr.toolObject };
      }
      entries.push({ id, title: p.title, ok, startedAt: p.startedAt, activity });
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setFlash((f) => f.filter((x) => x.id !== id));
      }, FLASH_MS);
      timersRef.current.set(id, timer);
    }
    if (entries.length > 0) setFlash((f) => [...f, ...entries]);
  }, [messages, tasks, progressByTask, proposalsByConv, isReadonly, conversationId]);
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // 点条外任意处收起：pointerdown 捕获在 document，与注册同处成对清理（LoopBar 同款）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = rootRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (active.length === 0 && flash.length === 0) return null;

  const awaitingCount = active.filter((r) => r.awaiting).length;
  // 多个同时完成时收起头只报最后一个（1.5s 窗口）——取舍：头是一行摘要，排队念完反而吵；
  // 期间 awaiting 警示让位给闪退词，闪完即恢复。
  const latestFlash = flash.length > 0 ? flash[flash.length - 1] : undefined;
  // 展开态逐行：进行中的按派出序，闪退行按原位置（startedAt）并进来
  const rows: Array<{ id: string; row?: RowData; flashEntry?: FlashEntry; startedAt: number }> = [
    ...active.map((r) => ({ id: r.id, row: r, startedAt: r.startedAt })),
    ...flash.map((f) => ({ id: f.id, flashEntry: f, startedAt: f.startedAt })),
  ].sort((a, b) => a.startedAt - b.startedAt);

  return (
    <div
      ref={rootRef}
      className={cn(
        "rounded-sm border bg-elevated text-sm transition-colors",
        awaitingCount > 0 ? "border-warn/45" : "border-accent-ring",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-text-tertiary"
      >
        <span className="inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-2xs font-medium text-accent">
          <GitFork size={11} strokeWidth={2} className="rotate-90" />
          subagent
        </span>
        {latestFlash ? (
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-1 font-medium",
              latestFlash.ok ? "text-success" : "text-danger",
            )}
          >
            {latestFlash.ok ? <Check size={12} strokeWidth={2.4} /> : <X size={12} strokeWidth={2.4} />}
            <span className="truncate">{latestFlash.title}</span>
            {latestFlash.ok ? t("subagentCard.status.done") : t("subagentCard.status.failed")}
          </span>
        ) : (
          <span className="font-medium tabular-nums text-text-secondary">
            {t("subagentBar.runningCount", { count: active.length })}
          </span>
        )}
        {!latestFlash && awaitingCount > 0 ? (
          <span className="font-medium text-warn">
            {t("subagentBar.awaitingCount", { count: awaitingCount })}
          </span>
        ) : null}
        <span className="ml-auto inline-flex flex-none items-center gap-1.5">
          {/* 闪退期间呼吸灯让位给成败符号——「✕ 失败」旁边亮 accent 脉冲是矛盾信号 */}
          {latestFlash ? (
            latestFlash.ok ? (
              <Check size={12} strokeWidth={2.4} className="text-success" />
            ) : (
              <X size={12} strokeWidth={2.4} className="text-danger" />
            )
          ) : (
            <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-accent" />
          )}
          {open ? (
            <ChevronDown size={13} strokeWidth={2} />
          ) : (
            <ChevronRight size={13} strokeWidth={2} />
          )}
        </span>
      </button>

      {/* 展开体随收起卸载——条内无草稿类组件态要保（不同于 LoopBar 的「加一项」，那边是隐藏非卸载） */}
      {open ? (
        <div className="border-t border-border">
          <div className="max-h-50 overflow-y-auto py-1">
            {rows.map((r) =>
              r.flashEntry ? (
                <FlashRow key={r.id} entry={r.flashEntry} doneLabel={t("subagentCard.status.done")} failedLabel={t("subagentCard.status.failed")} />
              ) : (
                <ActiveRow key={r.id} row={r.row!} awaitingLabel={t("subagentCard.status.awaiting")} />
              ),
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 进行中行：呼吸灯（running）/ Pause（等确认）+ 标题 + 右侧当前动作。 */
function ActiveRow({ row, awaitingLabel }: { row: RowData; awaitingLabel: string }) {
  const { t } = useTranslation("chat");
  const activity = row.activity;
  const activityText = activity
    ? activity.source === "tool"
      ? toolActivityText(activity.toolName ?? "", activity.toolObject, t)
      : activity.text
    : undefined;
  return (
    <div className="flex items-center gap-2.5 px-3.5 py-1.5">
      <span className="inline-flex w-3.5 shrink-0 justify-center">
        {row.awaiting ? (
          <Pause size={12} strokeWidth={2} className="text-warn" />
        ) : (
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
        )}
      </span>
      {/* 标题/动作都 flex-initial（demo 行规格）：标题只占内容宽，动作吃满剩余、过长才截断 */}
      <span
        className={cn(
          "min-w-0 flex-initial truncate text-sm",
          row.awaiting ? "text-warn" : "text-text-primary",
        )}
      >
        {row.title}
      </span>
      {activityText ? (
        <span
          className={cn(
            "ml-auto min-w-0 flex-initial truncate text-right text-xs",
            activity?.source === "tool" ? "text-text-quaternary" : "text-text-tertiary",
          )}
        >
          {activityText}
        </span>
      ) : null}
      {row.awaiting ? (
        <span className="flex-none text-xs text-warn">{awaitingLabel}</span>
      ) : null}
    </div>
  );
}

/** 终态闪退行：原位亮 1.5s 后退场；动作列保留（染成败色，demo 行规格）。 */
function FlashRow({ entry, doneLabel, failedLabel }: { entry: FlashEntry; doneLabel: string; failedLabel: string }) {
  const { t } = useTranslation("chat");
  const tone = entry.ok ? "text-success" : "text-danger";
  const activity = entry.activity;
  const activityText = activity
    ? activity.source === "tool"
      ? toolActivityText(activity.toolName ?? "", activity.toolObject, t)
      : activity.text
    : undefined;
  return (
    <div className="flex items-center gap-2.5 px-3.5 py-1.5">
      <span className="inline-flex w-3.5 shrink-0 justify-center">
        {entry.ok ? (
          <Check size={12} strokeWidth={2.4} className="text-success" />
        ) : (
          <X size={12} strokeWidth={2.4} className="text-danger" />
        )}
      </span>
      <span className={cn("min-w-0 flex-initial truncate text-sm", tone)}>
        {entry.title}
      </span>
      {activityText ? (
        <span className={cn("ml-auto min-w-0 flex-initial truncate text-right text-xs", tone)}>
          {activityText}
        </span>
      ) : null}
      <span className={cn("flex-none text-xs", tone)}>
        {entry.ok ? doneLabel : failedLabel}
      </span>
    </div>
  );
}
