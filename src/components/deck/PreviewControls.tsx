import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronLeft, ChevronDown, Download, Expand, History, Loader2, Maximize2 } from 'lucide-react';
import type { ArtifactRecord } from '@shared/types';
import type { ExportFormat, ExportScale } from '@shared/protocol';
import { useArtifactStore } from '@/stores/artifactStore';
import { useProjectStore } from '@/stores/projectStore';
import { useWorkspaceStore, makeTab } from '@/stores/workspaceStore';
import { DeckHistoryDialog } from '@/components/deck/DeckHistoryDialog';
import { ToolbarIconButton, ToolbarTextButton, ToolbarDivider, ToolbarSegmented } from '@/components/workspace/ViewerToolbar';

// 稳定 EMPTY 引用：避免 selector fallback `?? []` 每次返回新数组触发无限渲染
const EMPTY_DECKS: ArtifactRecord[] = [];

/**
 * 预览 tab 的工具栏控件：文件路径下拉（切 deck）+ 对比改前/改后 + 沉浸/全屏/关闭。
 *
 * 这些控件全是 store 驱动（不碰 PreviewPane 的 webview ref），所以从 PreviewPane 上提到
 * DeckCenter 的统一工具栏里——预览 tab 渲染本组件，文稿 tab 渲染保存/更新，整条工具栏一行。
 *
 * 以 fragment 形式嵌进 DeckCenter 的 flex 行：文件路径紧跟标签左对齐，其余收进一个
 * `ml-auto` 右侧组（与文稿态的保存/更新组同构）。
 */
type Props = {
  artifactId: string;
  deckPath: string;
};

export function PreviewControls({ artifactId, deckPath }: Props) {
  const { t } = useTranslation('deck');
  const [deckSwitcherOpen, setDeckSwitcherOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const setChromeState = useArtifactStore((s) => s.setChromeState);
  // deck 是右栏标签的一员：切 deck = openTab 另一个 deck 标签（关 deck 的 ✕ 归标签栏 TabBar，§3.2）。
  const openTab = useWorkspaceStore((s) => s.openTab);

  // 对比模式：本 artifact 的对比桶有值时出现「改前/改后」切换
  const compareForThis = useArtifactStore((s) => s.compareStateByArtifactId[artifactId] ?? null);
  const setCompareShowing = useArtifactStore((s) => s.setCompareShowing);

  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectDecks = useArtifactStore((s) =>
    activeProjectId ? s.artifactsByProject[activeProjectId] ?? EMPTY_DECKS : EMPTY_DECKS,
  );
  /** 切到另一个 deck：开（或切到已开的）那个 deck 标签。 */
  function switchToDeck(id: string): void {
    const d = projectDecks.find((x) => x.id === id);
    if (!d) return;
    openTab(makeTab({ kind: 'deck', projectId: d.projectId, ref: d.id, title: d.name }));
  }

  return (
    <>
      {/* deck 切换下拉：点击展开同 project 所有 decks，选一个 activate。紧跟标签左对齐 */}
      {/* data-deck-switcher 标在外层（含触发按钮）：否则下拉打开时点按钮，DeckSwitcher 的
          document mousedown 把按钮当「外部」先 onClose，紧接 click 又 toggle 回开，永远关不掉 */}
      {/* deck 路径面包屑（兼切 deck）：mono + ▾，点开列出同项目 decks（关闭 ✕ 归标签栏，故此处不再有 ×） */}
      <div className="relative ml-1 min-w-0" data-deck-switcher>
        <button
          type="button"
          onClick={() => setDeckSwitcherOpen((v) => !v)}
          title={t('controls.switchDeck')}
          className="inline-flex min-w-0 items-center gap-1.5 font-mono text-sm text-text-secondary transition-colors hover:text-text-primary"
        >
          <span className="min-w-0 truncate">{deckPath.split('/').slice(-2).join('/')}/index.html</span>
          <ChevronDown size={11} strokeWidth={1.6} className="shrink-0 text-text-quaternary" />
        </button>
        {deckSwitcherOpen ? (
          <DeckSwitcher
            decks={projectDecks}
            activeArtifactId={artifactId}
            onPick={(id) => { switchToDeck(id); setDeckSwitcherOpen(false); }}
            onClose={() => setDeckSwitcherOpen(false)}
          />
        ) : null}
      </div>

      <span className="flex-1" />

      {/* 右侧操作组：对比切换 + 沉浸/全屏/历史（图标）| 导出（文字，核心动作置最右） */}
      <div className="flex shrink-0 items-center gap-1">
        {/* 对比态：改前/改后 segmented 切换（与网页查看器共用一套视觉，点了调 setCompareShowing 切 webview src） */}
        {compareForThis ? (
          <ToolbarSegmented
            options={[
              { value: 'before', label: t('common:compare.before') },
              { value: 'after', label: t('common:compare.after') },
            ]}
            value={compareForThis.showing}
            onChange={(side) => setCompareShowing(artifactId, side)}
          />
        ) : null}

        <ToolbarIconButton onClick={() => setChromeState(artifactId, 'immersive')} title={t('controls.immersiveTitle')}>
          <Maximize2 className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </ToolbarIconButton>
        <ToolbarIconButton onClick={() => setChromeState(artifactId, 'fullscreen')} title={t('controls.fullscreenTitle')}>
          <Expand className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </ToolbarIconButton>
        <ToolbarIconButton onClick={() => setHistoryOpen(true)} title={t('controls.historyTitle')}>
          <History className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </ToolbarIconButton>
        <ToolbarDivider />
        <ExportMenu artifactId={artifactId} />
      </div>

      <DeckHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} artifactId={artifactId} />
    </>
  );
}

/** 导出菜单项：四种产物（HTML 展开成单文件/打包两项），各带一行边界说明。label/hint 经 deck ns 翻译。 */
function exportItems(t: TFunction): { format: ExportFormat; label: string; hint: string }[] {
  return [
    { format: 'html-inline', label: t('controls.export.htmlInline.label'), hint: t('controls.export.htmlInline.hint') },
    { format: 'html-zip', label: t('controls.export.htmlZip.label'), hint: t('controls.export.htmlZip.hint') },
    { format: 'pdf', label: t('controls.export.pdf.label'), hint: t('controls.export.pdf.hint') },
    { format: 'pptx', label: t('controls.export.pptx.label'), hint: t('controls.export.pptx.hint') },
  ];
}

/** 图片版导出的清晰度档位：scale = 离屏渲染 deviceScaleFactor，越高越清晰、文件越大 */
function scaleTiers(t: TFunction): { scale: ExportScale; label: string; hint: string }[] {
  return [
    { scale: 1, label: t('controls.scale.standard.label'), hint: t('controls.scale.standard.hint') },
    { scale: 2, label: t('controls.scale.hd.label'), hint: t('controls.scale.hd.hint') },
    { scale: 3, label: t('controls.scale.uhd.label'), hint: t('controls.scale.uhd.hint') },
  ];
}

/** 需要选清晰度的图片版格式 */
function needsScale(format: ExportFormat): format is 'pdf' | 'pptx' {
  return format === 'pdf' || format === 'pptx';
}

/**
 * 导出下拉：四种产物。deck 空壳（slideCount===0）时禁用；导出中转圈+逐页进度、禁重复点；
 * 成功不提示（产物已由主进程在访达高亮，无需再补文字），仅失败时给一行红字。
 * 两步：选格式 → 图片版（PDF/PPT）再选清晰度（HTML 直接导）。
 * 图片版导出的进度/取消由全局弹窗 ExportProgressModal 负责（store 驱动、跨页不丢）；此处按钮只管发起 + 转圈。
 */
function ExportMenu({ artifactId }: { artifactId: string }) {
  const { t } = useTranslation('deck');
  const [open, setOpen] = useState(false);
  // 第二步：已选某图片版格式、正在挑清晰度；null=停在格式列表（第一步）
  const [tierFor, setTierFor] = useState<'pdf' | 'pptx' | null>(null);
  const [pending, setPending] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  const slideCount = useArtifactStore((s) => s.deckMetaByArtifact[artifactId]?.slideCount ?? 0);
  const exportDeck = useArtifactStore((s) => s.exportDeck);
  // 对比态：webview 指向 before/after 临时快照，PDF 会截到快照、磁盘 index.html 也未必是用户在看的那份——
  // 整个导出在对比期禁用，先保存/取消改动再导出。
  const inCompare = useArtifactStore((s) => s.compareStateByArtifactId[artifactId] != null);
  const disabled = slideCount === 0 || inCompare;
  const disabledHint = inCompare ? t('controls.export.disabledCompare') : t('controls.export.disabledEmpty');

  const closeMenu = () => {
    setOpen(false);
    setTierFor(null);
  };

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('[data-export-menu]')) return;
      closeMenu();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // 点格式：HTML 直接导；图片版进第二步选清晰度
  const pickFormat = (format: ExportFormat) => {
    if (needsScale(format)) {
      setTierFor(format);
      return;
    }
    void runExport(format);
  };

  const runExport = async (format: ExportFormat, scale?: ExportScale) => {
    closeMenu();
    setPending(format);
    setError(null);
    try {
      const res = await exportDeck(artifactId, format, scale);
      // 用户主动取消不是失败——静默关闭即可，不报红字。
      if (!res.ok && !res.cancelled) {
        setError(res.message ? t('controls.export.failedWith', { message: res.message }) : t('controls.export.failed'));
      }
    } catch (e) {
      setError(t('controls.export.failedWith', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="relative" data-export-menu>
      <div className="flex items-center gap-1.5">
        {error ? (
          <span className="min-w-0 truncate text-xs text-danger">{error}</span>
        ) : null}
        <ToolbarTextButton
          disabled={disabled || pending !== null}
          onClick={() => (open ? closeMenu() : setOpen(true))}
          title={disabled ? disabledHint : t('controls.export.menuTitle')}
        >
          {pending ? <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.8} /> : <Download className="h-[13px] w-[13px]" strokeWidth={1.6} />}
          <span>{pending ? t('controls.export.exporting') : t('controls.export.export')}</span>
          {!pending ? <ChevronDown className="h-2.5 w-2.5 text-text-quaternary" strokeWidth={1.6} /> : null}
        </ToolbarTextButton>
      </div>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-md border border-border bg-elevated py-1 shadow-pop">
          {tierFor === null ? (
            exportItems(t).map((it) => (
              <button
                key={it.format}
                type="button"
                onClick={() => pickFormat(it.format)}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-hover"
              >
                <span className="text-xs text-text-primary">{it.label}</span>
                <span className="text-xs text-text-tertiary">{it.hint}</span>
              </button>
            ))
          ) : (
            <>
              <button
                type="button"
                onClick={() => setTierFor(null)}
                className="mb-0.5 flex w-full items-center gap-1 px-3 py-1 text-left text-xs text-text-tertiary hover:text-text-secondary"
              >
                <ChevronLeft size={11} strokeWidth={1.6} />
                <span>{t('controls.export.pickScale', { format: tierFor === 'pdf' ? 'PDF' : 'PPT' })}</span>
              </button>
              {scaleTiers(t).map((tier) => (
                <button
                  key={tier.scale}
                  type="button"
                  onClick={() => void runExport(tierFor, tier.scale)}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-hover"
                >
                  <span className="text-xs text-text-primary">{tier.label}</span>
                  <span className="text-xs text-text-tertiary">{tier.hint}</span>
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Deck 列表下拉——点 toolbar 标题展开，选项点击 activate */
function DeckSwitcher({
  decks,
  activeArtifactId,
  onPick,
  onClose,
}: {
  decks: ArtifactRecord[];
  activeArtifactId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('deck');
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      // 点击 popover 外区域关闭——拦在 body 上
      const el = e.target as HTMLElement | null;
      if (el?.closest('[data-deck-switcher]')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);
  return (
    <div
      data-deck-switcher
      className="absolute left-0 top-full z-50 mt-1 max-h-72 w-80 overflow-y-auto rounded-md border border-border bg-elevated py-1 shadow-pop"
    >
      {decks.length === 0 ? (
        <div className="px-3 py-2 text-xs text-text-tertiary">{t('controls.noDeck')}</div>
      ) : (
        decks.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onPick(d.id)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-hover ${
              d.id === activeArtifactId ? 'bg-hover text-text-primary' : 'text-text-secondary'
            }`}
          >
            <span className="truncate">{d.name}</span>
            {d.id === activeArtifactId ? <span className="ml-auto text-text-tertiary">●</span> : null}
          </button>
        ))
      )}
    </div>
  );
}
