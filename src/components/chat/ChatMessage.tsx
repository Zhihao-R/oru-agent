import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { CheckCircle2, ChevronRight, Circle, Clock, Loader2, Repeat, XCircle } from 'lucide-react';
import type { ChatMessage as Msg, ToolCall } from '@shared/types';
import { normalizeToolName } from '@shared/agent/toolName';
import { parseLoopCommand } from '@shared/loop/parseLoopCommand';
import { cn } from '@/lib/cn';
import { buildMessageSegments } from '@/lib/buildMessageSegments';
import { ToolCallLine } from './ToolCallLine';
import { TurnFileChangesStrip } from './TurnFileChangesStrip';
import { ScheduledTaskCreatedCards } from './ScheduledTaskCreatedCard';
import { AskUserChoiceSummary } from './AskUserChoiceCard';
import { CircuitBreakerCard } from './CircuitBreakerCard';
import { ChatMarkdown } from './ChatMarkdown';
import { StreamStatusBar } from './StreamStatusBar';
import { AttachmentGallery } from '../ui/AttachmentGallery';
import { AsideReferentCard } from './AsideReferentCard';
import { PendingDot } from './PendingDot';
import { useChatStore } from '@/stores/chatStore';

/**
 * 单个工具卡渲染分发。ask_user_choice 不走通用灰条卡：
 * - 已完成（有结果）→ 只读小结；
 * - 待答 / 出错 → 不渲染（待答由 message 末尾的 pending 交互卡承载，出错由模型文本承载）。
 */
function renderToolCard(tc: ToolCall, settled = false) {
  // claude-code 落盘的 name 带 mcp__oru__ 前缀，归一后再比对（否则回放退化成通用灰条卡）
  if (normalizeToolName(tc.name) === 'ask_user_choice') {
    return tc.result && !tc.result.isError ? <AskUserChoiceSummary key={tc.id} tool={tc} /> : null;
  }
  return <ToolCallLine key={tc.id} tool={tc} settled={settled} />;
}

/**
 * 单条聊天消息。导出包 memo：props 只有 message，父组件因无关原因重渲染时（置顶气泡 setPinnedMsg、
 * 滚动、会话状态变动），message 引用稳定 → 整条消息子树（其内所有 markdown）都不重渲染，治列表
 * 重渲染连坐整棵消息的 CPU 风暴（见 docs/plans/2026-08-03-…）。
 * 不会漏更新：组件内部大量 useChatStore(selector) 订阅是独立于 memo 的 store 订阅通道，store 真
 * 变化（新消息、流式进展）时 selector 变化会独立触发重渲染，与 memo 无关。
 */
export const ChatMessage = memo(function ChatMessage({ message }: { message: Msg }) {
  // turn-terminator 是 abort 时落盘给 LLM history 的标记，UI 不渲染卡片
  // （避免与同条 assistant message 末尾的"已中断"状态行重复）
  if (message.kind === 'turn-terminator') return null;
  // 随手评点指代卡：role 虽是 user，但渲染成紧凑指代卡而非用户气泡（payload 还原，
  // 与浮层同一组件）。左侧呈现——它是这场对话的"被指之物"，不是用户说的话。
  if (message.kind === 'aside-referent') {
    return (
      <div data-message-id={message.id} className="flex">
        <AsideReferentCard message={message} />
      </div>
    );
  }
  // 定时任务触发：role 虽是 user（要起回合让 Oru 执行），但渲染成居中触发卡而非用户气泡——
  // text 是喂模型的结构化 block，UI 只读 scheduledTrigger.title（技术设计 §四）。
  if (message.kind === 'scheduled-trigger') {
    return (
      <div data-message-id={message.id}>
        <ScheduledTriggerCard message={message} />
      </div>
    );
  }
  // 定时任务后台执行结果卡（S18）：居中一行，据 scheduledRun payload 渲染执行中/成功/失败三态。
  // 产出原文另走 kind='scheduled-run-output' 的正常 assistant 气泡（下面 AssistantBlock），正文不进卡。
  if (message.kind === 'scheduled-run') {
    return (
      <div data-message-id={message.id}>
        <ScheduledRunCard message={message} />
      </div>
    );
  }
  // v0.6：以 `（系统记：…）` 开头的 user 消息是 Oru 系统旁白（如"用户拒绝了提案"），
  // 落盘给 LLM 看不给用户看——避免在对话流出现"用户自己说了一段系统内部指令"
  if (message.role === 'user' && message.text.startsWith('（系统记：')) return null;
  if (message.role === 'user') return <UserBubble message={message} />;
  if (message.role === 'system') return <SystemNote message={message} />;
  return <AssistantBlock message={message} />;
});

// data-message-id：随手评点（aside）的消息指认锚点——⌥点消息时 resolver 凭它从
// chatStore 取原文与前后文（src/aside/resolve.ts）。三种消息根节点都挂。
function UserBubble({ message }: { message: Msg }) {
  const { t } = useTranslation('chat');
  const attachments = message.attachments ?? [];
  const hasText = message.text.trim().length > 0;
  // Steering「将生效」：忙时发出、还没被读入的消息——比已读入的淡一档（空心轮廓 + ◌），可撤回。
  const steering = message.steering;
  const withdrawSteering = useChatStore((s) => s.withdrawSteering);
  // /loop 指令气泡：前缀摘成一枚 loop 小标（与输入框标签、伴随卡徽章同语汇），正文只留目标——
  // 排队中与已生效同款呈现，用户分得出「这条排队的是开一个循环」。解析引用共享单源。
  const loopCmd = parseLoopCommand(message.text);
  const isLoopBubble = loopCmd.isLoop && loopCmd.goal.length > 0;
  const displayText = isLoopBubble ? loopCmd.goal : message.text;
  return (
    <motion.div
      data-message-id={message.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="flex justify-end"
    >
      <div className="flex max-w-[80%] flex-col items-end gap-1">
        <AttachmentGallery attachments={attachments} align="end" />
        {hasText ? (
            // 用户气泡：淡绿(accent-soft)底 + 墨字，圆角转硬（设计稿 4px 4px 1px 4px，右下 1px 小尖角）。
            // 主题色支出收拢——用户气泡只用淡绿而非实心绿，把实心绿省给按钮（2026-07-19 话-3）。
            // 将生效(steering)：同气泡降半透明 + ◌ 标记，比已读入淡一档，可撤回。
            <div
              className={cn(
                'flex items-start gap-1.5 rounded-sm rounded-br-[1px] bg-accent-soft px-3.5 py-2 text-md leading-relaxed text-text-primary',
                steering && 'opacity-60',
              )}
            >
              {steering ? <Circle size={12} strokeWidth={1.5} className="mt-1 shrink-0 opacity-70" /> : null}
              {isLoopBubble ? (
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded bg-elevated px-1.5 py-0.5 font-mono text-2xs font-medium text-accent">
                  <Repeat size={11} strokeWidth={2.2} />
                  loop
                </span>
              ) : null}
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{displayText}</p>
            </div>
        ) : null}
        {steering ? (
          <div className="flex items-center gap-1.5 px-1 text-xs text-text-tertiary">
            <span>{steering.state === 'withdrawing' ? t('message.steeringWithdrawing') : t('message.steeringQueued')}</span>
            {steering.state === 'queued' && message.clientMsgId ? (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => void withdrawSteering(message.conversationId, message.clientMsgId!)}
                  className="underline-offset-2 transition-colors duration-150 hover:text-text-secondary hover:underline"
                >
                  {t('message.withdraw')}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

function SystemNote({ message }: { message: Msg }) {
  return (
    <div data-message-id={message.id} className="flex justify-center">
      <p className="max-w-[80%] text-center text-xs text-text-tertiary">{message.text}</p>
    </div>
  );
}

// 定时任务触发卡：极简居中一行（时钟图标 + 「定时任务 · 任务名」），与 SystemNote 同视觉层级。
function ScheduledTriggerCard({ message }: { message: Msg }) {
  const { t } = useTranslation('chat');
  const title = message.scheduledTrigger?.title || t('message.scheduledTrigger');
  return (
    <div className="flex justify-center">
      <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
        <Clock size={12} strokeWidth={1.5} className="shrink-0" />
        <span>{t('message.scheduledTriggerLabel', { title })}</span>
      </div>
    </div>
  );
}

// 定时任务后台执行结果卡（S18）：居中一行，与触发卡同视觉层级（text-tertiary）。执行中来自
// scheduledRun.started 合成的临时卡（running）、成败来自落盘结果卡。产出正文不进卡（PM 拍板）。
function ScheduledRunCard({ message }: { message: Msg }) {
  const { t } = useTranslation('chat');
  const p = message.scheduledRun;
  const title = p?.title || t('message.scheduledRun'); // `||` 非 `??`：存量空串 title 也要兜住（打磨 6b）
  const state = p?.running ? 'running' : p?.status === 'error' ? 'error' : 'ok';
  const Icon = state === 'running' ? Loader2 : state === 'error' ? XCircle : CheckCircle2;
  return (
    <div className="flex justify-center">
      <div
        className={cn(
          'flex items-center gap-1.5 text-xs',
          state === 'error' ? 'text-warn' : 'text-text-tertiary',
        )}
      >
        <Icon size={12} strokeWidth={1.5} className={cn('shrink-0', state === 'running' && 'animate-spin')} />
        <span>{t(`message.scheduledRunLabel.${state}`, { title })}</span>
      </div>
    </div>
  );
}

function AssistantBlock({ message }: { message: Msg }) {
  const { t } = useTranslation('chat');
  const abort = useChatStore((s) => s.abort);
  const retryLast = useChatStore((s) => s.retryLast);
  // 该消息待答的提问卡（pending 态只活在实时流；execute 阻塞 → 永远在文本末尾，无需 textOffset 定位）
  // 注意：selector 只取原始 map（引用稳定），过滤派生放 useMemo——
  // 直接在 selector 里 Object.values().filter() 每次返回新数组，会让 useSyncExternalStore 无限重渲染。
  const pendingAsksMap = useChatStore((s) => s.pendingAsks);
  const pendingAsks = useMemo(
    () => Object.values(pendingAsksMap).filter((a) => a.messageId === message.id),
    [pendingAsksMap, message.id],
  );
  const pendingBreaksMap = useChatStore((s) => s.pendingBreaks);
  const pendingBreaks = useMemo(
    () => Object.values(pendingBreaksMap).filter((b) => b.messageId === message.id),
    [pendingBreaksMap, message.id],
  );
  const convId = message.conversationId;
  // 按真实时序把文本切片、与工具簇交错——文本段之间靠留白分隔（方案 A）
  const segments = buildMessageSegments(message.text, message.toolCalls);
  return (
    <motion.div
      data-message-id={message.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex flex-col gap-3">
        {segments.map((seg, i) =>
          seg.kind === 'tools' ? (
            <ToolCallStack key={`t${i}`} tools={seg.tools} settled={message.done} />
          ) : (
            <div key={`s${i}`} className="text-text-primary">
              <ChatMarkdown source={seg.text} />
            </div>
          ),
        )}
        {/* 回合级产物条：回合定居后聚合本轮落盘文件（方案 B，一条消息至多一张） */}
        {message.done ? <TurnFileChangesStrip toolCalls={message.toolCalls} /> : null}
        {/* 定时任务确认卡：本轮创建落盘的任务各给一张（频率+下次运行+管理跳转） */}
        {message.done ? <ScheduledTaskCreatedCards toolCalls={message.toolCalls} /> : null}
        {/* 待答追问沉到输入区停靠面板（话-1），流里只留一行锚点「等你回答 · 请于下方处理」 */}
        {pendingAsks.length > 0 ? (
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            <PendingDot />
            <span className="font-medium text-warn-deep">{t('dock.askAnchor')}</span>
          </div>
        ) : null}
        {pendingBreaks.map((brk) => (
          <CircuitBreakerCard key={brk.breakerId} brk={brk} />
        ))}
        {/* 状态行紧贴最新输出下方——三种进行中态 + 已中断/出错两种终态 */}
        <StreamStatusBar
          message={message}
          onStop={() => void abort(convId)}
          onRetry={() => void retryLast(convId)}
        />
      </div>
    </motion.div>
  );
}

// 同消息内工具簇的收起策略（2026-07-20 拍板）：
// - 已完成的调用：1 条贴行内一行；≥2 条收成计数行「N 个工具」（不带状态），点开才逐条列出。
// - 进行中/排队的调用：单独成行实时显示，不纳入收起。
// - 消息已定居（done，含中断落盘）：悬空 status 不再算"进行中"，全部按已完成收起。
// ask_user_choice 不算进收起——它要么是显眼的只读小结、要么不渲染（见 renderToolCard）。
function ToolCallStack({ tools, settled }: { tools: ToolCall[]; settled: boolean }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const askCards = tools.filter((tool) => normalizeToolName(tool.name) === 'ask_user_choice');
  const generic = tools.filter((tool) => normalizeToolName(tool.name) !== 'ask_user_choice');
  const isSettled = (tool: ToolCall) =>
    settled || tool.status === 'success' || tool.status === 'error';
  const finished = generic.filter(isSettled);
  const active = generic.filter((tool) => !isSettled(tool));

  const asks = askCards.length ? <>{askCards.map((tool) => renderToolCard(tool, settled))}</> : null;

  return (
    <div className="flex flex-col gap-1">
      {finished.length >= 2 ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="flex items-center gap-1.5 self-start rounded-xs px-1 py-0.5 text-xs text-text-tertiary transition-colors duration-150 hover:text-text-secondary"
          >
            <ChevronRight
              size={12}
              strokeWidth={1.5}
              className={cn('transition-transform duration-150', expanded && 'rotate-90')}
            />
            {expanded ? t('message.collapse') : t('message.toolFold', { count: finished.length })}
          </button>
          {expanded ? finished.map((tool) => renderToolCard(tool, settled)) : null}
        </>
      ) : (
        finished.map((tool) => renderToolCard(tool, settled))
      )}
      {active.map((tool) => renderToolCard(tool, settled))}
      {asks}
    </div>
  );
}


