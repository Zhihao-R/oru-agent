import { create } from 'zustand';
import type { ArtifactRecord, Annotation, HistoryVersion, SubagentTask } from '@shared/types';
import type { ArtifactSubmitPayloadItem, ArtifactSubmissionView, ExportFormat, ExportScale } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { useWorkspaceStore, registerTabCloser, registerActiveTabListener } from '@/stores/workspaceStore';
import i18n from '@/lib/i18n';

/**
 * Deck 模块前端状态
 *
 * 数据全部按 projectId / artifactId 分桶——deck 是右栏标签工作区的平级一员（多标签 keep-mounted，
 * tech design §3.7 阶段4），同时挂多个 deck 互不串状态。WS 广播
 * (deck.state / deck.indexChanged / deck.annotationsChanged) 触发 sync 方法。
 *
 * **activeArtifactId 是派生量，不是本 store 的真源**（真源方向反转，§3.7 §B）：
 *  - 真源 = workspaceStore 的活跃标签：`activeTab.kind==='deck' ? activeTab.ref : null`。
 *    本 store 不再存 activeArtifactId 槽位；消费方读 `useActiveArtifactId()`（订阅 workspaceStore）。
 *  - 方向：**前端活跃标签 → 推后端**。activateTab 命中 deck 标签时调 `artifact.activate(ref)`
 *    同步后端 activeDeckId（deck 历史工具 getActiveDeckId 依赖它）。`syncArtifacts` 不再写 active。
 *  - 启动恢复：**前端为准**——后端上次会话留的 activeDeckId 不自动恢复成 deck 标签
 *    （符合 PRD「不跨重启保留」）；后端 activeDeckId 仅在 deck 标签激活时经 artifact.activate 同步。
 *
 * 注释模型：每页一条 annotation，由 (artifactId, pageIndex) 唯一确定。
 */

export type ArtifactChromeState = 'work' | 'immersive' | 'fullscreen';

/** Deck 设计稿尺寸 + slide 总数 + profile；preload 'oru:deckMeta' 推过来 */
export type ArtifactMeta = { width: number; height: number; slideCount: number; profile: 'deck' | 'plain' };

type ArtifactStoreState = {
  artifactsByProject: Record<string, ArtifactRecord[]>;

  annotationsByArtifact: Record<string, Annotation[]>;
  versionsByArtifact: Record<string, HistoryVersion[]>;
  currentVersionByArtifact: Record<string, string>;
  /** Deck 元信息（尺寸 + 页数）——PreviewPane 收到 preload meta 后写入，AnnotPane 读它列 N 张卡 */
  deckMetaByArtifact: Record<string, ArtifactMeta>;

  /** 每 artifact 至多一个活跃提交组（后端 submissionChanged 推来；null=无）。afterVersionId 有=「完成」、无=「修改中」 */
  submissionByArtifact: Record<string, ArtifactSubmissionView | null>;

  /**
   * 对比模式（纯前端态，按 artifactId 分桶）：进对比时存两份临时快照相对名 + 当前看哪份。
   * 桶里有值时 PreviewPane 把该 deck 的 webview 指向快照、App.tsx 冻结该 deck 的 indexChanged hot reload。
   */
  compareStateByArtifactId: Record<string, { beforeFile: string; afterFile: string; showing: 'before' | 'after' }>;

  /**
   * 图片版导出（pdf/pptx）进行中态：done/total 由后端 export.progress 广播推来；null=无进行中导出。
   * 在 store（非组件局部）→ 切页面/重挂组件不丢；驱动全局导出弹窗。format 用于弹窗文案。
   */
  exportProgress: { artifactId: string; format: 'pdf' | 'pptx'; done: number; total: number } | null;

  /** preview 当前页（0 起，按 artifactId 分桶）；桶无值=第 0 页，故无需开 deck 时显式置 0。 */
  currentPageIndexByArtifactId: Record<string, number>;

  /** chrome 状态机（按 artifactId 分桶）：工作态 / 沉浸态 / OS 全屏；桶无值=work。 */
  chromeStateByArtifactId: Record<string, ArtifactChromeState>;

  /**
   * 跳转信号（按 artifactId 分桶）：AnnotPane 点卡片请求该 deck 预览跳到某标注位置；
   * PreviewPane 订阅本桶消费。nonce 保证重复点同一目标也能再次触发。
   */
  jumpSignalByArtifactId: Record<string, { pageIndex: number | null; scrollY: number; nonce: number }>;

  /** 框选信号（按 artifactId 分桶）：AnnotPane 点「框选标注」请求该 deck 进入框选模式；
   *  PreviewPane 消费本桶 → wv.send('frame:enter')。自增计数，PreviewPane 用 ref 记上次值避免重复触发。 */
  frameSelectSignalByArtifactId: Record<string, number>;

  /** reload 信号（按 artifactId 分桶）：indexChanged 落地时自增；对应 PreviewPane 消费 → wv.reload()。
   *  按 id 路由替代旧 document.querySelector('webview')（多 deck 标签下会命中错的，§3.8）。 */
  reloadSignalByArtifactId: Record<string, number>;

  /** deck 中间区当前子标签（预览 / 文稿，按 artifactId 分桶）：每个 deck 标签各记一份，桶无值=preview。
   *  DeckCenter 读写自己的；App 读活跃 deck 的，据它决定批注栏是否渲染（文稿态收起）。 */
  deckTabByArtifactId: Record<string, 'preview' | 'narrative'>;

  /** 「从文稿生成」派发成功后的乐观「排队中」标记（按 artifactId 分桶，值=派发时刻）——任务起跑后由
   *  taskStore 的 deckArtifactId 接管显示「生成中」；startedAt ≥ 标记时刻的任务记录遮蔽本标记
   *  （再次派发时旧任务 startedAt 更早，不会误遮蔽新一轮）。 */
  generateQueuedByArtifact: Record<string, number>;

  // ─── WS 广播 sync ──────────────────────────────────────
  /** activeArtifactId 不再写进本 store（派生自活跃标签，见头注释）——后端的 activeDeckId 此处忽略。 */
  syncArtifacts(projectId: string, decks: ArtifactRecord[]): void;
  /** artifact.indexChanged：非对比态时给该 deck 发 reload 信号（对比态预览锁在快照上，reload 会丢对比视图）。 */
  notifyIndexChanged(artifactId: string): void;
  syncAnnotations(artifactId: string, annotations: Annotation[]): void;
  syncVersions(artifactId: string, versions: HistoryVersion[], currentVersion: string): void;
  /** 提交组状态转移广播（提交/收尾/停止/保存/取消时由后端发）；null=无活跃组 */
  syncSubmission(artifactId: string, submission: ArtifactSubmissionView | null): void;
  /** 导出逐页进度广播（仅 pdf/pptx，仅更新 done/total）；起止置位/清空由 exportDeck 管，不在此 */
  syncExportProgress(artifactId: string, done: number, total: number): void;
  /** 取消进行中的图片版导出（按 artifactId）：通知后端中断离屏渲染 */
  cancelExport(artifactId: string): Promise<void>;
  /** 切改前/改后（某 deck 对比态内本地切换，不发 RPC） */
  setCompareShowing(artifactId: string, showing: 'before' | 'after'): void;

  // ─── 本地交互 ──────────────────────────────────────────
  /** 同步后端 activeDeckId（前端活跃标签 → 推后端，§B）；deck 标签激活时由 workspaceStore.activateTab 调。 */
  activateArtifact(artifactId: string | null): Promise<void>;
  /**
   * 收编一个文件树里的 deck 文件夹（「加入演示稿」，deck 找回 §3.3）。
   * relPath 相对项目根（POSIX）；成功带新/既有 artifactId，失败带后端给的可读原因
   * （没有 index.html / 翻不出页）。不在此自动 activate——caller 拿 id 后自行 activateArtifact。
   */
  adoptDeck(
    projectId: string,
    relPath: string,
  ): Promise<{ ok: true; artifactId: string } | { ok: false; message: string }>;
  setChromeState(artifactId: string, s: ArtifactChromeState): void;
  setCurrentPage(artifactId: string, i: number): void;
  /** 切 deck 中间区子标签（预览 / 文稿）——按 artifactId 分桶。 */
  setDeckTab(artifactId: string, tab: 'preview' | 'narrative'): void;
  setArtifactMeta(artifactId: string, meta: ArtifactMeta): void;
  /** AnnotPane 点卡片 → 发该 deck 的跳转信号；PreviewPane 消费跳到标注位置 */
  requestJump(artifactId: string, locator: Annotation['locator']): void;
  /** AnnotPane 点「框选标注」→ 发该 deck 的框选信号；PreviewPane 消费进入框选模式 */
  requestFrameSelect(artifactId: string): void;
  /** 关 deck 标签：清掉该 artifact 的所有分桶槽（页码/chrome/对比/跳转/框选信号）。registerTabCloser 调。 */
  closeArtifact(artifactId: string): void;

  // ─── WS request ────────────────────────────────────────
  refreshArtifacts(projectId: string): Promise<void>;
  refreshVersions(artifactId: string): Promise<void>;
  /** 渲染某历史版本的联系表网格图（历史窗口右侧预览，不改磁盘）；返回 base64 图（可能分批） */
  historyPreview(artifactId: string, versionId: string): Promise<string[]>;
  addAnnotation(
    artifactId: string,
    args: Pick<Annotation, 'comment' | 'htmlSnippet' | 'text' | 'locator'>,
    cropPngBase64?: string,
  ): Promise<void>;
  updateAnnotation(artifactId: string, annotationId: string, patch: Partial<Pick<Annotation, 'comment'>>): Promise<void>;
  removeAnnotation(artifactId: string, annotationId: string): Promise<void>;
  /** 提交一批标注：防护性 commit + 转 submitted + 建组，返回注入对话 composer 的 payload（设计 §6.2）。失败（已有未完成组）返回 null */
  submitAnnotations(
    artifactId: string,
    annotationIds: string[],
    conversationId: string,
  ): Promise<{ groupId: string; payload: ArtifactSubmitPayloadItem[] } | null>;
  /**
   * 据当前文稿更新这份演示设计：建提交组 + 派主对话据文稿全文手术式改 index.html。
   * includeAnnotations=true 时把该 deck 所有 pending 标注一并并入组。失败（已有未完成组）返回 false。
   */
  updateFromNarrative(artifactId: string, includeAnnotations: boolean): Promise<boolean>;
  /**
   * 据文稿事后生成这份演示设计（空壳 → 真 slides）：派 subagent 按 .narrative.md + deckSkillId 生成 HTML。
   * 空状态 CTA 与标签栏「从文稿生成演示设计」共用此入口。失败必带可读原因（无活跃对话 / 后端 message /
   * 同 deck 已有任务在跑或在排）——静默 false 曾是「点了没反应」的病根（走查二批该修 4）。
   */
  generateDeck(artifactId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  applyInlineEdit(
    artifactId: string,
    args: { markerId?: string | null; oldText: string; newText: string; pageIndex: number },
  ): Promise<{ ok: boolean; degraded?: boolean }>;
  checkoutHistory(artifactId: string, versionId: string, force?: boolean): Promise<{ ok: boolean; missingImages?: string[] }>;
  undo(artifactId: string): Promise<void>;
  redo(artifactId: string): Promise<void>;
  reorderSlides(artifactId: string, newOrder: number[]): Promise<void>;
  /** 导出 deck 成指定格式；scale 为 pdf/pptx 清晰度档位（缺省 1）。落 deck 文件夹旁 + 主进程在访达高亮。 */
  exportDeck(
    artifactId: string,
    format: ExportFormat,
    scale?: ExportScale,
  ): Promise<{ ok: boolean; path?: string; message?: string; cancelled?: boolean }>;
  /** 停止修改（撤回，设计 §6.5）：标注回 pending、清 groupId、删 Submission */
  stopSubmission(artifactId: string, groupId: string): Promise<void>;
  /** 手动「标记完成」：走 AI 收尾同一逻辑（修改中→完成） */
  manualFinalize(artifactId: string, groupId: string): Promise<void>;
  /** 保存提交组（接受改后态）；成功后若 compareState 属此 artifact 则清掉 */
  saveSubmission(artifactId: string, groupId: string): Promise<void>;
  /** 取消提交组（回退改前态）；成功后若 compareState 属此 artifact 则清掉 */
  cancelSubmission(artifactId: string, groupId: string): Promise<void>;
  /** 「退回改前」（崩溃中断组，PRD §六-6）：后端 checkout beforeVersion + 标注降级 + 清记录 */
  discardInterrupted(artifactId: string, groupId: string): Promise<void>;
  /** 进对比：拿 before/after 临时快照名 → set compareState（默认看改前） */
  enterCompare(artifactId: string, groupId: string): Promise<void>;
  /** 退出对比：删临时快照 + 清 compareState */
  exitCompare(artifactId: string): Promise<void>;
};

// 跳转信号自增计数器：保证重复点同一目标 nonce 也变化
let jumpNonce = 0;

export const useArtifactStore = create<ArtifactStoreState>((set, get) => ({
  artifactsByProject: {},
  annotationsByArtifact: {},
  versionsByArtifact: {},
  currentVersionByArtifact: {},
  deckMetaByArtifact: {},
  submissionByArtifact: {},
  exportProgress: null,
  compareStateByArtifactId: {},
  currentPageIndexByArtifactId: {},
  chromeStateByArtifactId: {},
  jumpSignalByArtifactId: {},
  frameSelectSignalByArtifactId: {},
  reloadSignalByArtifactId: {},
  deckTabByArtifactId: {},
  generateQueuedByArtifact: {},

  syncArtifacts(projectId, decks) {
    // 不再写 activeArtifactId（派生自活跃标签，§B）——后端推来的 activeDeckId 在此忽略。
    set((s) => ({ artifactsByProject: { ...s.artifactsByProject, [projectId]: decks } }));
  },
  notifyIndexChanged(artifactId) {
    set((s) => {
      // 对比态预览锁在 before/after 快照上，AI 后续自发改动触发的 reload 不能让基准漂移——跳过（退出对比后恢复）。
      if (s.compareStateByArtifactId[artifactId]) return {};
      return {
        reloadSignalByArtifactId: {
          ...s.reloadSignalByArtifactId,
          [artifactId]: (s.reloadSignalByArtifactId[artifactId] ?? 0) + 1,
        },
      };
    });
  },

  syncAnnotations(artifactId, annotations) {
    set((s) => ({
      annotationsByArtifact: { ...s.annotationsByArtifact, [artifactId]: annotations },
    }));
  },

  syncVersions(artifactId, versions, currentVersion) {
    set((s) => ({
      versionsByArtifact: { ...s.versionsByArtifact, [artifactId]: versions },
      currentVersionByArtifact: { ...s.currentVersionByArtifact, [artifactId]: currentVersion },
    }));
  },

  syncSubmission(artifactId, submission) {
    set((s) => {
      // 对比态生命周期绑在提交组上：组解散（submission=null）时，对比基准已失效，
      // 一并退出该 deck 的对比态。以广播为权威（而非各动作乐观自清）——save/cancel/stop 都经此
      // 路径收口，避免乐观清理与广播到达的竞态、以及遗漏某条动作的不对称。
      const dropCompare = submission === null && s.compareStateByArtifactId[artifactId] != null;
      const next: Partial<ArtifactStoreState> = {
        submissionByArtifact: { ...s.submissionByArtifact, [artifactId]: submission },
      };
      if (dropCompare) {
        const { [artifactId]: _dropped, ...rest } = s.compareStateByArtifactId;
        void _dropped;
        next.compareStateByArtifactId = rest;
      }
      return next;
    });
  },

  setCompareShowing(artifactId, showing) {
    set((s) => {
      const cur = s.compareStateByArtifactId[artifactId];
      return cur
        ? { compareStateByArtifactId: { ...s.compareStateByArtifactId, [artifactId]: { ...cur, showing } } }
        : {};
    });
  },

  syncExportProgress(artifactId, done, total) {
    // 只更新进度数字，不创建/销毁导出态——起止由 exportDeck 管。迟到广播（导出已结束、
    // 槽已清空或换了 artifact）一律忽略，避免重新点亮已关闭的弹窗。
    set((s) =>
      s.exportProgress?.artifactId === artifactId
        ? { exportProgress: { ...s.exportProgress, done, total } }
        : {},
    );
  },

  async activateArtifact(artifactId) {
    // 纯同步后端 activeDeckId（前端活跃标签 → 推后端，§B）；前端「哪个 deck 活跃」由活跃标签决定，
    // 不在此 set 任何前端态。deck 标签激活（workspaceStore.activateTab）与关闭 deck（切到非 deck 标签 /
    // 关掉最后一个 deck 标签 → null）都经此把后端对齐，deck 历史工具 getActiveDeckId 才指向用户在看的那份。
    await wsClient.request({ type: 'artifact.activate', artifactId });
  },

  async adoptDeck(projectId, relPath) {
    const res = await wsClient.request({ type: 'artifact.adopt', projectId, path: relPath });
    if (res.type === 'artifact.adopt.result') {
      return res.ok ? { ok: true, artifactId: res.artifactId } : { ok: false, message: res.message };
    }
    return { ok: false, message: i18n.t('deck:adoptFailed') };
  },

  setChromeState(artifactId, st) {
    set((s) => ({ chromeStateByArtifactId: { ...s.chromeStateByArtifactId, [artifactId]: st } }));
  },
  setCurrentPage(artifactId, i) {
    // 单一真源：clamp 到该 deck 的 [0, slideCount-1]，所有调用方（大纲条/翻页键/滚轮/跳转/重排）
    // 只管传目标页号，边界一处收口。PreviewPane 读 currentPageIndexByArtifactId[id] 驱动 webview。
    set((s) => {
      const meta = s.deckMetaByArtifact[artifactId];
      const max = meta && meta.slideCount > 0 ? meta.slideCount - 1 : 0;
      const clamped = Math.min(Math.max(0, i), max);
      return { currentPageIndexByArtifactId: { ...s.currentPageIndexByArtifactId, [artifactId]: clamped } };
    });
  },
  setArtifactMeta(artifactId, meta) {
    set((s) => ({ deckMetaByArtifact: { ...s.deckMetaByArtifact, [artifactId]: meta } }));
  },
  setDeckTab(artifactId, tab) {
    set((s) => ({ deckTabByArtifactId: { ...s.deckTabByArtifactId, [artifactId]: tab } }));
  },
  requestJump(artifactId, locator) {
    jumpNonce += 1;
    set((s) => ({
      jumpSignalByArtifactId: {
        ...s.jumpSignalByArtifactId,
        [artifactId]: { pageIndex: locator.pageIndex ?? null, scrollY: locator.scrollY, nonce: jumpNonce },
      },
    }));
  },
  requestFrameSelect(artifactId) {
    set((s) => ({
      frameSelectSignalByArtifactId: {
        ...s.frameSelectSignalByArtifactId,
        [artifactId]: (s.frameSelectSignalByArtifactId[artifactId] ?? 0) + 1,
      },
    }));
  },
  closeArtifact(artifactId) {
    // 关 deck 标签：清掉该 artifact 的纯前端交互槽（页码/chrome/对比/跳转/框选信号）。
    // annotations/versions/submission/deckMeta 是后端广播的缓存，不在此清——重开同 deck 还会复用
    // （重开即新建标签，PreviewPane 重挂 webview 会再推 deckMeta；缓存留着无害且省一次拉取）。
    set((s) => {
      const drop = <T,>(rec: Record<string, T>): Record<string, T> => {
        const { [artifactId]: _d, ...rest } = rec;
        void _d;
        return rest;
      };
      return {
        currentPageIndexByArtifactId: drop(s.currentPageIndexByArtifactId),
        chromeStateByArtifactId: drop(s.chromeStateByArtifactId),
        compareStateByArtifactId: drop(s.compareStateByArtifactId),
        jumpSignalByArtifactId: drop(s.jumpSignalByArtifactId),
        frameSelectSignalByArtifactId: drop(s.frameSelectSignalByArtifactId),
        reloadSignalByArtifactId: drop(s.reloadSignalByArtifactId),
        deckTabByArtifactId: drop(s.deckTabByArtifactId),
      };
    });
  },

  async refreshArtifacts(projectId) {
    const res = await wsClient.request({ type: 'artifact.list', projectId });
    if (res.type === 'artifact.list.result') {
      get().syncArtifacts(projectId, res.decks);
    }
  },
  async refreshVersions(artifactId) {
    const res = await wsClient.request({ type: 'artifact.listHistory', artifactId });
    if (res.type === 'artifact.listHistory.result') {
      get().syncVersions(artifactId, res.versions, res.currentVersion);
    }
  },
  async historyPreview(artifactId, versionId) {
    const res = await wsClient.request({ type: 'artifact.historyPreview', artifactId, versionId });
    return res.type === 'artifact.historyPreview.result' ? res.sheetImages : [];
  },
  async addAnnotation(artifactId, args, cropPngBase64) {
    await wsClient.request({ type: 'artifact.addAnnotation', artifactId, annotation: args, cropPngBase64 });
  },
  async updateAnnotation(artifactId, annotationId, patch) {
    await wsClient.request({ type: 'artifact.updateAnnotation', artifactId, annotationId, patch });
  },
  async removeAnnotation(artifactId, annotationId) {
    await wsClient.request({ type: 'artifact.removeAnnotation', artifactId, annotationId });
  },
  async submitAnnotations(artifactId, annotationIds, conversationId) {
    const res = await wsClient.request({
      type: 'artifact.submitAnnotations',
      artifactId,
      annotationIds,
      conversationId,
    });
    if (res.type === 'artifact.submitAnnotations.result' && res.ok && res.groupId && res.payload) {
      return { groupId: res.groupId, payload: res.payload };
    }
    return null;
  },
  async updateFromNarrative(artifactId, includeAnnotations) {
    // 派发挂在当前活跃对话上（与 submitAnnotations 同口径：activeAgent → activeByAgent）。
    const agentId = useAgentStore.getState().activeAgentId;
    const conversationId = agentId ? useConversationStore.getState().activeByAgent[agentId] : undefined;
    if (!conversationId) return false;
    // 成功 → ack；并发约束拒绝 → submitAnnotations.result(ok:false)（复用现有拒绝形态，不另设结果类型）
    const res = await wsClient.request({
      type: 'artifact.updateFromNarrative',
      artifactId,
      conversationId,
      includeAnnotations,
    });
    if (res.type === 'artifact.submitAnnotations.result' && res.ok === false) return false;
    return true;
  },
  async generateDeck(artifactId) {
    // 与 updateFromNarrative 同口径：派发挂在当前活跃对话上（activeAgent → activeByAgent）。
    const agentId = useAgentStore.getState().activeAgentId;
    const conversationId = agentId ? useConversationStore.getState().activeByAgent[agentId] : undefined;
    // deck 预览是独立标签，用户完全可能无选中对话——此时请求根本没发出，必须显式报原因
    if (!conversationId) return { ok: false, reason: i18n.t('deck:generate.noConversation') };
    try {
      await wsClient.request({ type: 'artifact.generateDeck', artifactId, conversationId });
      // 派发成功 → 乐观置「排队中」；任务起跑后由 taskStore（deckArtifactId）接管为「生成中」，
      // 任务到终态后两处都不再命中、状态自动消失。
      set((s) => ({
        generateQueuedByArtifact: { ...s.generateQueuedByArtifact, [artifactId]: Date.now() },
      }));
      return { ok: true };
    } catch (e) {
      // 后端 error（deck 不存在 / 同 deck 在跑或在排 / 派发异常）→ 原因随返回值带出，UI 弹 toast
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
  async applyInlineEdit(artifactId, args) {
    // 失败分两类：定位降级（DECK_INLINE_EDIT_DEGRADED，该回滚 DOM + 提示"用框选交给 AI 改"）
    // vs io/其它（保存失败，不该提示框选）。degraded 透给 PreviewPane 决定是否通知 preload。
    try {
      await wsClient.request({
        type: 'artifact.applyInlineEdit',
        artifactId,
        markerId: args.markerId ?? null,
        oldText: args.oldText,
        newText: args.newText,
        pageIndex: args.pageIndex,
      });
      return { ok: true };
    } catch (e) {
      const code = (e as Error & { code?: string }).code;
      return { ok: false, degraded: code === 'DECK_INLINE_EDIT_DEGRADED' };
    }
  },
  async checkoutHistory(artifactId, versionId, force) {
    const res = await wsClient.request({ type: 'artifact.checkoutHistory', artifactId, versionId, force });
    if (res.type === 'artifact.checkoutHistory.result') {
      return { ok: res.ok, missingImages: res.missingImages };
    }
    return { ok: false };
  },
  async undo(artifactId) {
    await wsClient.request({ type: 'artifact.undo', artifactId });
  },
  async redo(artifactId) {
    await wsClient.request({ type: 'artifact.redo', artifactId });
  },
  async reorderSlides(artifactId, newOrder) {
    await wsClient.request({ type: 'artifact.reorderSlides', artifactId, newOrder });
  },
  async exportDeck(artifactId, format, scale) {
    // 图片版导出起点先置 0/0（全局弹窗立刻出现），中途由 export.progress 广播更新，无论成败/取消 finally 清空。
    const isImage = format === 'pdf' || format === 'pptx';
    if (isImage) set({ exportProgress: { artifactId, format, done: 0, total: 0 } });
    try {
      // 图片版逐页离屏渲染——大 deck × 超清(3x) 可远超默认 30s 超时；给足 10 分钟，
      // 否则请求超时报"导出失败"但后端其实已把文件写出（用户困惑）。
      const timeoutMs = isImage ? 600_000 : undefined;
      const res = await wsClient.request({ type: 'artifact.export', artifactId, format, scale }, timeoutMs);
      if (res.type === 'artifact.export.result') {
        return { ok: res.ok, path: res.path, message: res.message, cancelled: res.cancelled };
      }
      return { ok: false, message: i18n.t('deck:controls.export.failed') };
    } finally {
      if (isImage) set({ exportProgress: null });
    }
  },
  async cancelExport(artifactId) {
    // 仅通知后端中断；弹窗的关闭交给进行中的 exportDeck 在 finally 清 exportProgress（单一收口）。
    await wsClient.request({ type: 'artifact.exportCancel', artifactId });
  },
  async stopSubmission(artifactId, groupId) {
    await wsClient.request({ type: 'artifact.stopSubmission', artifactId, groupId });
  },
  async manualFinalize(artifactId, groupId) {
    await wsClient.request({ type: 'artifact.manualFinalize', artifactId, groupId });
  },
  async saveSubmission(artifactId, groupId) {
    // 不在此乐观清 compareState——后端广播 submissionChanged(null) 经 syncSubmission 收口退出对比态
    await wsClient.request({ type: 'artifact.saveSubmission', artifactId, groupId });
  },
  async cancelSubmission(artifactId, groupId) {
    await wsClient.request({ type: 'artifact.cancelSubmission', artifactId, groupId });
  },
  async discardInterrupted(artifactId, groupId) {
    await wsClient.request({ type: 'artifact.discardInterrupted', artifactId, groupId });
  },
  async enterCompare(artifactId, groupId) {
    const res = await wsClient.request({ type: 'artifact.enterCompare', artifactId, groupId });
    if (res.type === 'artifact.enterCompare.result') {
      set((s) => ({
        compareStateByArtifactId: {
          ...s.compareStateByArtifactId,
          [artifactId]: { beforeFile: res.beforeFile, afterFile: res.afterFile, showing: 'before' },
        },
      }));
    }
  },
  async exitCompare(artifactId) {
    await wsClient.request({ type: 'artifact.exitCompare', artifactId });
    set((s) => {
      if (s.compareStateByArtifactId[artifactId] == null) return {};
      const { [artifactId]: _d, ...rest } = s.compareStateByArtifactId;
      void _d;
      return { compareStateByArtifactId: rest };
    });
  },
}));

/** 跨 project 桶找某 deck 的 record（artifactsByProject 按 projectId 分桶，artifactId 全局唯一）。 */
function findDeckRecord(s: ArtifactStoreState, artifactId: string): ArtifactRecord | null {
  for (const decks of Object.values(s.artifactsByProject)) {
    const d = decks.find((x) => x.id === artifactId);
    if (d) return d;
  }
  return null;
}

/** 非 hook 版（在事件回调里取 deck record，避免 hook 限制）。 */
export function getDeckRecord(artifactId: string): ArtifactRecord | null {
  return findDeckRecord(useArtifactStore.getState(), artifactId);
}

/** 取某 deck 的 record（消费方复用，避免各处重写「遍历 artifactsByProject find」）；id 为 null/未找到回 null。 */
export function useDeckRecord(artifactId: string | null): ArtifactRecord | null {
  return useArtifactStore((s) => (artifactId ? findDeckRecord(s, artifactId) : null));
}

/**
 * activeArtifactId 派生量（§B）：活跃标签是 deck → 它的 ref（=artifactId），否则 null。
 * 消费方用本 hook（订阅 workspaceStore，活跃标签变即重渲染），不再读 artifactStore 槽位。
 */
export function useActiveArtifactId(): string | null {
  return useWorkspaceStore((s) => {
    const t = s.openTabs.find((tab) => tab.id === s.activeTabId);
    return t?.kind === 'deck' ? t.ref : null;
  });
}

/** 命令式取活跃 deck（非 hook 调用点用）。 */
export function getActiveArtifactId(): string | null {
  const s = useWorkspaceStore.getState();
  const t = s.openTabs.find((tab) => tab.id === s.activeTabId);
  return t?.kind === 'deck' ? t.ref : null;
}

/**
 * 该 deck 的「从文稿生成」任务状态（走查二批该修 4：点了按钮必须看得见状态）：
 * - 'running'：taskStore 里有归属本 deck 的活动任务（deckArtifactId 反查）→「生成中」
 * - 'queued'：派发成功但任务还没起跑 →「排队中」（乐观标记，任务出现后由 taskStore 接管）
 * - null：无进行中生成
 */
export function useDeckGenerateState(artifactId: string): 'running' | 'queued' | null {
  const latestTask = useTaskStore((s) => {
    let latest: SubagentTask | null = null;
    for (const t of Object.values(s.tasks)) {
      if (t.deckArtifactId !== artifactId) continue;
      if (!latest || t.startedAt > latest.startedAt) latest = t;
    }
    return latest;
  });
  const queuedAt = useArtifactStore((s) => s.generateQueuedByArtifact[artifactId] ?? 0);
  if (
    latestTask &&
    (latestTask.status === 'running' ||
      latestTask.status === 'pending' ||
      latestTask.status === 'awaiting_twin' ||
      latestTask.status === 'awaiting_user')
  ) {
    return 'running';
  }
  // 乐观标记只在「还没有比它更新的任务记录」时生效——任务一落地（无论后来跑到什么终态）就接管
  if (queuedAt && (!latestTask || latestTask.startedAt < queuedAt)) return 'queued';
  return null;
}

// 关 deck 标签 → 清该 artifact 的前端交互槽。closer 只拿 ref（=artifactId）。见 workspaceStore.registerTabCloser。
registerTabCloser('deck', (ref) => useArtifactStore.getState().closeArtifact(ref));

// 活跃标签变化 → 同步后端 activeDeckId（前端为准，§B）：活跃标签是 deck 推它的 ref，否则推 null。
// 切到非 deck 标签 / 关掉最后一个 deck 标签都经此把后端归零，deck 历史工具 getActiveDeckId 才不指向已离开的 deck。
// 按 'deck' kind 注册：只有「离开 deck」或「进入 deck」时派发（md↔csv 等非 deck 间切换不触达 deck listener）。
registerActiveTabListener('deck', (tab) => {
  void useArtifactStore.getState().activateArtifact(tab?.kind === 'deck' ? tab.ref : null);
});
