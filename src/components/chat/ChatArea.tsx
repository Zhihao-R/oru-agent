import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useChatStore } from '@/stores/chatStore';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskStore } from '@/stores/taskStore';
import { wsClient } from '@/lib/ws';
import type { ConvHistoryResultEvent } from '@shared/protocol';
import type { ActionProposal, MemoryRecordPayload } from '@shared/types';
import { isUserAuthoredMessage } from '@shared/userTurn';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { TaskCard } from '../TaskCard';
import { foldBashProposalGroups } from '@/lib/foldBashProposalGroups';
import { foldSubagentGroups } from '@/lib/foldSubagentGroups';
import { detachAnchoredCards } from '@/lib/anchorCards';
import { AsyncTaskReportCard } from './AsyncTaskReportCard';
import { LoopBar } from './LoopBar';
import { SubagentBar } from './SubagentBar';
import { TodoPanel } from './TodoPanel';
import { PendingDecisionDock } from './PendingDecisionDock';
import { PendingDot } from './PendingDot';
import { MemoryRecordCard } from './MemoryRecordCard';
import { MemoryRecordOverlay } from './MemoryRecordOverlay';
import { ContextCompressedCard } from './ContextCompressedCard';
import { SkillModuleChip } from './SkillModuleChip';
import { SubagentGroup } from './SubagentChip';
import { EscalationBanner } from '../EscalationBanner';
import HomeLanding from '@/components/home/HomeLanding';
import { useLandingNavStore } from '@/stores/landingNavStore';
import { ScrollToLatestButton } from './ScrollToLatestButton';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import { useMarkDisplayedConvSeen } from '@/hooks/useMarkDisplayedConvSeen';
import { useVisionEnabled } from '@/hooks/useVisionEnabled';
import { parseCommand } from '@shared/platform/command';
import {
  desktopSlashDeps,
  runSlashCommand,
  shouldInterceptCommand,
  type SlashPanelState,
} from './slashCommands';
import { SlashCommandPanel } from './SlashCommandPanel';

// 稳定空数组：避免 zustand selector 每次返回新 [] 触发无限重渲染
const EMPTY_PROPOSALS: ActionProposal[] = [];

export default function ChatArea() {
  const { t } = useTranslation('chat');
  const conversations = useChatStore((s) => s.conversations);
  const error = useChatStore((s) => s.error);
  const send = useChatStore((s) => s.send);
  const loadHistory = useChatStore((s) => s.loadHistory);

  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const activeAgent = useAgentStore((s) =>
    s.agents.find((a) => a.id === s.activeAgentId) ?? null,
  );
  const activeConvId = useConversationStore((s) =>
    activeAgentId ? s.activeByAgent[activeAgentId] ?? null : null,
  );
  const openConversationAt = useConversationStore((s) => s.openConversationAt);
  const flashTarget = useConversationStore((s) => s.flashTarget);
  const clearFlashTarget = useConversationStore((s) => s.clearFlashTarget);
  const activeConv = useConversationStore((s) => {
    if (!activeAgentId || !activeConvId) return null;
    // byId 兜底：归档的 aside 对话不在 byAgent 主列表里（结构性缺席 conv.state），
    // 从归档分组打开时标题等元信息从 byId 取（fetchArchived / begin 都注册过）
    return s.byAgent[activeAgentId]?.find((c) => c.id === activeConvId) ?? s.byId[activeConvId] ?? null;
  });

  // pending 按 active conv 分桶读：A 在跑不会影响 B 的输入框状态
  const pending = useChatStore((s) =>
    activeConvId ? s.pendingByConv[activeConvId] ?? false : false,
  );

  // 记忆卡「查看」的浮层：状态提在这里而非卡片内——浮层要挂在滚动容器外，否则跟着消息滚、被裁剪
  const [memoryOverlay, setMemoryOverlay] = useState<MemoryRecordPayload | null>(null);

  // 斜杠命令面板（/help、无参 /model、命令反馈共用）——打下一条消息即收（onSend 里清）。
  const [slashPanel, setSlashPanel] = useState<SlashPanelState | null>(null);
  // 切对话即收：面板是 per-conv 状态，跨对话残留会把上一段的 /model 清单 / 反馈带进新对话。
  useEffect(() => {
    setSlashPanel(null);
  }, [activeConvId]);

  const auth = useSettingsStore((s) => s.authStatus);
  // v0.3：当前 twinMain 是否支持视觉 → ChatInput 的 📎 启停依据（主页启动器同口径，共用 hook）
  const { visionEnabled, visionDisabledHint } = useVisionEnabled();

  const messages = useMemo(
    () => (activeConvId ? conversations[activeConvId] ?? [] : []),
    [conversations, activeConvId],
  );
  const proposals = useTaskStore((s) =>
    activeConvId ? s.proposalsByConv[activeConvId] ?? EMPTY_PROPOSALS : EMPTY_PROPOSALS,
  );

  // 把 messages 和 proposals 按 createdAt 拼合时间序，再把相邻的 bash 提案折成一组（决策 2）
  const items = useMemo(() => {
    type Base =
      | { kind: 'message'; key: string; ts: number; data: (typeof messages)[number] }
      | { kind: 'proposal'; key: string; ts: number; data: (typeof proposals)[number] };
    const arr: Base[] = [];
    for (const m of messages) {
      // subagent 完成卡排「完成位置」（2026-07-29 拍板：新信息出现在视线所在的流尾）——
      // 终态 chip 带 completedAt 时以它为排序键；运行中 chip 反正由 SubagentBar 承载不进流。
      const ts = m.kind === 'subagent' && m.subagent?.completedAt ? m.subagent.completedAt : m.createdAt;
      arr.push({ kind: 'message', key: m.id, ts, data: m });
    }
    for (const p of proposals) {
      arr.push({ kind: 'proposal', key: `proposal_${p.id}`, ts: p.createdAt, data: p });
    }
    arr.sort((a, b) => a.ts - b.ts);
    // 折叠相邻 bash 提案为一组（决策 2，纯函数见 foldBashProposalGroups）；
    // 再把相邻终态 subagent 完成行折成「N 个 subagent」（2026-07-30 拍板，自成一类不与工具混计）
    const folded = foldSubagentGroups(foldBashProposalGroups(arr));
    // S1 回合内锚点：把带 anchorTo 的保留卡抽离顶层流，映射到所属回合 assistant 回复。
    // 渲染时对这些卡不按 createdAt 排序，而是插到对应 assistant 消息之后（修"自嗨汇报卡沉流尾"）。
    // 降级：匹配不到锚定消息的卡留在顶层流沉尾，不丢；老卡无 anchorTo 行为不变。
    return detachAnchoredCards(folded);
  }, [messages, proposals]);

  // 滚动容器/内容层收成 state 而非 ref：两者都由条件渲染挂出（草稿态早返回 HomeLanding），
  // 元素身份变化必须让下面依赖它们的 effect 重跑——否则从别处回到对话时容器换了新节点，
  // 贴底与置顶气泡的监听器都装在已卸载的旧节点上。
  // ref 只能挂 setter 本身（身份稳定），别改写成内联箭头：那样每次渲染都 null→node 抖一次，
  // 观察器反复重建、贴底反复复位。
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);

  // 置顶气泡＝「当前可视内容的上一条用户消息」：最后一条已滚出视口上缘的用户消息——
  // 屏幕上正在看的回复就是在答它。往回翻到更早的轮次，置顶随之切到那一轮的指令；
  // 第一条用户消息还在屏内时无东西可提醒，隐藏。滚动 + 流式撑高都要重算（rAF 节流）。
  const [pinnedMsg, setPinnedMsg] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    const root = scrollEl;
    if (!root) {
      setPinnedMsg(null);
      return;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      const candidates = new Map(
        messages
          .filter(isUserAuthoredMessage)
          .map((m) => [m.id, m]),
      );
      // 一次 querySelectorAll 拿全量锚点（避免逐条 querySelector 反复走 DOM 树），倒序找
      // 最后一条底边已滚出视口上缘的用户消息；底部候选通常首条即中，提前 break
      const contTop = root.getBoundingClientRect().top;
      const nodes = root.querySelectorAll('[data-message-id]');
      let found: { id: string; text: string } | null = null;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const m = candidates.get(nodes[i].getAttribute('data-message-id') ?? '');
        if (!m) continue;
        if (nodes[i].getBoundingClientRect().bottom <= contTop) {
          found = m;
          break;
        }
      }
      setPinnedMsg((prev) => (prev?.id === found?.id ? prev : found));
    };
    // 滚动与流式撑高共用一路 rAF 调度：同帧多次触发合并成一次扫描
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    schedule();
    root.addEventListener('scroll', schedule, { passive: true });
    return () => {
      root.removeEventListener('scroll', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [messages, activeConvId, scrollEl]);

  // 切换 conversation 时主动拉一次历史（如果本地 bucket 为空）
  useEffect(() => {
    if (!activeAgentId || !activeConvId) return;
    const local = useChatStore.getState().conversations[activeConvId];
    if (local && local.length > 0) return;
    void wsClient
      .request<ConvHistoryResultEvent>({
        type: 'conv.history',
        agentId: activeAgentId,
        conversationId: activeConvId,
      })
      .then((res) => {
        if (res.type === 'conv.history.result') {
          loadHistory(res.conversationId, res.messages);
        }
      })
      .catch(() => {
        // 静默
      });
  }, [activeAgentId, activeConvId, loadHistory]);

  // 停留在显示中的对话里时，它的更新（含 Oru 输出完成刷新 updatedAt）随手标已读——
  // 否则水位停在打开那一刻，对话完成会把它误判成「待验收」。
  useMarkDisplayedConvSeen(activeAgentId, activeConvId, activeConv?.updatedAt);

  // 搜索命中跳转点亮：切到该对话、消息就绪后，滚到那条消息并闪一下。
  // 依赖 messages——历史还没加载到时找不到元素，effect 会在 messages 变化时重跑直到命中。
  useEffect(() => {
    if (!flashTarget || flashTarget.convId !== activeConvId) return;
    const el = scrollEl?.querySelector<HTMLElement>(
      `[data-message-id="${flashTarget.messageId}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('oru-flash');
    const timer = setTimeout(() => el.classList.remove('oru-flash'), 1900);
    clearFlashTarget();
    return () => clearTimeout(timer);
  }, [flashTarget, activeConvId, messages, clearFlashTarget, scrollEl]);

  // 贴底/自由浏览状态机：流式期间向上滚不再被拉回，离开底部时显示"回到最新"按钮；
  // 切换 conversation、或从别处回到对话（容器换新实例）自动重置回贴底。
  const { stuckToBottom, scrollToBottom } = useStickToBottom(scrollEl, contentEl, activeConvId);

  // 屏幕由「当前线 + 有无活跃对话」决定（见下方分支）。line = 当前线（点击驱动）。
  const line = useLandingNavStore((s) => s.line);
  const inputDisabled = !auth.ready || !activeAgentId;

  // 普通发送：直接发到当前对话。斜杠命令先过 parseCommand（与平台同源解析）——命中则执行、
  // 不进 chatStore.send；拦截边界（附件 / 桌面豁免 /status）收在 shouldInterceptCommand 一处。
  // 任何发送都顺手收掉命令面板（打下一条即收）。
  const onSend: React.ComponentProps<typeof ChatInput>['onSend'] = (text, attachments) => {
    setSlashPanel(null);
    if (activeAgentId && activeConvId) {
      const cmd = parseCommand(text);
      if (shouldInterceptCommand(cmd, !!attachments?.length)) {
        void runSlashCommand(cmd, { agentId: activeAgentId, convId: activeConvId }, desktopSlashDeps, t)
          .then(setSlashPanel)
          .catch(() => setSlashPanel({ kind: 'message', text: t('slash.failed') }));
        return;
      }
    }
    void send(text, attachments);
  };

  const headerTitle = activeConv?.title ?? t('newConvTitle');
  // 副标签展示当前对象（分身/agent）的名字——用户可改名、后续也有不同 agent，故取变量值
  const agentName = activeAgent?.name ?? 'Oru';

  // 手账线 → 手账页；对话线且无活跃对话 → 新建对话页。两者同一套完整着陆面（启动器 + 手账），
  // 区别只在进入落点（手账页落昨夜、新建页落顶部，由 scrollRequest 控制）与高亮（line 决定）。
  // 发消息建对话后 setActive 切对话线 + activeConvId 非空，本组件重渲染即落到下方消息流。
  if (line === 'memory' || activeConvId == null) return <HomeLanding />;

  return (
    // data-chat-area：随手评点（aside）的对话区标记——⌥点这里面的空白时，
    // resolver 给 blank 档带上最近几条消息作上下文（src/aside/resolve.ts）
    <section
      data-chat-area
      data-aside-region="chat"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-canvas"
    >
      {/* 对话头部（设计稿 c-head）：无头像、标题主位 + 进行中脉冲点 + 右侧个体名轻标 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-6">
        <span className="truncate text-base font-medium text-text-primary">{headerTitle}</span>
        {pending ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-tertiary">
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            {t('header.live')}
          </span>
        ) : null}
        <span className="ml-auto min-w-0 shrink truncate text-xs text-text-quaternary">{agentName}</span>
      </div>
      <EscalationBanner />

      <div className="relative min-h-0 flex-1">
      {/* 滚动置顶（话-1）：以用户气泡原样式（同底色/圆角/字号/内距、贴右、与消息列同几何）
          固定当前轮指令一行——不用学新样式就知道「这是我说的话」。单行省略；
          点击跳回原消息（复用搜索命中的 flashTarget 滚动+点亮机制）。 */}
      {pinnedMsg ? (
        <div className="absolute inset-x-0 top-0 z-10 bg-canvas-glass py-1.5 pl-6 pr-[34px] backdrop-blur-sm">
          <div className="mx-auto flex max-w-2xl justify-end">
            <button
              type="button"
              onClick={() => {
                if (activeAgentId && activeConvId) {
                  openConversationAt(activeAgentId, activeConvId, pinnedMsg.id);
                }
              }}
              className="max-w-[80%] truncate rounded-sm rounded-br-[1px] bg-accent-soft px-3.5 py-2 text-left text-md leading-relaxed text-text-primary transition-opacity hover:opacity-90"
            >
              {pinnedMsg.text}
            </button>
          </div>
        </div>
      ) : null}
      {/* scrollbar-gutter:stable：10px 滚动条常驻预留，消息列的水平几何不随内容多少变；
          输入区/置顶条右侧补同样的 34px（px-6 的 24 + 滚动条 10）与它逐像素对齐 */}
      {/* 禁容器横滚：overflow-y-auto 会把 overflow-x 计算成 auto，宽子元素（代码块/表格）
          撑破时冒出整条消息区的横条。容器侧禁掉，溢出各自内部消化（pre / 表格自带 overflow-x-auto）。 */}
      <div ref={setScrollEl} className="absolute inset-0 overflow-y-auto overflow-x-hidden px-6 py-8 [scrollbar-gutter:stable]">

        {/* 内容层单独挂 ref：它的高度就是可滚内容高度，贴底靠 ResizeObserver 盯它 */}
        <div ref={setContentEl} className="mx-auto flex max-w-2xl flex-col gap-5 select-text">
          {items.topItems.length === 0 ? null : (
            items.topItems.map((it) => {
              if (it.kind === 'subagentGroup') {
                // 相邻终态完成行已折成组：≥2 条一行「N 个 subagent」点开逐行，单条退化单行
                return <SubagentGroup key={it.key} messages={it.data} />;
              }
              if (it.kind === 'proposalGroup') {
                // pending 成员沉到输入区停靠面板（逐条翻页取代了旧的流内 BashProposalCarousel），
                // 流里只留一行锚点；非 pending 成员（已派工/终态）各自留在流内作进行中指示/历史。
                // 混合态必须拆开——否则 pending 会在流内卡与面板两处重复可批（2026-07-19 话-1 review 修复）。
                // proposalGroup 只含 bash 提案（code 派工不折叠进组），无需排除 code
                const pending = it.data.filter((p) => p.status === 'pending');
                const settled = it.data.filter((p) => p.status !== 'pending');
                return (
                  <React.Fragment key={it.key}>
                    {pending.length ? <ApprovalAnchor proposals={pending} t={t} /> : null}
                    {settled.map((p) => (
                      // empty:hidden——已决无任务提案的回执不进流（TaskCard return null），
                      // 空壳 div 仍是 flex item 会白吃 gap-5 的 20px 间距
                      <div key={p.id} id={`task-card-${p.id}`} className="empty:hidden">
                        <TaskCard proposal={p} />
                      </div>
                    ))}
                  </React.Fragment>
                );
              }
              if (it.kind === 'proposal') {
                // pending 提案沉到输入区停靠面板，流里只留一行锚点；已派工/终态留在流内（进行中指示/历史）
                if (it.data.status === 'pending' && it.data.kind !== 'code') {
                  return <ApprovalAnchor key={it.key} proposals={[it.data]} t={t} />;
                }
                return (
                  <div key={it.key} id={`task-card-${it.data.id}`} className="empty:hidden">
                    <TaskCard proposal={it.data} />
                  </div>
                );
              }
              const m = it.data;
              if (m.kind === 'task-report' && m.refId) {
                // task-report 消息保留在上下文，只改渲染为与 sync 同款的 simple 完成行（改动点5）
                return (
                  <div key={it.key} id={`task-card-${m.refId}`}>
                    <AsyncTaskReportCard taskId={m.refId} summary={m.text} />
                  </div>
                );
              }
              if (m.kind === 'proposal' && m.proposalRecord) {
                // 审批决定存证不在流内渲染（2026-07-29 拍板：工具继续执行本身就是回执，
                // 流内回执卡总垫底碍事）。落盘审计保留，debug 面板仍可查「谁准的」。
                return null;
              }
              if (m.kind === 'memory-record') {
                return <MemoryRecordCard key={it.key} message={m} onView={setMemoryOverlay} />;
              }
              if (m.kind === 'context-compressed') {
                return <ContextCompressedCard key={it.key} message={m} />;
              }
              // S1：git-hint 与装卸类 outcome chip（plugin-install/update/uninstall、skill-create/patch/install）
              // 一律不渲染——前者无用户可感知契约，后者各有审批卡终态 TaskCard 承载状态、纯冗余自嗨。
              // skill-install 目前不走 SkillModuleChip 分支（漏到下方兜底以普通气泡渲染），必须在这里单独 return null。
              if (
                m.kind === 'git-hint' ||
                m.kind === 'plugin-install' ||
                m.kind === 'plugin-update' ||
                m.kind === 'plugin-uninstall' ||
                m.kind === 'skill-create' ||
                m.kind === 'skill-patch' ||
                m.kind === 'skill-install'
              ) {
                return null;
              }
              // S1：memory-record / skill-call / plugin-activate 是保留卡——正常情况下已被 detachAnchoredCards
              // 抽出插到所属回合 assistant 回复旁（见下方 anchoredByMsg 追加）；能走到这里的是：
              //   ① 老数据无 anchorTo（保持 createdAt 沉流尾现状）② 带 anchorTo 但匹配不到锚定消息的降级卡。
              if (m.kind === 'skill-call' || m.kind === 'plugin-activate') {
                return <SkillModuleChip key={it.key} message={m} />;
              }
              if (m.kind === 'subagent') {
                // 活物沉底、死物入流（2026-07-29/30 拍板）：终态完成行已全部由上方
                // subagentGroup 分支承载；运行中（含等审批）由底部 SubagentBar 呈现。
                return null;
              }
              if (m.kind === 'loop-checklist') {
                // 流内不占位——loop 状态由底部常驻条（LoopBar）呈现（2026-07-28 拍板）
                return null;
              }
              // S1 锚点归位：普通 assistant 回复（role==='assistant' && kind===undefined）渲染后，追加该
              // 回合锚定的保留卡（memory-record → MemoryRecordCard；skill-call/plugin-activate → SkillModuleChip）。
              // 卡紧随所属回合成片出现——视觉上「这轮回复后，Oru 用了 X / 已记下 XX」成立，流式/重载一致。
              const anchored =
                m.kind === undefined && m.role === 'assistant' ? items.anchoredByMsg.get(m.id) : undefined;
              if (anchored && anchored.length > 0) {
                return (
                  <React.Fragment key={it.key}>
                    <ChatMessage message={m} />
                    {anchored.map((card) => {
                      const key = `anchor_${card.id}`;
                      if (card.kind === 'memory-record') return <MemoryRecordCard key={key} message={card} onView={setMemoryOverlay} />;
                      return <SkillModuleChip key={key} message={card} />;
                    })}
                  </React.Fragment>
                );
              }
              return <ChatMessage key={it.key} message={m} />;
            })
          )}
          {error ? (
            <div className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-xs text-danger">
              {error}
            </div>
          ) : null}
        </div>
      </div>
        {!stuckToBottom ? <ScrollToLatestButton onClick={scrollToBottom} /> : null}
        {/* 记忆卡「查看」浮层：只盖消息区这一块阅读面。往上提到 section 会连输入框和待决策
            停靠面板一起盖住——回合还在跑，这期间到达的审批/追问就点不到了。 */}
        {memoryOverlay ? (
          <MemoryRecordOverlay record={memoryOverlay} onClose={() => setMemoryOverlay(null)} />
        ) : null}
      </div>

      <div className="shrink-0 bg-canvas py-3 pl-6 pr-[34px]">
        {/* 输入区（含上方 TodoPanel/停靠面板）比消息流 max-w-2xl 略宽——mx-auto 居中，
            对称向两侧各探出 ~24px，视觉上把输入栏从信息流里托出来。 */}
        <div className="mx-auto flex max-w-[45rem] flex-col gap-2">
          {/* 输入区上方一体多层（设计稿顺序）：计划清单 → loop 常驻条 → subagent 指示条 → 待决策停靠面板 → 输入框。 */}
          {activeConvId ? <TodoPanel conversationId={activeConvId} /> : null}
          {/* key=convId：切会话重挂，展开态/终态退场锚点不跨会话残留。 */}
          {activeConvId ? <LoopBar key={`loop-${activeConvId}`} conversationId={activeConvId} /> : null}
          {/* subagent 聚合指示条（2026-07-29 拍板）：运行中的对话期 subagent 沉底，终态完成卡入流。 */}
          {activeConvId ? <SubagentBar key={`sub-${activeConvId}`} conversationId={activeConvId} /> : null}
          {/* 待决策停靠面板：pending 审批卡 + 待答追问沉到输入框正上方（话-1）。
              key=convId：切会话重挂，翻页 idx 不跨会话残留（review 修复）。 */}
          {activeConvId ? (
            <PendingDecisionDock key={activeConvId} conversationId={activeConvId} />
          ) : null}
          {/* 斜杠命令面板：/help、无参 /model、命令执行反馈复用同一浮层。 */}
          {slashPanel ? <SlashCommandPanel panel={slashPanel} /> : null}
          <ChatInput
            conversationId={activeConvId}
            disabled={inputDisabled}
            busy={pending}
            visionEnabled={visionEnabled}
            visionDisabledHint={visionDisabledHint}
            onSend={onSend}
          />
          {!auth.ready ? (
            <p className="mt-1.5 px-1 text-xs text-text-tertiary">
              {t('backendNotReady', { hint: auth.hint })}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * 流内锚点：pending 审批卡沉入停靠面板后，原位留一行「待审批 · 请于下方处理 · 标题」。
 * 保留 id=task-card-{id}，反问横幅（EscalationBanner）滚动定位仍命中。
 */
function ApprovalAnchor({ proposals, t }: { proposals: ActionProposal[]; t: TFunction }) {
  const first = proposals[0];
  const label =
    proposals.length > 1
      ? t('dock.approvalCount', { count: proposals.length })
      : first.title;
  return (
    <div
      id={`task-card-${first.id}`}
      className="flex items-center gap-2 text-xs text-text-tertiary"
    >
      <PendingDot />
      <span className="font-medium text-warn-deep">{t('dock.approvalAnchor')}</span>
      <span className="min-w-0 truncate">· {label}</span>
    </div>
  );
}
