import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History, Download, Loader2, X, ChevronDown } from 'lucide-react';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { lezerDialect } from '@/lib/markdownDialect';
import { newChatRefId } from '@shared/ids';
import { useEditorStore } from '@/stores/editorStore';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useChatStore, composerKey } from '@/stores/chatStore';
import { MdEditor } from './MdEditor';
import { uploadDocImage } from '@/lib/docImageUpload';
import { type CropRequest } from './livePreview';
import { RectCropDialog } from './RectCropDialog';
import { mdHighlight } from './mdEditorTheme';
import { FileHistoryDialog } from './FileHistoryDialog';
import { ExportMenu, type ExportFormat } from './ExportMenu';
import { exportDoc, cancelDocExport } from '@/lib/exportDoc';
import { ViewerToolbar, ToolbarIconButton, ToolbarTextButton, ToolbarDivider } from '@/components/workspace/ViewerToolbar';
import { createPreviewReloader, type PreviewBadge } from '@/lib/previewReload';
import { wsClient } from '@/lib/ws';
import type { ServerEvent } from '@shared/protocol';

// 历史窗口的 md 高亮扩展——模块级常量，避免每渲染重建 MergeView
const mdHistoryExtensions = [markdown({ extensions: lezerDialect }), syntaxHighlighting(mdHighlight)];

/**
 * 单个 md/txt 编辑器面板——右栏标签工作区里的一个 editor 标签（path 即标签身份）。
 * 多实例可 keep-mounted 并存，各读 editorStore 自己 path 的桶、互不串改。文件名与关闭 ✕
 * 归标签栏（TabBar），本面板只剩工具条（历史）。窗口级监听（⌘S / 失焦同步）仅活跃标签绑定。
 */
export function EditorPane({ path, isActive }: { path: string; isActive: boolean }): JSX.Element {
  const { t } = useTranslation('editor');
  const fileState = useEditorStore((s) => s.files[path]);
  const projectId = fileState?.ref.kind === 'project' ? fileState.ref.projectId : null;
  const content = fileState?.content ?? '';
  const loading = fileState?.loading ?? true; // 桶还没建好（open 在途）也按加载中
  const setContent = useEditorStore((s) => s.setContent);
  const manualSnapshot = useEditorStore((s) => s.manualSnapshot);
  const flush = useEditorStore((s) => s.flush);
  const syncFromDisk = useEditorStore((s) => s.syncFromDisk);
  const noteCompositionEnd = useEditorStore((s) => s.noteCompositionEnd);
  const restoreFromHistory = useEditorStore((s) => s.restoreFromHistory);

  // 选段「加入对话」：sourcePath = 本标签 path。
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const activeConvId = useConversationStore((s) =>
    activeAgentId ? s.activeByAgent[activeAgentId] ?? null : null,
  );
  const composerConvKey = composerKey(activeAgentId, activeConvId);
  const addComposerRef = useChatStore((s) => s.addComposerRef);

  const [historyOpen, setHistoryOpen] = useState(false);

  // 同步角标（A2 状态条）：Oru 落盘本文档 → fs.changed 命中 → 「正在同步…→已更新→散」。
  // 内容同步与修改高亮已由 editorStore 全局订阅（applyExternalContent）处理，本处 reload 空转，
  // 只复用 previewReload 的 1.2s 徽记状态机驱动状态条文案（与 html/deck 同一套时序，系统性）。
  const [syncBadge, setSyncBadge] = useState<PreviewBadge>(null);
  useEffect(() => {
    if (!projectId) return;
    const reloader = createPreviewReloader({ reload: () => {}, onBadge: setSyncBadge });
    const unsub = wsClient.subscribe((ev: ServerEvent) => {
      if (ev.type !== 'fs.changed' || ev.filePath !== path || ev.projectId !== projectId) return;
      reloader.hit();
    });
    return () => {
      unsub();
      reloader.dispose();
    };
  }, [path, projectId]);

  // 导出：下拉锚点、纸张版开关（仅 PDF）、进行中的格式、失败提示。导出物落源文档旁，完成后访达选中。
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const [exportAnchor, setExportAnchor] = useState<DOMRect | null>(null);
  const [paperMode, setPaperMode] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportWarn, setExportWarn] = useState<string | null>(null); // 成功但有缺图等非阻断提示

  const runExport = useCallback(
    async (format: ExportFormat) => {
      if (!projectId) return;
      setExportAnchor(null); // 关菜单
      setExportError(null);
      setExportWarn(null);
      setExporting(format);
      try {
        const r = await exportDoc({ projectId, path, content, format, paperMode });
        // 成功在访达选中文件（主进程做）；取消静默；只有真失败才提示说人话的原因。
        if (!r.ok && !r.cancelled) setExportError(r.message ?? t('exportFailed'));
        // 成功但有本地图片缺失：非阻断提示，让用户知道导出物有图损坏（PRD §护栏）。
        else if (r.ok && r.missing && r.missing.length > 0) {
          setExportWarn(t('exportMissing', { count: r.missing.length }));
        }
      } catch (e) {
        setExportError(e instanceof Error ? e.message : t('exportFailed'));
      } finally {
        setExporting(null);
      }
    },
    [projectId, path, content, paperMode, t],
  );

  const cancelExport = useCallback(() => {
    if (projectId) void cancelDocExport(projectId, path);
  }, [projectId, path]);

  // 粘贴/拖入图片：落进本文档旁的 assets，回相对引用给编辑器插 ![](ref)
  const uploadImage = useCallback(
    (file: File): Promise<string | null> =>
      projectId ? uploadDocImage(projectId, path, file) : Promise.resolve(null),
    [projectId, path],
  );

  // 裁剪请求：CM widget 工具条点「裁剪」→ 经 facet 通道（绑本 view 实例）开对话框
  const [cropReq, setCropReq] = useState<CropRequest | null>(null);
  // 裁剪上传异步；用户上传途中取消会清 cropReq，但 onConfirm 闭包仍持旧快照。
  // 用 ref 跟踪当前活跃请求，落盘回来后比对——已取消/已换则不回填。
  const cropReqRef = useRef<CropRequest | null>(cropReq);
  cropReqRef.current = cropReq;
  // 改名/切走该文档 → 关掉裁剪对话框，杜绝裁剪结果落到已不是当前的文档（孤立图）。
  useEffect(() => {
    setCropReq(null);
  }, [path]);

  // 文档身份（项目 + 项目相对 path）：随 livePreview 编进本地图 URL，主进程据此定位 assets（去全局 activeDoc，§4.1）。
  // 多标签 keep-mounted 各自带身份，非活跃标签的图片请求也按自己文档解析、不串 docDir。
  const docIdentity = useMemo(
    () => (projectId ? { projectId, docPath: path } : null),
    [projectId, path],
  );

  // ⌘S：实时落盘下没有「保存」动作，⌘S 还原成「立刻留个底」（manual 快照）。仅活跃标签绑全局键。
  useEffect(() => {
    if (!isActive) return;
    function onKeyDown(e: KeyboardEvent): void {
      const isSave = (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S');
      if (isSave) {
        e.preventDefault();
        void manualSnapshot(path);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, path, manualSnapshot]);

  // 失焦/隐藏立即落盘；切回/可见时刷新（本地无改动则拉磁盘最新）。仅活跃标签绑。
  // IME 组合期间「不落盘半成品、不被外部写打断候选词」由 store 统一兜（scheduleAutosave / syncFromDiskInner
  // 读 view.composing 推迟）——覆盖所有同步来源（含 fs.changed 命中广播，本组件原先只挡得住 focus/visibility）；
  // 这里只在 compositionend 通知 store 把攒下的 pending 排盘 + 补跑被推迟的同步。
  useEffect(() => {
    if (!isActive) return;
    const onFocus = (): void => void syncFromDisk(path);
    const onBlur = (): void => void flush(path);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void syncFromDisk(path);
      else void flush(path);
    };
    const onCompositionEnd = (): void => noteCompositionEnd(path);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('compositionend', onCompositionEnd);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('compositionend', onCompositionEnd);
    };
  }, [isActive, path, syncFromDisk, flush, noteCompositionEnd]);

  return (
    // data-aside-region：随手评点的场所锚点（契约清单见 shared/asideRegions.ts）
    <div data-aside-region="editor" className="flex h-full flex-col">
      {/* 双行壳工具条行（A1）：路径面包屑归 ViewerToolbar，右侧 = 历史（图标）| 导出（文字，核心动作置最右） */}
      <ViewerToolbar path={path}>
        {exportError ? (
          <span
            className="mr-1 max-w-[260px] truncate text-xs text-danger"
            title={exportError}
            onClick={() => setExportError(null)}
          >
            {t('exportFailedWith', { error: exportError })}
          </span>
        ) : exportWarn ? (
          <span
            className="mr-1 max-w-[260px] truncate text-xs text-warn"
            title={exportWarn}
            onClick={() => setExportWarn(null)}
          >
            {exportWarn}
          </span>
        ) : null}
        <ToolbarIconButton onClick={() => setHistoryOpen(true)} title={t('historyTitle')}>
          <History className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </ToolbarIconButton>
        <ToolbarDivider />
        {exporting ? (
          // 导出进行中：转圈 + 可取消（PDF 长文离屏渲染耗时；HTML 快但统一给取消）
          <ToolbarTextButton onClick={cancelExport} title={t('cancelExport')}>
            <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.5} />
            <X className="h-3 w-3" strokeWidth={1.5} />
          </ToolbarTextButton>
        ) : (
          <ToolbarTextButton
            ref={exportBtnRef}
            onClick={() =>
              setExportAnchor(exportAnchor ? null : exportBtnRef.current?.getBoundingClientRect() ?? null)
            }
            title={t('export')}
          >
            <Download className="h-[13px] w-[13px]" strokeWidth={1.5} />
            <span>{t('export')}</span>
            <ChevronDown className="h-2.5 w-2.5 text-text-quaternary" strokeWidth={1.6} />
          </ToolbarTextButton>
        )}
      </ViewerToolbar>

      {exportAnchor ? (
        <ExportMenu
          anchor={exportAnchor}
          paperMode={paperMode}
          onPaperModeChange={setPaperMode}
          onPick={(format) => void runExport(format)}
          onClose={() => setExportAnchor(null)}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-text-tertiary">{t('common:loading')}</div>
        ) : (
          <MdEditor
            value={content}
            onChange={(v) => setContent(path, v)}
            onSave={() => void manualSnapshot(path)}
            uploadImage={uploadImage}
            onCropRequest={setCropReq}
            docIdentity={docIdentity}
            onAddToChat={
              composerConvKey
                ? (sel) =>
                    addComposerRef(composerConvKey, {
                      id: newChatRefId(),
                      quote: sel.quote,
                      sourcePath: path,
                      line: sel.line,
                    })
                : undefined
            }
          />
        )}
      </div>

      {/* 底部 28px 状态条（A2）：第 4 层徽记唯一容身处——左同步角标/实时保存文案、右字数·编码 */}
      <div className="flex h-7 shrink-0 items-center gap-2.5 border-t border-border bg-sunken-2 px-3.5 text-xs">
        {syncBadge ? (
          <span className="inline-flex items-center gap-1.5 text-accent-deep">
            <span className="oru-pulse h-1.5 w-1.5 rounded-full bg-accent" />
            {syncBadge === 'syncing' ? t('common:sync.syncing') : t('common:sync.updated')}
          </span>
        ) : (
          <span className="text-text-quaternary">{t('statusBar.realtimeSave')}</span>
        )}
        <span className="ml-auto text-text-quaternary tabular-nums">{t('statusBar.count', { count: content.length })}</span>
      </div>

      <FileHistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docRef={fileState?.ref ?? null}
        currentContent={content}
        onRestore={(snapshotId) => restoreFromHistory(path, snapshotId)}
        languageExtensions={mdHistoryExtensions}
      />

      {cropReq ? (
        <RectCropDialog
          url={cropReq.url}
          onCancel={() => setCropReq(null)}
          onConfirm={async (blob) => {
            // 裁剪输出 → 落进 assets（序号去重）成功后才把引用改指向裁剪图（纯 ![]() 可移植，§六）
            const ref = await uploadImage(new File([blob], '裁剪.png', { type: 'image/png' }));
            if (ref && cropReqRef.current === cropReq) cropReq.apply(ref); // 取消/换请求则不回填
            setCropReq(null);
          }}
        />
      ) : null}
    </div>
  );
}
