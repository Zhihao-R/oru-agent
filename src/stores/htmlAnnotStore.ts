import { create } from 'zustand';
import type { Annotation } from '@shared/types';
import type { ArtifactSubmissionView, ArtifactSubmitPayloadItem } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { relocateUnder, isUnder } from '@/lib/paths';
import { registerTabCloser } from '@/stores/workspaceStore';

/**
 * HTML 标注提交 store（项目B 第三期 Task15）——与 artifactStore 的标注/提交切片同构。
 *
 * 多标签（右栏标签工作区）下**按 ref 分桶**：每个打开的 html 各存一份
 * {annotations, submission, compareState, frameSelectSignal, reloadSignal}，切走不卸载、互不串改。
 *
 * 身份口径（tech design §3.6 §B）——三套口径必须一致，否则守卫永不匹配、标注串/丢：
 *  - **桶 key = 项目相对 path**（= workspace Tab.ref，与 editor/table 同口径；标签关闭时 closer
 *    只拿到 ref，桶 key 必须能从 ref 单独导出，故选相对）。
 *  - **WS html.* 的 htmlPath = 绝对路径**：主进程一律 `resolve(htmlPath)` 作 sidecar/提交组键，
 *    只有绝对路径幂等（相对会按主进程 cwd 解析到错处）。每个桶存自己的 `absPath`，动作发它。
 *  - **App.tsx 转发的广播 event.htmlPath = 绝对路径**（后端原样回 req 的 htmlPath）：sync* 事件按
 *    绝对路径找桶（比对 bucket.absPath），不按桶 key。
 *
 * compareState（改前/改后）、frameSelectSignal（触发 HtmlViewer 进框选）、reloadSignal（html.indexChanged
 * 触发 webview reload）都收在各自桶里——HtmlViewer/AnnotPane 读本桶信号驱动 webview，不在组件间散落。
 */
type HtmlCompareState = { beforeFile: string; afterFile: string; showing: 'before' | 'after' } | null;

/** 单个打开 html 的全部标注/提交/对比态（一个标签一份）。 */
export type HtmlAnnotFileState = {
  /** 该 html 绝对路径（WS htmlPath 用它；广播按它找桶）。 */
  absPath: string;
  annotations: Annotation[];
  submission: ArtifactSubmissionView | null;
  compareState: HtmlCompareState;
  /** 自增——HtmlViewer 消费后往 webview 发 frame:enter */
  frameSelectSignal: number;
  /** 自增——HtmlViewer 消费后 reload webview（html.indexChanged 落地） */
  reloadSignal: number;
};

// 消费方按 ref 取桶；桶不在时回 stable 空默认，避免 selector 每次返回新对象触发无谓重渲染。
const EMPTY_ANNOTATIONS: Annotation[] = [];

type HtmlAnnotState = {
  byRef: Record<string, HtmlAnnotFileState>; // 按 ref（项目相对 path）分桶

  /** 打开 html 预览：建桶 + 拉一次 sidecar 标注 + 提交组视图（含 reconcile）。关闭后迟到回包被桶同一性守卫丢弃。 */
  activate(ref: string, absPath: string): Promise<void>;
  /** 关闭/切走：删该桶 */
  deactivate(ref: string): void;

  // ── App.tsx 订阅 html.* 广播转过来（按绝对 htmlPath 找桶守卫）──
  syncAnnotations(htmlPath: string, annotations: Annotation[]): void;
  syncSubmission(htmlPath: string, submission: ArtifactSubmissionView | null): void;
  /** html.indexChanged：非对比态且桶存在时触发 reload */
  notifyIndexChanged(htmlPath: string): void;

  // ── 动作（发 html.* WS，htmlPath = 桶的 absPath）──
  addAnnotation(
    ref: string,
    // locator 可选：html 不存定位（PRD「点卡片不跳」），省略 → 后端归零
    args: Pick<Annotation, 'comment' | 'htmlSnippet' | 'text'> & { locator?: Annotation['locator'] },
    cropPngBase64?: string,
  ): Promise<void>;
  updateAnnotation(ref: string, annotationId: string, patch: Partial<Pick<Annotation, 'comment'>>): Promise<void>;
  removeAnnotation(ref: string, annotationId: string): Promise<void>;
  submitAnnotations(
    ref: string,
    annotationIds: string[],
    conversationId: string,
  ): Promise<{ groupId: string; payload: ArtifactSubmitPayloadItem[] } | null>;
  stopSubmission(ref: string, groupId: string): Promise<void>;
  manualFinalize(ref: string, groupId: string): Promise<void>;
  saveSubmission(ref: string, groupId: string): Promise<void>;
  cancelSubmission(ref: string, groupId: string): Promise<void>;
  discardInterrupted(ref: string, groupId: string): Promise<void>;
  enterCompare(ref: string, groupId: string): Promise<void>;
  exitCompare(ref: string): Promise<void>;
  /** 对比态内切改前/改后（不发 RPC） */
  setCompareShowing(ref: string, showing: 'before' | 'after'): void;
  /** AnnotPanel 点「框选」→ 给本桶发信号；HtmlViewer 消费进框选 */
  requestFrameSelect(ref: string): void;
  /** 打开的 html 被改名/移动 → 桶 key + absPath 跟随（与 editor/table.relocate 同形）。 */
  relocate(oldRel: string, newRel: string): void;
  /** 打开的 html（或其所在目录）被删 → 删对应桶。 */
  closeIfUnder(path: string): void;
};

/** 新建一个 html 桶的初值。 */
function emptyFileState(absPath: string): HtmlAnnotFileState {
  return { absPath, annotations: [], submission: null, compareState: null, frameSelectSignal: 0, reloadSignal: 0 };
}

export const useHtmlAnnotStore = create<HtmlAnnotState>((set, get) => {
  /** 应用 patch 到某 ref 的桶（桶不在则忽略——已被关/未打开）。 */
  function patch(ref: string, p: Partial<HtmlAnnotFileState>): void {
    const byRef = get().byRef;
    const cur = byRef[ref];
    if (!cur) return;
    set({ byRef: { ...byRef, [ref]: { ...cur, ...p } } });
  }

  /** 按绝对路径找桶（广播守卫用：广播带绝对 htmlPath，桶 key 是相对 ref）。返回 [ref, 桶] 或 null。 */
  function findByAbs(htmlPath: string): [string, HtmlAnnotFileState] | null {
    for (const [ref, f] of Object.entries(get().byRef)) {
      if (f.absPath === htmlPath) return [ref, f];
    }
    return null;
  }

  return {
    byRef: {},

    async activate(ref, absPath) {
      const existing = get().byRef[ref];
      if (existing && existing.absPath === absPath) return; // 重开即切过去，保留现场，不重拉
      set({ byRef: { ...get().byRef, [ref]: emptyFileState(absPath) } });
      const bucketBefore = get().byRef[ref];
      const res = await wsClient.request({ type: 'html.activate', htmlPath: absPath });
      // await 后桶同一性守卫：切文件/关闭后迟到的回包不写进新桶（桶被删→空；被重开→新对象）
      if (res.type === 'html.activate.result' && get().byRef[ref] === bucketBefore) {
        patch(ref, { annotations: res.annotations, submission: res.submission });
      }
    },
    deactivate(ref) {
      const { [ref]: _removed, ...rest } = get().byRef;
      void _removed;
      set({ byRef: rest });
    },

    syncAnnotations(htmlPath, annotations) {
      const hit = findByAbs(htmlPath);
      if (!hit) return; // 桶不在=未打开该 html，丢弃迟到事件
      patch(hit[0], { annotations });
    },
    syncSubmission(htmlPath, submission) {
      const hit = findByAbs(htmlPath);
      if (!hit) return;
      // 对比基准绑提交组：组解散（submission=null）时对比基准失效，一并退出对比态（以广播为权威）
      patch(hit[0], {
        submission,
        ...(submission === null && hit[1].compareState ? { compareState: null } : {}),
      });
    },
    notifyIndexChanged(htmlPath) {
      const hit = findByAbs(htmlPath);
      if (!hit || hit[1].compareState) return; // 桶不在 / 对比态不 reload（会丢对比视图）
      patch(hit[0], { reloadSignal: hit[1].reloadSignal + 1 });
    },

    async addAnnotation(ref, args, cropPngBase64) {
      const f = get().byRef[ref];
      if (!f) return;
      await wsClient.request({ type: 'html.addAnnotation', htmlPath: f.absPath, annotation: args, cropPngBase64 });
    },
    async updateAnnotation(ref, annotationId, patchArg) {
      const f = get().byRef[ref];
      if (!f) return;
      await wsClient.request({ type: 'html.updateAnnotation', htmlPath: f.absPath, annotationId, patch: patchArg });
    },
    async removeAnnotation(ref, annotationId) {
      const f = get().byRef[ref];
      if (!f) return;
      await wsClient.request({ type: 'html.removeAnnotation', htmlPath: f.absPath, annotationId });
    },
    async submitAnnotations(ref, annotationIds, conversationId) {
      const f = get().byRef[ref];
      if (!f) return null;
      const res = await wsClient.request({
        type: 'html.submitAnnotations',
        htmlPath: f.absPath,
        annotationIds,
        conversationId,
      });
      if (res.type === 'html.submitAnnotations.result' && res.ok && res.groupId && res.payload) {
        return { groupId: res.groupId, payload: res.payload };
      }
      return null;
    },
    async stopSubmission(ref, groupId) {
      const f = get().byRef[ref];
      if (!f) return;
      await wsClient.request({ type: 'html.stopSubmission', htmlPath: f.absPath, groupId });
    },
    async manualFinalize(ref, groupId) {
      const f = get().byRef[ref];
      if (!f) return;
      await wsClient.request({ type: 'html.manualFinalize', htmlPath: f.absPath, groupId });
    },
    async saveSubmission(ref, groupId) {
      const f = get().byRef[ref];
      if (!f) return;
      // 不乐观清 compareState——后端广播 submissionChanged(null) 经 syncSubmission 收口退出对比
      await wsClient.request({ type: 'html.saveSubmission', htmlPath: f.absPath, groupId });
    },
    async cancelSubmission(ref, groupId) {
      const f = get().byRef[ref];
      if (!f) return;
      await wsClient.request({ type: 'html.cancelSubmission', htmlPath: f.absPath, groupId });
    },
    async discardInterrupted(ref, groupId) {
      const f = get().byRef[ref];
      if (!f) return;
      await wsClient.request({ type: 'html.discardInterrupted', htmlPath: f.absPath, groupId });
    },
    async enterCompare(ref, groupId) {
      const f = get().byRef[ref];
      if (!f) return;
      const bucketBefore = f;
      const res = await wsClient.request({ type: 'html.enterCompare', htmlPath: f.absPath, groupId });
      // await 后桶同一性守卫：切走/关闭后迟到的对比回包不写进新桶
      if (res.type === 'html.enterCompare.result' && get().byRef[ref] === bucketBefore) {
        patch(ref, { compareState: { beforeFile: res.beforeFile, afterFile: res.afterFile, showing: 'before' } });
      }
    },
    async exitCompare(ref) {
      const f = get().byRef[ref];
      if (!f) return;
      await wsClient.request({ type: 'html.exitCompare', htmlPath: f.absPath });
      patch(ref, { compareState: null });
    },
    setCompareShowing(ref, showing) {
      const f = get().byRef[ref];
      if (f?.compareState) patch(ref, { compareState: { ...f.compareState, showing } });
    },
    requestFrameSelect(ref) {
      const f = get().byRef[ref];
      if (f) patch(ref, { frameSelectSignal: f.frameSelectSignal + 1 });
    },

    relocate(oldRel, newRel) {
      const byRef = get().byRef;
      const nextByRef: Record<string, HtmlAnnotFileState> = {};
      let changed = false;
      for (const [ref, f] of Object.entries(byRef)) {
        const next = relocateUnder(ref, oldRel, newRel);
        if (next === null || next === ref) {
          nextByRef[ref] = f;
          continue;
        }
        changed = true;
        // absPath 末尾恰好是旧 ref（projectRoot + ref 派生）——整段相对部分换成迁移后的 ref。
        const nextAbs = f.absPath.slice(0, f.absPath.length - ref.length) + next;
        nextByRef[next] = { ...f, absPath: nextAbs };
      }
      if (changed) set({ byRef: nextByRef });
    },

    closeIfUnder(path) {
      for (const ref of Object.keys(get().byRef)) {
        if (isUnder(ref, path)) get().deactivate(ref);
      }
    },
  };
});

/** stable 空默认：桶不在时供 selector 返回，避免每次新数组触发重渲染。 */
export const emptyHtmlAnnotations = (): Annotation[] => EMPTY_ANNOTATIONS;

// 标签关闭 → 删该 html 的桶。closer 只拿 ref（项目相对 path）= 桶 key。见 workspaceStore.registerTabCloser。
registerTabCloser('html', (ref) => useHtmlAnnotStore.getState().deactivate(ref));
