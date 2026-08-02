/**
 * Loop 常驻条（2026-07-28 拍板，取代流内消息卡 LoopChecklistCard）——固定在输入区、todo 下方。
 *
 * 收起态一行只回答「loop 在跑、跑到哪」：徽章 + 状态词（第几轮/拆解中）+ n/m 项达标 +
 * 右侧呼吸灯（运行中，与 todo 进行项同语汇、不配文字）或终态词。点条展开看目标与全部验收
 * 标准（理由默认收起，点对应项才展开）；点条外任意处自动收起。运行中唯一控制是「加一项」——
 * 停止/划掉已退役（对话里说一声就能停，与普通对话同规矩）。终态（达标/到上限/被打断/失败）
 * 保持陈列，本会话下一条新消息到达即自动退场。视觉拍板 demo：
 * docs/superpowers/mockups/2026-07-28-loop常驻条-demo.html。
 */
import { Repeat, Check, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChecklistItem, LoopCardPayload } from "@shared/types";
import { cn } from "@/lib/cn";
import { wsClient } from "@/lib/ws";
import { useChatStore } from "@/stores/chatStore";
import { Button } from "../ui/Button";
import { loopCardStatus, type LoopCardTone } from "./loopCardStatus";

const TONE_TEXT: Record<LoopCardTone, string> = {
  running: "text-text-tertiary",
  done: "text-success",
  warn: "text-warn",
  muted: "text-text-tertiary",
  failed: "text-danger",
};
const TONE_DOT: Record<LoopCardTone, string> = {
  running: "bg-accent",
  done: "bg-success",
  warn: "bg-warn",
  muted: "bg-text-tertiary",
  failed: "bg-danger",
};

export function LoopBar({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation("chat");
  const messages = useChatStore((s) => s.conversations[conversationId]);
  const loopMsg = useMemo(() => {
    if (!messages) return undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.kind === "loop-checklist" && m.loopCard) return m;
    }
    return undefined;
  }, [messages]);
  const card = loopMsg?.loopCard;
  const terminal =
    card != null && card.phase !== "compiling" && card.phase !== "running";
  // 终态陈列到下一条消息为止——「之后有没有新消息」从持久数据客观派生（终态卡带 endedAt、
  // 消息带 createdAt），切会话/重启语义一致，不存组件本地态。老数据无 endedAt → 视为早已退场。
  const dismissed = useMemo(() => {
    if (!terminal || card == null) return false;
    if (card.endedAt == null) return true;
    const endedAt = card.endedAt;
    return (messages ?? []).some((m) => m.createdAt > endedAt);
  }, [terminal, card, messages]);

  const [open, setOpen] = useState(false);
  const [openReasons, setOpenReasons] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  // 点条外任意处收起：pointerdown 捕获在 document，与注册同处成对清理
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

  if (!card || dismissed) return null;

  const satisfied = card.checklist.filter(
    (it) => it.status === "satisfied",
  ).length;
  const status = loopCardStatus(card, t);
  const running = status.spinning;
  const toggleReason = (id: string) =>
    setOpenReasons((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div
      ref={rootRef}
      className={cn(
        "rounded-sm border bg-elevated text-sm transition-colors",
        running ? "border-accent-ring" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-text-tertiary"
      >
        <span className="inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-2xs font-medium text-accent">
          <Repeat size={11} strokeWidth={2.2} />
          loop
        </span>
        {/* 运行/编译中状态词放左侧（第几轮 / 拆解中）；终态词随基调色放右侧 */}
        {running ? (
          <span className="font-medium text-text-secondary">
            {status.statusText}
          </span>
        ) : null}
        {card.checklist.length > 0 ? (
          <span className="tabular-nums">
            {t("loop.progress", { satisfied, total: card.checklist.length })}
          </span>
        ) : null}
        {running ? (
          <span className="ml-auto h-[7px] w-[7px] animate-pulse rounded-full bg-accent" />
        ) : (
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 font-medium",
              TONE_TEXT[status.tone],
            )}
          >
            <span
              className={cn(
                "h-[7px] w-[7px] rounded-full",
                TONE_DOT[status.tone],
              )}
            />
            {status.statusText}
          </span>
        )}
      </button>

      {/* 收起=隐藏而非卸载：点外收起不吞「加一项」输入到一半的草稿，重新点开还在。 */}
      <div className={cn("border-t border-border", !open && "hidden")}>
        <div className="px-3.5 pb-1 pt-2.5 text-sm font-semibold tracking-tight text-text-primary">
          {card.goal}
        </div>
        {card.checklist.length > 0 ? (
          <div className="max-h-60 overflow-y-auto py-1">
            {card.checklist.map((it) => (
              <ChecklistRow
                key={it.id}
                item={it}
                reasonOpen={openReasons.has(it.id)}
                onToggle={() => toggleReason(it.id)}
              />
            ))}
          </div>
        ) : null}
        {card.phase === "running" ? (
          <AddItemControl loopId={card.loopId} t={t} />
        ) : null}
        {card.phase === "interrupted" ? (
          <div className="border-t border-border px-3.5 py-2.5 text-sm text-text-tertiary">
            {t("loop.interruptedHint")}
          </div>
        ) : null}
        {card.error ? (
          <div className="border-t border-border px-3.5 py-2.5 text-sm text-danger">
            {card.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 展开态单行：勾选圈 + 标准陈述；有理由（打回理由/通过说明）时点击行展开/收起理由。 */
function ChecklistRow({
  item,
  reasonOpen,
  onToggle,
}: {
  item: ChecklistItem;
  reasonOpen: boolean;
  onToggle: () => void;
}) {
  const { status, statement, verdict } = item;
  const satisfied = status === "satisfied";
  const reason = verdict?.reason?.trim();
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        disabled={!reason}
        className={cn(
          "flex w-full items-start gap-2.5 px-3.5 py-1.5 text-left",
          reason ? "transition-colors hover:bg-hover" : "cursor-default",
        )}
      >
        <span
          className={cn(
            "mt-px inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full",
            satisfied
              ? "bg-success-soft text-success"
              : "border-[1.5px] border-border-strong",
          )}
        >
          {satisfied ? <Check size={11} strokeWidth={3} /> : null}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 text-sm leading-snug",
            satisfied ? "text-text-primary" : "text-text-tertiary",
          )}
        >
          {statement}
        </span>
      </button>
      {reasonOpen && reason ? (
        <div className="mb-1.5 ml-[42px] mr-3.5 border-l-2 border-border pl-2 text-xs leading-snug text-text-tertiary">
          {reason}
        </div>
      ) : null}
    </div>
  );
}

/** 运行中唯一控制：加一项（下一轮边界并入）。 */
function AddItemControl({ loopId, t }: { loopId: string; t: TFunction }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const submitAdd = (): void => {
    const statement = text.trim();
    if (!statement) return;
    void wsClient
      .request({
        type: "loop.editChecklist",
        loopId,
        edit: { op: "add", item: { statement } },
      })
      .catch(() => {});
    setText("");
    setAdding(false);
  };
  return (
    <div className="border-t border-border px-3.5 py-2">
      {!adding ? (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setAdding(true)}
          leftIcon={<Plus size={12} strokeWidth={2.4} />}
        >
          {t("loop.addItem")}
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
              if (e.key === "Enter") submitAdd();
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder={t("loop.addItemPlaceholder")}
            className="min-w-0 flex-1 rounded-md border border-border bg-elevated px-2 py-1 text-sm text-text-primary outline-none focus:border-accent-ring"
          />
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={submitAdd}
            className="shrink-0"
          >
            {t("loop.addItemConfirm")}
          </Button>
        </div>
      )}
    </div>
  );
}
