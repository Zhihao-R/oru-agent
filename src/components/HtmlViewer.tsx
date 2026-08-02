import { Columns2, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileWebview, type ReloadableWebview } from '@/components/FileWebview';
import { ViewerToolbar, ToolbarIconButton, ToolbarTextButton, ToolbarDivider, ToolbarSegmented } from '@/components/workspace/ViewerToolbar';
import { useHtmlInlineEdit } from '@/components/useHtmlInlineEdit';
import { useHtmlAnnotations, type HtmlAnnotWebview } from '@/components/useHtmlAnnotations';
import { useHtmlAnnotStore } from '@/stores/htmlAnnotStore';
import { useProjectStore } from '@/stores/projectStore';
import { parentDir } from '@/lib/paths';
import { wsClient } from '@/lib/ws';
import type { ServerEvent } from '@shared/protocol';
import { createPreviewReloader, type PreviewBadge } from '@/lib/previewReload';

/**
 * 单个 .html 文件的浏览器——右栏标签工作区里的一个 html 标签（path 即标签身份，项目相对）。
 *
 * 一份单 html 网页：一个 FileWebview，铺满、原生滚动。deckPreview.cjs 作为 preload（自适应 plain
 * 模式：无 .slide 时不定尺/不翻页），右键改字走 useHtmlInlineEdit、框选标注走 useHtmlAnnotations。
 * 文件名与关闭 ✕ 归标签栏（TabBar），本面板只剩刷新按钮 + 改前/改后切换条。
 *
 * 身份口径（§3.6 §B）：store 按 ref（项目相对 path）分桶；WS / webview src 用绝对路径（projectId+ref 派生）。
 *
 * 改前/改后对比（项目B 第三期 Task15）：compareState 非空时 webview src 指向 sidecar 临时快照
 * （`.{base}.compare-{before,after}.html`，落 html 同目录解析相对资源），顶部出改前/改后切换条。
 */
// html 标签无窗口级监听（只有 webview 自身的 ipc-message，随 keep-mounted 自理），故不需 isActive 门控。
export function HtmlViewer({ path, projectId }: { path: string; projectId: string }): JSX.Element {
  // 跨 ns 取词：对比/同步是跨 viewer 的预览原语（与 deck 共用 previewReload 模块）→ 已提升到 common:compare/sync；
  // 刷新 → common；载入占位是工作区壳级「载入中…」变体 → 复用 app:loading（见 glossary 同义异形）。
  const { t } = useTranslation(['common', 'app']);
  const projectRoot = useProjectStore((s) => s.projects.find((p) => p.id === projectId)?.path ?? null);
  const absPath = projectRoot ? `${projectRoot}/${path}` : null;

  const compareState = useHtmlAnnotStore((s) => s.byRef[path]?.compareState ?? null);
  const setCompareShowing = useHtmlAnnotStore((s) => s.setCompareShowing);
  const exitCompare = useHtmlAnnotStore((s) => s.exitCompare);
  const webviewRef = useRef<ReloadableWebview | null>(null);
  // webview 元素走 state——改字/框选回路的 ipc-message 监听以它为依赖（元素换/卸载时摘旧挂新）。
  const [wv, setWv] = useState<HtmlAnnotWebview | null>(null);
  const attachWebview = useCallback((el: ReloadableWebview | null) => {
    webviewRef.current = el;
    setWv(el as HtmlAnnotWebview | null);
  }, []);
  useHtmlInlineEdit(absPath ?? path, wv);
  useHtmlAnnotations(path, wv);

  // 「看见」（块③/§2.3）：AI 落盘本 html → fs.changed(filePath) 命中 → 0.5s 节流后整体 reload 一次 + 角标。
  // path 即项目相对路径，直接与 filePath 比对。对比态下不刷（src 指向快照，与 deck 同心智，由 compareState 守住）。
  const [syncBadge, setSyncBadge] = useState<PreviewBadge>(null);
  useEffect(() => {
    const reloader = createPreviewReloader({
      reload: () => {
        // TODO（§2.3 滚动位置保持，续作）：reload 前记 scrollTop、reload 后恢复——需 ReloadableWebview
        // 暴露 scrollTop 读写接口（现仅 reload()）；plain html 走 preload oru:scrollTo 一路。本期先做刷新+角标。
        try {
          webviewRef.current?.reload();
        } catch {
          /* webview 未 ready */
        }
      },
      onBadge: setSyncBadge,
    });
    const unsub = wsClient.subscribe((ev: ServerEvent) => {
      if (ev.type !== 'fs.changed' || ev.filePath !== path || ev.projectId !== projectId) return;
      if (compareState) return; // 对比态锁快照，不被实时落盘打断
      reloader.hit();
    });
    return () => {
      unsub();
      reloader.dispose();
    };
  }, [path, projectId, compareState]);

  // 对比态：src 指向 before/after 临时快照（落 html 同目录，相对资源才解析对）。非对比态用原文件绝对路径。
  const src = useMemo(() => {
    if (!absPath) return null;
    if (!compareState) return absPath;
    const dir = parentDir(absPath);
    return `${dir}/${compareState.showing === 'before' ? compareState.beforeFile : compareState.afterFile}`;
  }, [absPath, compareState]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      {/* 实时同步角标（块③/§2.3）：「正在同步…→已更新→消失」，让你确认画面实时、并非卡顿 */}
      {syncBadge ? (
        <div className="pointer-events-none absolute right-3 top-12 z-10 rounded-md border border-border bg-elevated/90 px-2 py-1 text-xs text-text-secondary shadow-sm">
          {syncBadge === 'syncing' ? t('common:sync.syncing') : t('common:sync.updated')}
        </div>
      ) : null}
      {/* 双行壳工具条行（A1）：路径面包屑归 ViewerToolbar；对比态时改前/改后分段并入本行（leading，A3）；
          右侧 = 刷新（图标）| 对比（常驻切换钮，A3）。 */}
      <ViewerToolbar
        path={path}
        leading={
          compareState ? (
            <ToolbarSegmented
              options={[
                { value: 'before', label: t('common:compare.before') },
                { value: 'after', label: t('common:compare.after') },
              ]}
              value={compareState.showing}
              onChange={(side) => setCompareShowing(path, side)}
            />
          ) : undefined
        }
      >
        <ToolbarIconButton
          onClick={() => {
            try {
              webviewRef.current?.reload();
            } catch {
              /* webview 未 ready */
            }
          }}
          title={t('common:refresh')}
          aria-label={t('common:refresh')}
        >
          <RotateCw className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </ToolbarIconButton>
        <ToolbarDivider />
        {/* 常驻「对比」切换钮：对比态高亮、点击退出改前/改后；无改动可比时禁用
            （改前/改后快照来自 Oru 改动的评审提交，非用户凭空发起——架构约束，见 htmlAnnotStore.enterCompare） */}
        <ToolbarTextButton
          onClick={() => {
            if (compareState) void exitCompare(path);
          }}
          disabled={!compareState}
          title={compareState ? undefined : t('common:compare.unavailable')}
          className={compareState ? 'bg-accent-soft text-accent-deep hover:bg-accent-soft hover:text-accent-deep' : undefined}
        >
          <Columns2 className="h-[13px] w-[13px]" strokeWidth={1.5} />
          <span>{t('common:compare.toggle')}</span>
        </ToolbarTextButton>
      </ViewerToolbar>

      {/* 内容顶满（2026-07-28 拍板去掉 B5 留边）：html 自己就是完整页面，不再套白卡 */}
      <div className="flex min-h-0 flex-1 bg-sunken">
        {src ? (
          <div className="flex min-h-0 flex-1 overflow-hidden bg-white">
            <FileWebview
              absPath={src}
              webviewRef={attachWebview}
              preloadPath={window.__ORU__?.htmlPreviewPreloadPath}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-text-tertiary">{t('app:loading')}</div>
        )}
      </div>
    </div>
  );
}
