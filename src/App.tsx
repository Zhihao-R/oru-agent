import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsLeft } from 'lucide-react';
import { SidebarLeft } from '@/components/SidebarLeft';
import { HtmlAnnotPane } from '@/components/HtmlAnnotPane';
import { WorkspacePane } from '@/components/workspace/WorkspacePane';
import ChatArea from '@/components/chat/ChatArea';
import TopBar from '@/components/TopBar';
import { ResizeHandle } from '@/components/ResizeHandle';
import { SidebarTab } from '@/components/SidebarTab';
import SettingsPage from '@/pages/SettingsPage';

// 调试面板：lazy 加载，关闭开发者模式时不进 main bundle 请求
const DebugPanelPage = lazy(() => import('@/pages/DebugPanel'));
// Prompt 工作台：同样 lazy（开发者工具，非常驻）
const PromptBenchPage = lazy(() => import('@/pages/PromptBenchPage'));
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { bindTableEvents } from '@/stores/tableStore';
import { bindEditorAutoSync } from '@/stores/editorStore';
import { bindMemoryDocSync } from '@/stores/memoryStore';
import { ImportConflictDialog } from '@/components/table/ImportConflictDialog';
import { bindRendererQueries } from '@/lib/dirtyFiles';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useLayoutStore, MIN_CHAT_WIDTH } from '@/stores/layoutStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskStore } from '@/stores/taskStore';
import { useTaskboardStore } from '@/stores/taskboardStore';
import { useTaskboardCommentStore } from '@/stores/taskboardCommentStore';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { useSkillModuleStore } from '@/stores/skillModuleStore';
import { useArtifactStore, useActiveArtifactId, useDeckRecord } from '@/stores/artifactStore';
import { useHtmlAnnotStore } from '@/stores/htmlAnnotStore';
import { AnnotPane } from '@/components/deck/AnnotPane';
import { CollapsedAnnotStrip } from '@/components/annot/CollapsedAnnotStrip';
import { ExportProgressModal } from '@/components/deck/ExportProgressModal';
import { ToastHost } from '@/components/ToastHost';
import type { DeckTab } from '@/lib/deckTabChrome';
import { wsClient } from '@/lib/ws';
import { onReconnect } from '@/lib/wsReconnect';
import { initColorScheme, initTheme } from '@/lib/theme';
import { installScrollbarAutoHide } from '@/lib/scrollbarAutoHide';
import TaskboardPage from '@/components/taskboard/TaskboardPage';
import ScheduledTaskPage from '@/components/scheduledTask/ScheduledTaskPage';
import { routeChatEvent } from '@/hooks/useCommentChatRouter';
import { useAsideAltClick } from '@/aside/useAsideAltClick';
import { useScheduledTaskSync } from '@/hooks/useScheduledTaskSync';
import { useBgCommandSync } from '@/hooks/useBgCommandSync';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';
import { useSystemSignalSync } from '@/hooks/useSystemSignalSync';
import { useDesktopAttention } from '@/hooks/useDesktopAttention';
import { useTodoSync } from '@/hooks/useTodoSync';
import { AsideOverlay } from '@/aside/AsideOverlay';
import { setAsidePromoteNavigator } from '@/aside/overlayMachine';
import { setPageNavigator } from '@/lib/pageNavigator';
import { runAsidePromoteNavigation } from '@/aside/promoteNavigation';

const PEEK_HIDE_DELAY_MS = 220;

/**
 * 重灌服务端权威态（D4）——初始连接与断线重连共用同一套拉取。
 * 只 refresh「服务端权威」store（分身 / 对话列表 / 项目 / 设置 / 用户画像 / 插件技能 / 演示稿元数据）——
 * 它们的真相源在主进程，断线期漏掉的推送靠重连重拉对齐。
 *
 * **刻意不碰**编辑 / 前端态（D4 承重边界，设计文档 §2「不踩编辑态」）：md 编辑缓冲（editorStore）、
 * 对话草稿（chatStore.draftTextByConv）、打开的 tab（workspaceStore）、表格编辑（tableStore）——
 * 它们归渲染层所有、主进程不持久化，resync 一旦重灌就会丢用户未确认的改动。这些 store 不在下面任何一行里。
 */
async function resyncServerState(): Promise<void> {
  await useAgentStore.getState().refresh();
  const agentId = useAgentStore.getState().activeAgentId ?? 'twin';
  await useConversationStore.getState().refresh(agentId);
  await useProjectStore.getState().refresh(); // await 让后续按 activeProjectId 拉 deck 能拿到值
  void useSettingsStore.getState().refresh();
  void useSettingsStore.getState().refreshAuth();
  void useUserProfileStore.getState().refresh();
  const activeProjectId = useProjectStore.getState().activeProjectId;
  if (activeProjectId) {
    void useArtifactStore.getState().refreshArtifacts(activeProjectId).catch((e) => {
      console.warn('[oru.deck] 拉取演示稿列表失败', e);
    });
  }
  // Skill 模块 v1：拉一次 plugin / skill 列表（broadcast 不带初始态）
  void (async () => {
    try {
      const pRes = await wsClient.request({ type: 'plugin.list' });
      if (pRes.type === 'plugin.list.result') {
        useSkillModuleStore.getState().setPlugins(pRes.plugins);
      }
      const sRes = await wsClient.request({ type: 'skill.list' });
      if (sRes.type === 'skill.list.result') {
        useSkillModuleStore.getState().setSkills(sRes.skills);
      }
    } catch (e) {
      console.warn('[oru.skillModule] 拉取失败', e);
    }
  })();
}

/**
 * 睡眠唤醒对账（sleep-wake-chat-recovery）：对单个 conversationId 从主进程拉真相快照并应用。
 * 先经 byId 取该对话的 agentId（wakeRecover 广播只带 conversationId），再 query、apply。
 * 对账幂等：无在途内容时 query 返回空快照，apply 无副作用。
 */
async function recoverPendingConversation(conversationId: string): Promise<void> {
  const conv = useConversationStore.getState().byId[conversationId];
  if (!conv) return; // byId 还没有该对话（未注册/已删）——无从对账
  try {
    const res = await wsClient.request({
      type: 'chat.pendingTurnState.query',
      agentId: conv.agentId,
      conversationId,
    });
    if (res.type === 'chat.pendingTurnState.result') {
      useChatStore.getState().applyPendingTurnState(res);
    }
  } catch (e) {
    console.warn(`[sleep-wake] 对账失败 conv=${conversationId}:`, e);
  }
}

/**
 * Mount 兜底拉（sleep-wake-chat-recovery 的「拉」半）：窗口刚打开时主动查一次在途对话并对账。
 * 覆盖「窗口已关 → 睡眠 → 唤醒 → 重开窗口」这条 wake 推收不到的路径——wake 推是常态触发，
 * 这里是兜底补漏，两者都幂等、重复对账无害。必须在 resyncServerState 之后跑（byId 已填充）。
 */
async function runMountRecoveryCheck(): Promise<void> {
  try {
    const res = await wsClient.request({ type: 'chat.pendingTurnState.list' });
    if (res.type !== 'chat.pendingTurnState.list.result') return;
    for (const convId of res.conversationIds) void recoverPendingConversation(convId);
  } catch (e) {
    console.warn('[sleep-wake] mount 兜底对账失败:', e);
  }
}

type Page =
  | 'chat'
  | 'taskboard'
  | 'scheduledTask'
  | 'debug'
  | 'promptbench'
  | 'settings';

export default function App() {
  const { t } = useTranslation('app');
  // 右栏标签工作区（多标签，路线 A keep-mounted）。md/csv/image/html 已迁入；deck 阶段4接入（§7.3）。
  const workspaceTabCount = useWorkspaceStore((s) => s.openTabs.length);
  // 活跃标签：html 标签的批注栏是独立右列、由 App 渲染（非 keep-mounted，切走卸载、切回读桶重建）。
  const activeTab = useWorkspaceStore((s) => s.openTabs.find((tab) => tab.id === s.activeTabId) ?? null);
  const projects = useProjectStore((s) => s.projects);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const editorWidth = useLayoutStore((s) => s.editorWidth);
  const deckChatWidth = useLayoutStore((s) => s.deckChatWidth);
  const deckAnnotWidth = useLayoutStore((s) => s.deckAnnotWidth);
  const autoHideSidebar = useLayoutStore((s) => s.autoHideSidebar);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const setEditorWidth = useLayoutStore((s) => s.setEditorWidth);
  const setDeckChatWidth = useLayoutStore((s) => s.setDeckChatWidth);
  const setDeckAnnotWidth = useLayoutStore((s) => s.setDeckAnnotWidth);
  const persistLayout = useLayoutStore((s) => s.persistLayout);
  const toggleSidebarCollapsed = useLayoutStore((s) => s.toggleSidebarCollapsed);
  const annotPaneCollapsed = useLayoutStore((s) => s.annotPaneCollapsed);
  const toggleAnnotPaneCollapsed = useLayoutStore((s) => s.toggleAnnotPaneCollapsed);
  const [peeking, setPeeking] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // deck 沉浸/全屏态的左缘 peek（独立 state，跟 sidebar peek 不会同时触发——
  // 沉浸态 sidebar 整列已隐，互斥）
  const [deckPeeking, setDeckPeeking] = useState(false);
  const deckPeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [page, setPage] = useState<Page>('chat');

  // 随手评点（aside）：⌥点事件接管，全窗口一份（deck webview 内有自己的一套，见 hook 头注释）
  useAsideAltClick();

  // 定时任务全局同步（通知中心的「错过」判定常驻依赖它，不能只在定时任务页开着时才有数据）
  useScheduledTaskSync();
  // 后台命令状态同步（对话内后台命令行的活状态：运行中脉冲 + 时长）
  useBgCommandSync();
  // 系统信号全局同步（S14）：连上取初值 + 订阅 system.signals 增量
  useSystemSignalSync();
  // 找人阶梯第二级（S30）：应用不在前台时把「需要你处理」升级为系统通知 + 程序坞角标，点通知直达对话
  useDesktopAttention(setPage);
  // 计划清单（S32）：订阅 chat.todo，把 AI 更新的工作计划落进 todoStore 供展示
  useTodoSync();

  // 随手评点转正后的导航：切 chat 页 + active 到该对话 + 归档本地移除 + 光标入输入框
  useEffect(() => {
    setAsidePromoteNavigator((agentId, conversationId) =>
      runAsidePromoteNavigation(agentId, conversationId, () => setPage('chat')),
    );
    return () => setAsidePromoteNavigator(null);
  }, []);

  // 对话组件跳页的缝（定时任务确认卡「管理」等）：同上，页面态是本组件局部 state，经回调注入
  useEffect(() => {
    setPageNavigator((p) => setPage(p));
    return () => setPageNavigator(null);
  }, []);

  const showPeek = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setPeeking(true);
  };
  const schedulePeekHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setPeeking(false), PEEK_HIDE_DELAY_MS);
  };
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (deckPeekTimerRef.current) clearTimeout(deckPeekTimerRef.current);
    };
  }, []);
  const showDeckPeek = () => {
    if (deckPeekTimerRef.current) { clearTimeout(deckPeekTimerRef.current); deckPeekTimerRef.current = null; }
    setDeckPeeking(true);
  };
  const scheduleDeckPeekHide = () => {
    if (deckPeekTimerRef.current) clearTimeout(deckPeekTimerRef.current);
    deckPeekTimerRef.current = setTimeout(() => setDeckPeeking(false), PEEK_HIDE_DELAY_MS);
  };
  useEffect(() => {
    if (!autoHideSidebar) setPeeking(false);
  }, [autoHideSidebar]);

  // 滚动条自动隐藏：全站一处安装（滚动/走廊悬停 → data-scrollbar-visible，样式在 index.css）
  useEffect(() => installScrollbarAutoHide(), []);

  // 主题初始化（HTML 内联脚本已经把 DOM 状态设对了，这里同步 React state）
  useEffect(() => {
    initTheme();
    initColorScheme();
    // 语言无需在此初始化：lib/i18n 模块加载时已同步设好 i18next 语言 + <html lang>
  }, []);

  // 表格事件桥（fs.changed → 同步磁盘 / table.rowCount → 总行数）+ 出口闸门脏集应答
  // + 草稿孤儿文件启动清扫
  useEffect(() => {
    bindTableEvents();
    bindRendererQueries();
    bindEditorAutoSync(); // fs.changed(filePath) → 命中打开文档桶即时同步（AI 落盘可见，块①/§2.1）
    bindMemoryDocSync(); // memory.doc.changed → fetchDoc 刷新「最后修订于」（nit 12）
  }, []);

  // 全局 WS 事件分发
  useEffect(() => {
    const unsubscribe = wsClient.subscribe((event) => {
      switch (event.type) {
        case 'projects.state':
          useProjectStore.getState().syncFromServer(event.projects, event.activeId);
          break;
        case 'agents.state':
          useAgentStore.getState().syncFromServer(event.agents, event.activeId);
          break;
        case 'conv.state':
          useConversationStore.getState().syncForAgent(event.agentId, event.conversations);
          break;
        case 'auth.status':
          useSettingsStore.getState().syncAuth(event.status);
          break;
        case 'settings.state':
          useSettingsStore.getState().syncSettings(event.settings);
          break;
        case 'user.profile.state':
          useUserProfileStore.getState().syncFromServer(event.profile);
          break;
        case 'chat.started':
        case 'chat.delta':
        case 'chat.toolCall':
        case 'chat.toolResult':
        case 'chat.commandOutput':
        case 'chat.done':
        case 'chat.retrying':
        case 'chat.error':
        case 'chat.proposal':
        case 'chat.askUserChoice':
        case 'chat.circuitBreak':
        case 'chat.taskReport':
        case 'chat.proposalRecord':
        case 'chat.memoryRecord':
        case 'chat.gitHint':
        case 'chat.scheduledTrigger':
        case 'chat.inboundUserMessage':
        case 'chat.memoryUndone':
        case 'chat.contextCompressed':
        case 'chat.skillModule':
        case 'chat.subagentChip':
        case 'chat.loopCard':
        case 'chat.loopClarify':
          // PR-D3：所有 chat.* 事件经路由按 conv.kind 分流到主 chatStore 或 taskboardCommentStore
          routeChatEvent(event);
          break;
        case 'chat.steering.added':
          // Steering 仅主对话（评论场景不入队）——直接进主 chatStore，不走 conv.kind 分流
          useChatStore.getState().handleSteeringAdded(event);
          break;
        case 'chat.steering.consumed':
          useChatStore.getState().handleSteeringConsumed(event);
          break;
        case 'chat.steering.recovered':
          // 崩溃盘记交还：按类型分流草稿 / 待处理项（store 内随后回 recoverAck 确认送达）
          useChatStore.getState().handleSteeringRecovered(event);
          break;
        case 'chat.queue.handback':
          // 故障 / 远程刹车后队列交还：按类型分流草稿 / 待处理项
          useChatStore.getState().handleQueueHandback(event);
          break;
        case 'chat.wakeRecover':
          // 主进程 powerMonitor 唤醒主动推：对所列在途对话逐个对账（sleep-wake-chat-recovery）。
          // 独立 case、绕过 routeChatEvent（签名白名单不含此事件且带 conversationIds 数组）、
          // 直连 useChatStore——与 chat.steering.* / queue.handback 同款。
          for (const convId of event.conversationIds) void recoverPendingConversation(convId);
          break;
        case 'conv.history.result':
          useChatStore.getState().loadHistory(event.conversationId, event.messages);
          break;
        case 'scheduledRun.started': {
          // 定时任务开跑（S18）：任务清单行标「执行中」+ 承载对话内插一张「执行中」临时卡（不落历史；结果卡落盘时被移除替换）。
          useScheduledTaskStore.getState().markStarted(event.taskId);
          useChatStore.getState().insertSpecialMessage({
            id: `sched-running-${event.taskId}`,
            conversationId: event.conversationId,
            role: 'system',
            text: '',
            toolCalls: [],
            createdAt: Date.now(),
            done: true,
            kind: 'scheduled-run',
            scheduledRun: { taskId: event.taskId, title: event.title, status: 'ok', running: true },
          });
          break;
        }
        case 'scheduledRun.finished': {
          // 执行完毕：任务清单撤「执行中」；移除承载对话的临时卡，落结果卡（+ 成功且非空的产出消息）。
          // 落盘态已在磁盘，这里让正开着对话的前端实时见卡（未开的对话下次 loadHistory 自然带出）。
          useScheduledTaskStore.getState().markFinished(event.taskId);
          const cs = useChatStore.getState();
          cs.removeMessage(event.conversationId, `sched-running-${event.taskId}`);
          cs.insertSpecialMessage(event.card);
          if (event.output) cs.insertSpecialMessage(event.output);
          break;
        }
        case 'task.started':
          useTaskStore.getState().upsertTask(event.task);
          break;
        case 'task.progress':
          useTaskStore.getState().setProgress(event.progress);
          break;
        case 'task.done':
          useTaskStore.getState().markDone(event.taskId, event.summary);
          break;
        case 'task.failed':
          useTaskStore.getState().markFailed(event.taskId, event.errorMessage);
          break;
        case 'task.statusChanged':
          useTaskStore.getState().setStatus(event.taskId, event.status);
          break;
        case 'task.question':
          useTaskStore.getState().addQuestion(event.taskId, event.question);
          break;
        case 'task.questionAnswered':
          useTaskStore.getState().updateQuestion(event.taskId, event.question);
          break;
        case 'task.rollbackConflict':
          // 由 TaskCard 自行订阅处理；这里不集中
          break;
        case 'proposal.statusChanged':
          // v0.6：用户接受 / 拒绝 propose 后，后端推回 status；taskStore 更新卡片渲染
          useTaskStore
            .getState()
            .updateProposalStatus(
              event.proposalId,
              event.status,
              event.completedAt,
              event.failureMessage,
            );
          break;
        case 'taskboard.taskUpsert':
          useTaskboardStore.getState().applyUpsert(event.task);
          break;
        case 'taskboard.taskDelete':
          useTaskboardStore.getState().applyDelete(event.id);
          break;
        case 'taskboard.taskRestore':
          useTaskboardStore.getState().applyRestore(event.task);
          break;
        case 'taskboard.commentConvCreated':
          useTaskboardStore.getState().applyUpsert(event.task);
          useConversationStore.getState().registerConversation(event.conversation);
          break;
        case 'taskboard.note.added':
          useTaskboardCommentStore
            .getState()
            .applyNoteAdded(event.taskId, event.tempId, event.message);
          break;
        case 'taskboard.note.deleted':
          useTaskboardCommentStore
            .getState()
            .applyNoteDeleted(event.taskId, event.messageId);
          break;
        case 'taskboard.commentBusy':
          // 暂用 console，无 toast 系统；UI 上会以 reply error 形式给到 send caller
          console.warn(`[taskboard] commentBusy: ${event.taskId}`);
          break;
        // Skill 模块 v1
        case 'plugins.state':
          useSkillModuleStore.getState().setPlugins(event.plugins);
          break;
        case 'skills.state':
          useSkillModuleStore.getState().setSkills(event.skills);
          break;
        // Deck 模块 v1
        case 'artifact.state':
          // activeArtifactId 派生自活跃标签（§B），后端推来的不再写入——只更新 deck 列表。
          useArtifactStore.getState().syncArtifacts(event.projectId, event.decks);
          break;
        case 'artifact.annotationsChanged':
          useArtifactStore.getState().syncAnnotations(event.artifactId, event.annotations);
          break;
        case 'artifact.submissionChanged':
          useArtifactStore.getState().syncSubmission(event.artifactId, event.submission);
          break;
        case 'artifact.export.progress':
          useArtifactStore.getState().syncExportProgress(event.artifactId, event.done, event.total);
          break;
        case 'artifact.indexChanged':
          // hot reload 该 deck 的预览：发本 artifact 的 reload 信号，对应 PreviewPane 消费 → wv.reload()
          //（按 artifactId 路由，多 deck 标签 keep-mounted 下不会 reload 错的那个，§3.8）。
          // 对比期冻结由 store.notifyIndexChanged 内部按桶判 compareState 跳过（与 htmlAnnotStore 同口径）。
          useArtifactStore.getState().notifyIndexChanged(event.artifactId);
          break;
        // HTML 标注提交（项目B 第三期 Task15）——按 htmlPath 转 htmlAnnotStore（守卫迟到事件、对比态等收在 store）
        case 'html.annotationsChanged':
          useHtmlAnnotStore.getState().syncAnnotations(event.htmlPath, event.annotations);
          break;
        case 'html.submissionChanged':
          useHtmlAnnotStore.getState().syncSubmission(event.htmlPath, event.submission);
          break;
        case 'html.indexChanged':
          useHtmlAnnotStore.getState().notifyIndexChanged(event.htmlPath);
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, []);

  // 启动后主动拉一次服务端权威态（初始加载）
  useEffect(() => {
    void wsClient
      .ready()
      .then(resyncServerState)
      .then(runMountRecoveryCheck);
  }, []);

  // 断线重连重灌服务端权威态（D4）：重连（非首次 open）→ 重跑 resyncServerState。四个 sync hook
  // 同走 onReconnect（wsReconnect.ts），首次 open 由上面的 ready().then 处理、不在此重复；编辑/tab 态不碰。
  useEffect(() => onReconnect(() => void resyncServerState()), []);

  // Deck 模块 v1：deck 列表是 active project 的函数——启动恢复与切项目共用这一处声明式拉取。
  // main 进程不主动推历史 deck 状态，必须前端按 activeProjectId 变化主动拉，否则切项目后列表为空、4 列布局切不出来。
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  useEffect(() => {
    if (!activeProjectId) return;
    void useArtifactStore.getState().refreshArtifacts(activeProjectId).catch((e) => {
      console.warn('[oru.deck] 拉取演示稿列表失败', e);
    });
  }, [activeProjectId]);

  // Deck 是右栏标签工作区的平级一员（阶段4）：活跃标签是 deck 时切到 deck 多列布局
  //（chat 收窄，右侧 annot + preview），否则走单列查看器（WorkspacePane）。
  // activeArtifactId 派生自活跃标签（§B），不再读 artifactStore 槽位。
  const activeArtifactId = useActiveArtifactId();
  const activeDeckRecord = useDeckRecord(activeArtifactId);
  // 活跃 deck 的 chrome 态（按 artifactId 分桶，桶无值=work）——沉浸/全屏由它派生
  const deckChromeState = useArtifactStore((s) =>
    activeArtifactId ? s.chromeStateByArtifactId[activeArtifactId] ?? 'work' : 'work',
  );
  // 收起态细条上的标注计数：用户"待处理"的条数 = pending + 无 groupId 的独立 failed
  // （submitted 组内项不算待办——它们在修改中/完成组里，不是用户此刻要逐条处理的）
  const annotCount = useArtifactStore((s) => {
    const list = activeArtifactId ? s.annotationsByArtifact[activeArtifactId] : undefined;
    if (!list) return 0;
    return list.filter((a) => a.status === 'pending' || (a.status === 'failed' && !a.groupId)).length;
  });

  // 活跃 deck 的中间区子标签（预览 / 文稿，store 按 artifactId 分桶）——App 据它决定右侧批注栏是否渲染
  //（文稿态收起）。DeckCenter 经 DeckTabBody 读写同一桶，二者天然一致。
  const deckTab: DeckTab = useArtifactStore((s) =>
    activeArtifactId ? s.deckTabByArtifactId[activeArtifactId] ?? 'preview' : 'preview',
  );

  // deck mode = 活跃标签是 deck（且其 record 已就位）——右栏走 deck 形态（DeckCenter 占满 + 右侧 AnnotPane 列）。
  // deck 的 DeckCenter（含预览 webview）在 WorkspacePane 里 keep-mounted；App 这层只管「chat 收窄 + 批注列 + 沉浸态」。
  const deckMode = page === 'chat' && activeTab?.kind === 'deck' && activeDeckRecord != null;
  // 右栏标签工作区：chat 页有打开的标签就占右栏（md/csv/image/html/deck 全在 openTabs，平级 keep-mounted）。
  const showWorkspace = page === 'chat' && workspaceTabCount > 0;
  // 活跃标签是 html 时，在工作区右侧加一独立批注栏列（html 标签自带批注/对比，与 deck AnnotPane 同位同宽）。
  const activeHtmlTab = activeTab?.kind === 'html' ? activeTab : null;
  const activeHtmlRoot = activeHtmlTab
    ? projects.find((p) => p.id === activeHtmlTab.projectId)?.path ?? null
    : null;
  // 首屏已并入 chat 空态：侧栏跟随对话页显隐（deck 沉浸态除外）。着陆面在 chat 页内，天然覆盖。
  // html 预览走 deck 同款三段布局：对话区固定(deckChatWidth) + 预览 flex-1(蓄水池) + 批注栏固定。
  // 拖批注栏分隔线时预览就地伸缩、对话区不动——避免非 deck 那套「对话区当蓄水池、预览被平移」的错位。
  const htmlPreviewMode = showWorkspace && activeHtmlTab != null && activeHtmlRoot != null;
  // html 收起态细条上的标注计数——与 deck annotCount 同口径（pending + 无 groupId 的独立 failed）
  const htmlAnnotRef = activeHtmlTab?.ref ?? null;
  const htmlAnnotCount = useHtmlAnnotStore((s) => {
    const list = htmlAnnotRef ? s.byRef[htmlAnnotRef]?.annotations : undefined;
    if (!list) return 0;
    return list.filter((a) => a.status === 'pending' || (a.status === 'failed' && !a.groupId)).length;
  });
  const showSidebar = page === 'chat' && (!deckMode || deckChromeState === 'work');
  // deck 沉浸/全屏：chrome 全收起——TopBar / ChatArea / AnnotPane / PreviewToolbar 全部不渲染
  // PRD §3：F 单按 = 隐 chrome 留 macOS 窗口边框（hiddenInset 红绿灯仍由 OS 绘）
  const deckImmersive = deckMode && deckChromeState !== 'work';

  return (
    <div className="flex h-screen flex-col bg-canvas text-text-primary">
      {!deckImmersive ? (
        <TopBar
          currentPage={page}
          onNavigate={(p) => setPage(p)}
        />
      ) : null}
      <main className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* 常驻模式 + 未收起 + 在 chat 页：sidebar 占位 + 拖拽条 */}
        {showSidebar && !autoHideSidebar && !sidebarCollapsed ? (
          <>
            <div
              style={{ width: sidebarWidth }}
              className="relative min-h-0 shrink-0 overflow-hidden"
            >
              <SidebarLeft />
            </div>
            <ResizeHandle
              side="left"
              current={sidebarWidth}
              onChange={setSidebarWidth}
              onCommit={persistLayout}
            />
          </>
        ) : null}

        {/* 自动隐藏模式 + 在 chat 页：左缘 hover 触发区 + 浮层 sidebar */}
        {showSidebar && autoHideSidebar ? (
          <>
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 z-10 w-3"
              onMouseEnter={showPeek}
              // 对称补 onMouseLeave：只靠浮层的 onMouseLeave 收回有缺口——指针掠过左缘触发
              // peek 但从未进入浮层时 schedulePeekHide 永不被调，peeking 卡 true 不收起（§八）。
              // 进浮层会先 showPeek 取消这个定时器，不会误收。
              onMouseLeave={schedulePeekHide}
            />
            <div
              className={`absolute inset-y-0 left-0 z-30 transition-transform duration-200 ease-out ${
                peeking ? 'translate-x-0' : '-translate-x-full pointer-events-none'
              }`}
              style={{ width: sidebarWidth }}
              onMouseEnter={showPeek}
              onMouseLeave={schedulePeekHide}
            >
              <div className="h-full overflow-hidden border-r border-border shadow-focus">
                <SidebarLeft />
              </div>
            </div>
          </>
        ) : null}

        {/* 主内容区（对话 + 顶层页面）。deck mode 时收窄成 deckChatWidth 给右侧 deck 让位；
            沉浸/全屏态不渲染——让 WorkspacePane 里的 deck 预览独占（避免 flex-1 占位平分，旧 bug 2026-05-26）。
            注意：deck 的预览 webview 现在在 WorkspacePane（keep-mounted），不再由本区直接渲染。*/}
        {!deckImmersive ? (
          deckMode ? (
            <>
              <div
                style={{ width: deckChatWidth }}
                className="flex min-h-0 shrink-0 flex-col overflow-hidden"
              >
                <ChatArea />
              </div>
              {deckChromeState === 'work' ? (
                <ResizeHandle
                  side="left"
                  current={deckChatWidth}
                  onChange={setDeckChatWidth}
                  onCommit={persistLayout}
                />
              ) : null}
            </>
          ) : (
            // 对话区是主界面，永远 ≥ MIN_CHAT_WIDTH：min-width 立在它自己身上，视口装不下时
            // 让右侧栏（html 预览 + 批注栏 / 编辑器）溢出，而不是把对话区挤没（此前 min-w-0 允许缩到 0）。
            <div className="flex min-h-0 flex-1 flex-col" style={{ minWidth: MIN_CHAT_WIDTH }}>
              {page === 'chat' ? <ChatArea /> : null}
              {page === 'taskboard' ? <TaskboardPage /> : null}
              {page === 'scheduledTask' ? <ScheduledTaskPage onOpenChat={() => setPage('chat')} /> : null}
              {page === 'settings' ? <SettingsPage /> : null}
              {page === 'debug' ? (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">{t('loading')}</div>}>
                  <DebugPanelPage />
                </Suspense>
              ) : null}
              {page === 'promptbench' ? (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">{t('loading')}</div>}>
                  <PromptBenchPage />
                </Suspense>
              ) : null}
            </div>
          )
        ) : null}

        {/* 右栏标签工作区（md/csv/image/html/deck 全在此 keep-mounted，§3.2）。
            - deck mode：占 flex-1（DeckCenter 预览/文稿在 WorkspacePane 里），后接 AnnotPane 批注列；
              沉浸/全屏态隐去文件标签栏（hideTabBar），WorkspacePane 撑满（chat/sidebar 已不渲染）。
            - 非 deck mode：固定 editorWidth 列 + 左缘 handle；活跃标签是 html 时后接 HtmlAnnotPane 列。 */}
        {showWorkspace ? (
          <>
            {!deckMode ? (
              <ResizeHandle
                side="right"
                current={editorWidth}
                onChange={setEditorWidth}
                onCommit={persistLayout}
              />
            ) : null}
            <div
              style={deckMode ? undefined : { width: editorWidth }}
              className={
                deckMode
                  ? 'min-h-0 min-w-0 flex-1 overflow-hidden'
                  : 'min-h-0 shrink-0 overflow-hidden bg-elevated/40'
              }
            >
              <WorkspacePane hideTabBar={deckImmersive} />
            </div>
          </>
        ) : null}

        {/* Deck 批注栏：工作态 + 预览标签才渲染——文稿标签收起，把宽度让给文字。
            更新进行中时批注栏仍是 AnnotPane（它自己 submission 驱动显示提交卡），只在文稿标签收起。 */}
        {deckMode && deckChromeState === 'work' && deckTab === 'preview' ? (
          annotPaneCollapsed ? (
            <CollapsedAnnotStrip count={annotCount} onExpand={toggleAnnotPaneCollapsed} />
          ) : (
            <>
              <ResizeHandle
                side="right"
                current={deckAnnotWidth}
                onChange={setDeckAnnotWidth}
                onCommit={persistLayout}
              />
              <div
                style={{ width: deckAnnotWidth }}
                className="min-h-0 shrink-0 overflow-hidden"
              >
                <AnnotPane artifactId={activeArtifactId!} deckPath={activeDeckRecord!.path} />
              </div>
            </>
          )
        ) : null}

        {/* Deck 沉浸/全屏态：右缘 hover peek AnnotPane（参考 sidebar autoHide 同款模式）
            热区 3px → 滑出 AnnotPane → 鼠标离开 220ms 收回 */}
        {deckMode && deckImmersive ? (
          <>
            <div
              aria-hidden
              className="absolute inset-y-0 right-0 z-30 w-3"
              onMouseEnter={showDeckPeek}
              // 同 sidebar 热区：只靠浮层 onMouseLeave 收回有缺口——掠过右缘触发 peek 却
              // 没进浮层时 scheduleDeckPeekHide 永不被调，deckPeeking 卡 true 不收回。
              onMouseLeave={scheduleDeckPeekHide}
            />
            <div
              className={`absolute inset-y-0 right-0 z-40 transition-transform duration-200 ease-out ${
                deckPeeking ? 'translate-x-0' : 'translate-x-full pointer-events-none'
              }`}
              style={{ width: deckAnnotWidth }}
              onMouseEnter={showDeckPeek}
              onMouseLeave={scheduleDeckPeekHide}
            >
              <div className="h-full overflow-hidden bg-canvas shadow-pop">
                <AnnotPane artifactId={activeArtifactId!} deckPath={activeDeckRecord!.path} />
              </div>
            </div>
          </>
        ) : null}

        {/* 活跃标签是 html → 独立批注栏列（与 deck AnnotPane 同位同宽，复用共用 AnnotPanel）。
            非 keep-mounted：切走卸载、切回读本桶重建（批注/对比态在 store 桶里，无 DOM 现场可丢）。 */}
        {showWorkspace && activeHtmlTab && activeHtmlRoot ? (
          annotPaneCollapsed ? (
            <CollapsedAnnotStrip count={htmlAnnotCount} onExpand={toggleAnnotPaneCollapsed} />
          ) : (
            <>
              <ResizeHandle
                side="right"
                current={deckAnnotWidth}
                onChange={setDeckAnnotWidth}
                onCommit={persistLayout}
              />
              <div style={{ width: deckAnnotWidth }} className="min-h-0 shrink-0 overflow-hidden">
                <HtmlAnnotPane path={activeHtmlTab.ref} absPath={`${activeHtmlRoot}/${activeHtmlTab.ref}`} />
              </div>
            </>
          )
        ) : null}

        {/* 折叠 / 自动隐藏时露出的"小耳朵"：仅 chat 页 */}
        {showSidebar && autoHideSidebar ? (
          <SidebarTab mode="autoHide" onMouseEnter={showPeek} />
        ) : showSidebar && sidebarCollapsed ? (
          <SidebarTab mode="manual" onClick={toggleSidebarCollapsed} />
        ) : null}
      </main>


      {/* 导入冲突（覆盖/另存/取消）与导入通知：App 级单例，订阅 table.* 广播 */}
      <ImportConflictDialog />

      {/* 随手评点浮层：单例，⌥点经 dispatch 打到它（壳常驻、面板按状态机出没） */}
      <AsideOverlay />

      {/* 导出进度弹窗（PDF/PPT）：App 级单例、store 驱动——切页面不丢进度，蒙尘+可取消 */}
      <ExportProgressModal />

      {/* 写操作失败等瞬时提示：App 级单例、右下角堆叠（M8） */}
      <ToastHost />
    </div>
  );
}
