import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Minimize2, X } from 'lucide-react';
import type { Annotation, AsideDeckClickPayload } from '@shared/types';
import { useArtifactStore } from '@/stores/artifactStore';
import { useProjectStore } from '@/stores/projectStore';
import { PROFILE_CAPS } from '@/lib/profileCaps';
import { fileUrl } from '@/lib/fileUrl';
import { wsClient } from '@/lib/ws';
import type { ServerEvent } from '@shared/protocol';
import { createPreviewReloader, type PreviewBadge } from '@/lib/previewReload';
import { OutlineStrip } from '@/components/deck/OutlineStrip';
import { assembleDeckAsideClick } from '@/aside/deckClick';
import { dispatchAsideClick } from '@/aside/dispatch';
import { normalizePngToLogical } from '@/aside/normalizeShot';

// Deck 设计稿默认尺寸：preload 没读到 <meta name="oru-deck-size"> 时的 fallback
const DEFAULT_DECK_WIDTH = 1920;
const DEFAULT_DECK_HEIGHT = 1080;

// NativeImage.toPNG() 的 bytes → base64（无 data: 前缀），喂给 WS addAnnotation。
// 分块避免 String.fromCharCode(...大数组) 爆栈。
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// 稳定 EMPTY deckMeta 引用——slideCount=0 时 selector fallback 用；profile 默认 deck（启动前）
const EMPTY_DECK_META = { width: DEFAULT_DECK_WIDTH, height: DEFAULT_DECK_HEIGHT, slideCount: 0, profile: 'deck' as const };

// Electron webview 类型——直接内联避免 `import type 'electron'` 让 Vite 在 renderer 试图
// bundle main 进程 API（实测会让整个 React tree 渲染挂掉白屏）
// Electron NativeImage 的最小子集——只用到 toPNG()
type NativeImageLike = { toPNG(): Uint8Array; isEmpty(): boolean };
type WebviewTag = HTMLElement & {
  reload(): void;
  executeJavaScript(code: string): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  // 截 webview 可视区某个矩形（DIP 坐标）；返回的 NativeImage 按 dpr 放大
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImageLike>;
};
type IpcMessageEvent = { channel: string; args: unknown[] };

/**
 * Deck 预览面板
 *
 * 内嵌 <webview> 渲染 deck index.html；通过 preload script (deckPreview.cjs) 监听
 * 用户操作（右键行内编辑 / 翻页 / Esc / Ctrl+Z）转 sendToHost；
 * 这里通过 webview.addEventListener('ipc-message') 接住 + 分发到 deckStore。
 *
 * 监听 WS deck.indexChanged → webview.reload() 实现 hot reload。
 *
 * 注释是页级模型（每页一条），UI 在右侧 AnnotPane，PreviewPane 自己不直接处理 annotation。
 */
type Props = {
  artifactId: string;
  deckPath: string;
  /** 所属项目 id——把 fs.changed 的项目相对 filePath 与本 deck 的 index.html 绝对路径对齐用（块③）。 */
  projectId: string;
  /** 活跃 deck 标签：keep-mounted 下多个 PreviewPane 同时在 DOM，只有活跃的才绑 document 级翻页键 /
   *  Esc / 全屏同步——否则非活跃 deck 也会响应键盘、或与活跃 deck 抢 OS 全屏。 */
  isActive: boolean;
};

export function PreviewPane({ artifactId, deckPath, projectId, isActive }: Props) {
  const { t } = useTranslation('deck');
  // webview 元素引用走 state：挂监听的 effect 以 wv 为依赖——元素被 React 换掉时
  // 旧 effect cleanup 摘旧监听、新 effect 在新元素上重挂（监听跟着元素走，不跟组件生命周期走）。
  // ref 是同步镜像，供事件回调 / 信号消费等非监听调用点读最新元素。
  const [wv, setWv] = useState<WebviewTag | null>(null);
  const ref = useRef<WebviewTag | null>(null);
  // useCallback 钉稳引用——callback ref 身份变化会让 React 每次渲染都 detach/attach 一遍
  const attachWebview = useCallback((el: HTMLElement | null) => {
    const tag = el as WebviewTag | null;
    ref.current = tag;
    setWv(tag);
  }, []);
  const letterboxRef = useRef<HTMLDivElement | null>(null);

  // Deck 设计稿尺寸 + slide 总数 + profile：preload DOMContentLoaded 后通过 'oru:deckMeta' 推过来。
  // 存到 store 让 AnnotPane 也能读 slideCount 列 N 张卡。
  const deckMeta = useArtifactStore((s) => s.deckMetaByArtifact[artifactId] ?? EMPTY_DECK_META);
  const setArtifactMeta = useArtifactStore((s) => s.setArtifactMeta);

  // 能力表查询——所有分支通过 caps.xxx 驱动，不散落 profile 字符串比较
  const caps = PROFILE_CAPS[deckMeta.profile];

  // 当前页 index：单一真源在 store（按 artifactId 分桶），桶无值=第 0 页。
  // PreviewPane 读它驱动 webview + toolbar；大纲条点击/重排/滚轮也写它 → 三处永远一致。
  // 多 deck 标签 keep-mounted 下各读各的桶，互不串页。
  const currentPage = useArtifactStore((s) => s.currentPageIndexByArtifactId[artifactId] ?? 0);
  const setCurrentPage = useArtifactStore((s) => s.setCurrentPage);

  // letterbox 内 stage box 尺寸：按 deckMeta 的比例算——webview 直接占这个尺寸
  // plain profile（fixedScale=false）：跳过 measure，webview 自适应容器 100%
  const slideAspect = deckMeta.width / deckMeta.height;
  const [stageBox, setStageBox] = useState<{ width: number; height: number }>({ width: 960, height: 540 });
  useLayoutEffect(() => {
    if (!caps.fixedScale) return;
    const node = letterboxRef.current;
    if (!node) return;
    const measure = (cw: number, ch: number) => {
      if (cw <= 0 || ch <= 0) return;
      const cr = cw / ch;
      const w = cr > slideAspect ? ch * slideAspect : cw;
      const h = cr > slideAspect ? ch : cw / slideAspect;
      setStageBox({ width: Math.floor(w), height: Math.floor(h) });
    };
    measure(node.clientWidth, node.clientHeight);
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) measure(r.width, r.height);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [slideAspect, caps.fixedScale]);

  const applyInlineEdit = useArtifactStore((s) => s.applyInlineEdit);
  const addAnnotation = useArtifactStore((s) => s.addAnnotation);
  const undo = useArtifactStore((s) => s.undo);
  const redo = useArtifactStore((s) => s.redo);
  const setChromeState = useArtifactStore((s) => s.setChromeState);
  const chromeState = useArtifactStore((s) => s.chromeStateByArtifactId[artifactId] ?? 'work');

  // 对比模式：本 artifact 的对比桶有值时，webview 指向 before/after 临时快照，
  // 对比期不接受新框选（改前/改后切换 UI 在 PreviewControls）。
  const compareForThis = useArtifactStore((s) => s.compareStateByArtifactId[artifactId] ?? null);

  // 跳转信号消费：AnnotPane 点卡片 → 跳到标注位置（读本 artifact 的跳转桶）。
  // deck（paging）翻页；plain 走 webview scrollTo。ref 记上次处理的 nonce 避免重复执行。
  const jumpSignal = useArtifactStore((s) => s.jumpSignalByArtifactId[artifactId] ?? null);
  const lastJumpNonceRef = useRef(0);
  useEffect(() => {
    if (!jumpSignal) return;
    if (jumpSignal.nonce === lastJumpNonceRef.current) return;
    lastJumpNonceRef.current = jumpSignal.nonce;
    if (caps.paging && jumpSignal.pageIndex != null) {
      setCurrentPage(artifactId, jumpSignal.pageIndex);
    } else if (!caps.fixedScale) {
      try { ref.current?.send('oru:scrollTo', jumpSignal.scrollY); } catch { /* webview 未 ready */ }
    }
  }, [jumpSignal, artifactId, caps.paging, caps.fixedScale, setCurrentPage]);

  // 框选信号消费：AnnotPane 点「框选标注」→ 进入框选模式（读本 artifact 的框选桶）。对比态忽略（预览锁定在快照）。
  const frameSelectSignal = useArtifactStore((s) => s.frameSelectSignalByArtifactId[artifactId] ?? 0);
  const lastFrameSignalRef = useRef(0);
  useEffect(() => {
    if (frameSelectSignal === lastFrameSignalRef.current) return;
    lastFrameSignalRef.current = frameSelectSignal;
    if (frameSelectSignal === 0 || compareForThis) return;
    try { ref.current?.send('frame:enter'); } catch { /* webview 未 ready */ }
  }, [frameSelectSignal, compareForThis]);

  // reload 信号消费：本 artifact 的 indexChanged 落地 → 自增 reloadSignal → reload 本 deck 的 webview。
  // 按 artifactId 路由（取代旧 document.querySelector('webview')，§3.8）；对比态由 store.notifyIndexChanged 已拦。
  const reloadSignal = useArtifactStore((s) => s.reloadSignalByArtifactId[artifactId] ?? 0);
  const lastReloadRef = useRef(0);
  useEffect(() => {
    if (reloadSignal === lastReloadRef.current) return;
    lastReloadRef.current = reloadSignal;
    if (reloadSignal === 0) return;
    try { ref.current?.reload(); } catch { /* webview 未 ready */ }
  }, [reloadSignal]);

  // 「看见」（块③/§2.3）：AI 改本 deck 的 index.html → fs.changed(filePath) 命中 → 0.5s 节流后 reload + 角标。
  // 页码由现有 reload→oru:setPage(currentPage) 机制自动保持。deckPath 绝对、filePath 项目相对——经 projectRoot 对齐比对。
  //
  // 与上方 indexChanged 的分工：主对话 LLM 直接改某页 = 只发 fs.changed（无 indexChanged），本接收方是该常见
  // 场景的唯一 reload 来源、不可省。少数流程（deck 创建子 agent、updateFromNarrative 收尾）会同时发
  // indexChanged + fs.changed → 两次 reload（均保持页码、仅多一次重绘，非数据问题）；该冗余仅限这两类流程、
  // 非常见直接编辑，本期接受、不为它引入两路去重耦合（保 reorder/checkout 经 indexChanged 的即时性）。
  const projectRoot = useProjectStore((s) => s.projects.find((p) => p.id === projectId)?.path ?? null);
  const [syncBadge, setSyncBadge] = useState<PreviewBadge>(null);
  useEffect(() => {
    if (!projectRoot) return;
    const deckIndexAbs = `${deckPath}/index.html`;
    const reloader = createPreviewReloader({
      reload: () => {
        try { ref.current?.reload(); } catch { /* webview 未 ready */ }
      },
      onBadge: setSyncBadge,
    });
    const unsub = wsClient.subscribe((ev: ServerEvent) => {
      if (ev.type !== 'fs.changed' || ev.projectId !== projectId || !ev.filePath) return;
      if (`${projectRoot}/${ev.filePath}` !== deckIndexAbs) return;
      if (compareForThis) return; // 对比态锁快照，不被实时落盘打断
      reloader.hit();
    });
    return () => {
      unsub();
      reloader.dispose();
    };
  }, [projectId, projectRoot, deckPath, compareForThis]);

  // host 层 Esc：沉浸/全屏态下按 Esc 逐级退出。webview 没焦点时 preload 的 key:escape 收不到，
  // 在主窗口 document 上兜底（work 态不拦，留给页面/弹层）。
  useEffect(() => {
    if (!isActive || chromeState === 'work') return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setChromeState(artifactId, chromeState === 'fullscreen' ? 'immersive' : 'work');
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [isActive, chromeState, setChromeState, artifactId]);

  // 监听 IPC 消息——以 wv 为依赖：元素被换时旧元素监听随 cleanup 摘除、新元素重挂
  useEffect(() => {
    if (!wv) return;
    const onMsg = async (ev: Event) => {
      const e = ev as unknown as IpcMessageEvent;
      switch (e.channel) {
        case 'inline:edited': {
          const { markerId, oldText, newText, pageIndex } = e.args[0] as {
            markerId: string | null;
            oldText: string;
            newText: string;
            pageIndex: number;
          };
          const r = await applyInlineEdit(artifactId, { markerId, oldText, newText, pageIndex });
          // 仅"定位降级"才通知 preload 回滚 DOM + 提示"用框选交给 AI 改"；
          // io/其它失败不是降级，提示框选会误导（应是"保存失败"），此处不回滚不提示。
          if (!r.ok && r.degraded) {
            try { wv.send('inline:editRejected'); } catch { /* webview 未 ready */ }
          }
          break;
        }
        case 'key:chrome': {
          // F 键：work ↔ immersive ↔ fullscreen 三态机（读本 artifact 的 chrome 桶）
          const cur = useArtifactStore.getState().chromeStateByArtifactId[artifactId] ?? 'work';
          if (cur === 'work') setChromeState(artifactId, 'immersive');
          else if (cur === 'immersive') setChromeState(artifactId, 'fullscreen');
          // fullscreen 状态下按 F 不切换——只能 Esc 退出（用户必须明确退）
          break;
        }
        case 'key:escape': {
          const cur = useArtifactStore.getState().chromeStateByArtifactId[artifactId] ?? 'work';
          if (cur === 'fullscreen') setChromeState(artifactId, 'immersive');
          else if (cur === 'immersive') setChromeState(artifactId, 'work');
          // work 态下 Esc 不响应——给浏览器 / 弹层处理
          break;
        }
        case 'key:undo': {
          await undo(artifactId);
          break;
        }
        case 'key:redo': {
          await redo(artifactId);
          break;
        }
        case 'oru:deckMeta': {
          // preload DOMContentLoaded 后推过来：设计稿尺寸 + slide 总数 + profile
          // 切换/reload deck 都会再推一次。不在这里 setCurrentPage(0)——
          // reload（deck.indexChanged → wv.reload()）跟切换是同一个事件，硬重置会让
          // 用户翻到第 3 页后被 inline edit 触发的 reload 弹回第 0 页。
          const { width, height, slideCount, profile } = e.args[0] as {
            width: number; height: number; slideCount: number; profile: 'deck' | 'plain';
          };
          setArtifactMeta(artifactId, { width, height, slideCount, profile });
          // slide 数量减少时把越界的 currentPage 收回边界（store.setCurrentPage 按新 slideCount clamp）
          setCurrentPage(artifactId, useArtifactStore.getState().currentPageIndexByArtifactId[artifactId] ?? 0);
          break;
        }
        case 'frame:captured': {
          // preload 框选松手：拿坐标 + 快照，host 负责截图 + 落标注
          const { scaledRect, htmlSnippet, text, locator } = e.args[0] as {
            rect: { x: number; y: number; w: number; h: number };
            scaledRect: { x: number; y: number; w: number; h: number };
            htmlSnippet: string;
            text: string;
            locator: Annotation['locator'];
          };
          let cropPngBase64: string | undefined;
          try {
            // capturePage 吃 DIP 坐标（{x,y,width,height}）；preload 已给视口 CSS 像素，不乘 dpr。
            // 取整避免亚像素 rect 让 capturePage 返回空图。
            const img = await wv.capturePage({
              x: Math.round(scaledRect.x),
              y: Math.round(scaledRect.y),
              width: Math.max(1, Math.round(scaledRect.w)),
              height: Math.max(1, Math.round(scaledRect.h)),
            });
            if (!img.isEmpty()) cropPngBase64 = uint8ToBase64(img.toPNG());
          } catch {
            // 截图失败（极少见）→ 降级为无图标注，AI 靠 htmlSnippet
          }
          // 跨域/失败导致 htmlSnippet 为空也照常落标注——AI 靠视觉（crop 图）
          await addAnnotation(
            artifactId,
            { comment: '', htmlSnippet, text, locator },
            cropPngBase64,
          );
          break;
        }
        case 'aside:clicked': {
          // preload ⌥点上抛：翻译成 AsideReferent + 截图归一，交给 aside 分发点（浮层消费）
          const payload = e.args[0] as AsideDeckClickPayload;
          // 主窗口选区优先（同步零成本查一次）——覆盖"主窗口选中后 ⌥点 deck"
          const hostSelectionText = window.getSelection()?.toString() ?? '';
          const rect = wv.getBoundingClientRect();
          // 截图 ~300ms 上限：超时/失败 → 无图降级，浮层照常（frame:captured 降级先例同哲学）。
          // 超时分支用 resolve(null) 而非 reject——race 输掉的 promise 没人接 reject 会变 unhandledrejection。
          let screenshotBase64: string | undefined;
          try {
            const img = await Promise.race([
              // 输家也要接住 reject：超时先赢后 capturePage 再失败（webview 销毁等），
              // 没人接的 rejection 会变 unhandledrejection
              wv.capturePage().catch(() => null),
              new Promise<null>((res) => setTimeout(() => res(null), 300)),
            ]);
            if (img && !img.isEmpty()) {
              // capturePage 输出物理像素，归一回逻辑尺寸（= webview 元素 CSS 尺寸）
              screenshotBase64 = await normalizePngToLogical(img.toPNG(), rect.width, rect.height);
            }
          } catch { /* 降级无图 */ }
          dispatchAsideClick(assembleDeckAsideClick({
            payload,
            hostSelectionText,
            screenshotBase64,
            webviewRect: { left: rect.left, top: rect.top },
          }));
          break;
        }
        case 'key:nav': {
          // webview 内箭头键：webview 没法直接改 host state，转发上来 host 统一处理边界
          const { dir } = e.args[0] as { dir: 'prev' | 'next' };
          // 读 store 最新页号 ±1（store.setCurrentPage 自带边界 clamp）
          const cur = useArtifactStore.getState().currentPageIndexByArtifactId[artifactId] ?? 0;
          setCurrentPage(artifactId, dir === 'next' ? cur + 1 : cur - 1);
          break;
        }
        default:
          break;
      }
    };
    wv.addEventListener('ipc-message', onMsg);
    return () => { wv.removeEventListener('ipc-message', onMsg); };
  }, [wv, artifactId, applyInlineEdit, undo, redo, setChromeState, setArtifactMeta, addAnnotation]);

  // 几个 ref 镜像：onMsg / onReady 的闭包不含这些 state（effect deps 只有 wv 等），捕获的是注册时的快照。
  // - deckMetaRef: onReady 推 scale 要读最新设计稿宽度
  // - currentPageRef: onReady（webview reload 后会再次触发）要把当前页推回 preload
  // - stageBoxRef: 同 onReady，reload 时容器若已变尺寸，需要推最新 scale
  const deckMetaRef = useRef(deckMeta);
  deckMetaRef.current = deckMeta;
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const stageBoxRef = useRef(stageBox);
  stageBoxRef.current = stageBox;

  // 全局左右键翻页：host 直接改 currentPage state，不再走 webview 中转
  // plain profile（paging=false）：不绑定，让方向键给页面原生滚动
  // 避开用户在 input/textarea/contenteditable 内打字时拦截方向键
  useEffect(() => {
    if (!isActive || !caps.paging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae) {
        const tag = ae.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return;
      }
      e.preventDefault();
      const cur = useArtifactStore.getState().currentPageIndexByArtifactId[artifactId] ?? 0;
      setCurrentPage(artifactId, e.key === 'ArrowRight' ? cur + 1 : cur - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isActive, caps.paging, artifactId, setCurrentPage]);

  // chromeState='fullscreen' ↔ Electron BrowserWindow.setFullScreen 双向同步——只活跃 deck 做，
  // 否则非活跃 deck 的 chrome 桶（多为 work）会把 OS 全屏关掉、与活跃 deck 抢窗口态。
  useEffect(() => {
    if (!isActive) return;
    void window.oruWindow?.setFullScreen(chromeState === 'fullscreen');
  }, [isActive, chromeState]);
  useEffect(() => {
    if (!isActive) return;
    const off = window.oruWindow?.onFullScreenChanged((isFs) => {
      const cur = useArtifactStore.getState().chromeStateByArtifactId[artifactId] ?? 'work';
      if (isFs && cur !== 'fullscreen') setChromeState(artifactId, 'fullscreen');
      // OS 退出全屏（用户按 Cmd+Ctrl+F）→ 回到 immersive，不直接掉到 work
      if (!isFs && cur === 'fullscreen') setChromeState(artifactId, 'immersive');
    });
    return off;
  }, [isActive, setChromeState, artifactId]);

  // webview ready 状态——dom-ready 前 wv.send 会同步抛错，必须等 ready 才推
  const wvReadyRef = useRef(false);
  // caps ref：dom-ready handler 是 empty-deps，闭包里读不到最新 caps，用 ref 镜像
  const capsRef = useRef(caps);
  capsRef.current = caps;
  // dom-ready 以 wv 为依赖挂载；reload 会再触发，ref 重新 set true 后推 scale + 当前页
  useEffect(() => {
    if (!wv) return;
    const onReady = () => {
      wvReadyRef.current = true;
      try {
        const cur = capsRef.current;
        // fixedScale=true（deck）：推 scale；plain 跳过，让 webview 自然铺满
        if (cur.fixedScale) {
          // 全部从 ref 读最新值——这个 useEffect 的 deps 只有 wv，闭包里的 state 是注册时的快照
          const sb = stageBoxRef.current;
          const deckW = deckMetaRef.current.width;
          if (sb.width > 0 && deckW > 0) wv.send('oru:setDeckScale', sb.width / deckW);
        }
        // paging=true（deck）：推当前页；plain 无分页，跳过
        if (cur.paging) {
          wv.send('oru:setPage', currentPageRef.current);
        }
      } catch { /* */ }
    };
    const onStart = () => { wvReadyRef.current = false; };
    wv.addEventListener('dom-ready', onReady);
    wv.addEventListener('did-start-loading', onStart);
    return () => {
      wv.removeEventListener('dom-ready', onReady);
      wv.removeEventListener('did-start-loading', onStart);
    };
  }, [wv]);

  // stageBox / deckMeta 变化（容器 resize / 列宽拖拽 / 切换比例不同的 deck）→ 推新 scale
  // plain（fixedScale=false）：webview 铺满容器，不推 scale
  // dom-ready 前 stageBox 变化不发（webview 还没准备好）；ready 后由 onReady 补一次
  useEffect(() => {
    if (!caps.fixedScale) return;
    if (!wvReadyRef.current) return;
    const wv = ref.current;
    if (!wv || stageBox.width <= 0 || deckMeta.width <= 0) return;
    try { wv.send('oru:setDeckScale', stageBox.width / deckMeta.width); } catch { /* */ }
  }, [stageBox, deckMeta.width, caps.fixedScale]);

  // currentPage 变化 → 推给 preload 切换 active slide
  // plain（paging=false）：无分页，跳过
  useEffect(() => {
    if (!caps.paging) return;
    if (!wvReadyRef.current) return;
    const wv = ref.current;
    if (!wv) return;
    try { wv.send('oru:setPage', currentPage); } catch { /* */ }
  }, [currentPage, caps.paging]);

  const preloadPath = window.__ORU__?.deckPreviewPreloadPath ?? '';
  // 对比态：src 指向 before/after 临时快照（主动切 src 触发 reload 加载另一份，正常行为，
  // 与"冻结后端 indexChanged hot reload"不冲突）。非对比态用 index.html。
  const webviewSrc = compareForThis
    ? fileUrl(`${deckPath}/${compareForThis.showing === 'before' ? compareForThis.beforeFile : compareForThis.afterFile}`)
    : fileUrl(`${deckPath}/index.html`);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      {/* 实时同步角标（块③/§2.3）：「正在同步…→已更新→消失」，让你确认画面实时、并非卡顿 */}
      {syncBadge ? (
        <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-md border border-border bg-elevated/90 px-2 py-1 text-xs text-text-secondary shadow-sm">
          {syncBadge === 'syncing' ? t('common:sync.syncing') : t('common:sync.updated')}
        </div>
      ) : null}
      {/* 工作态工具栏（文件路径/对比/沉浸/全屏/关闭）已上提到 DeckCenter 的统一工具栏（PreviewControls），
          与「预览/文稿」标签同处一行；这里只保留视口 + 沉浸/全屏态的浮动退出按钮。 */}

      {/* 沉浸/全屏态右上角浮动退出按钮——半透明，hover 时变明显 */}
      {chromeState !== 'work' ? (
        <button
          type="button"
          onClick={() => setChromeState(artifactId, chromeState === 'fullscreen' ? 'immersive' : 'work')}
          title={chromeState === 'fullscreen' ? t('preview.exitFullscreen') : t('preview.exitImmersive')}
          className="absolute right-4 top-4 z-50 flex h-8 w-8 items-center justify-center rounded-full bg-black/30 text-white/70 opacity-30 backdrop-blur transition hover:opacity-100"
        >
          {chromeState === 'fullscreen' ? <Minimize2 size={14} strokeWidth={1.8} /> : <X size={16} strokeWidth={1.8} />}
        </button>
      ) : null}

      {/* 预览区域
          deck（fixedScale=true）：letterbox + stageBox 定尺，设计稿缩放由 preload body transform: scale 完成
          plain（fixedScale=false）：webview 铺满容器，原生滚动，无缩放 */}
      <div
        ref={letterboxRef}
        className={`relative min-h-0 flex-1 ${caps.fixedScale ? 'flex items-center justify-center bg-sunken p-3' : 'flex'}`}
      >
        {/* stagebox：deck 定尺白底圆角；plain 退化为无装饰 100%×100%。
            元素树形状不随 profile 变（letterbox > stagebox > webview 恒定）——
            profile 翻转时 React 同位复用 webview 元素，不拆建、监听不丢。 */}
        <div
          className={caps.fixedScale ? 'relative rounded-[3px] overflow-hidden bg-white' : 'relative'}
          style={caps.fixedScale ? { width: stageBox.width, height: stageBox.height } : { width: '100%', height: '100%' }}
        >
          <webview
            ref={attachWebview}
            src={webviewSrc}
            preload={preloadPath}
            partition="persist:deck-preview"
            // display: inline-flex 是 Electron <webview> 的官方约定：默认 embed intrinsic 300×150，
            // display: block 时内部 webContents viewport 高度不跟随 CSS height，必须用 inline-flex 才会跑满
            style={{ width: '100%', height: '100%', display: 'inline-flex' }}
          />
        </div>
      </div>

      {/* 底部大纲条：deck profile（caps.outline）+ 工作态 + 非对比态才显示。
          对比态预览锁在快照上不接受重排；plain profile（outline=false）无大纲条。 */}
      {caps.outline && chromeState === 'work' && !compareForThis ? (
        <OutlineStrip artifactId={artifactId} />
      ) : null}
    </div>
  );
}
