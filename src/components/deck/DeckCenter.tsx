import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { History, Sparkles } from 'lucide-react';
import type { Annotation, ArtifactRecord } from '@shared/types';
import { useArtifactStore, useDeckGenerateState } from '@/stores/artifactStore';
import { useToastStore } from '@/stores/toastStore';
import { useEditorStore } from '@/stores/editorStore';
import { deckTabChrome, type DeckTab } from '@/lib/deckTabChrome';
import { PreviewPane } from '@/components/deck/PreviewPane';
import { PreviewControls } from '@/components/deck/PreviewControls';
import { PreviewEmptyState } from '@/components/deck/PreviewEmptyState';
import { NarrativeTab } from '@/components/deck/NarrativeTab';
import { UpdateAnnotationsDialog } from '@/components/deck/UpdateAnnotationsDialog';
import { FileHistoryDialog } from '@/components/editor/FileHistoryDialog';
import { ToolbarIconButton } from '@/components/workspace/ViewerToolbar';
import { mdHighlight } from '@/components/editor/mdEditorTheme';
import { lezerDialect } from '@/lib/markdownDialect';

// 文稿历史窗口的 md 高亮扩展——模块级常量，避免每渲染重建 MergeView
const mdHistoryExtensions = [markdown({ extensions: lezerDialect }), syntaxHighlighting(mdHighlight)];

/**
 * Deck 工作态中间区：「预览 / 文稿」两标签 + 标签栏右侧主按钮区。
 *
 * - 预览标签：空壳（slideCount===0）→ PreviewEmptyState；否则 PreviewPane。
 * - 文稿标签：NarrativeTab（内嵌 MdEditor 编辑 .narrative.md）+ 标签栏的保存按钮/dirty 点。
 * - 主按钮（deckTabChrome 派生文案）：空壳 → generateDeck；有 slides → 更新（有未处理标注先弹确认）。
 *
 * activeTab 受控（提到 App.tsx）——App 据它决定右侧批注栏是否渲染（文稿标签收起）。
 */
const EMPTY_ANNOTATIONS: Annotation[] = [];

function deckName(record: ArtifactRecord): string {
  const idx = record.path.lastIndexOf('/');
  return idx >= 0 ? record.path.slice(idx + 1) : record.path;
}

type Props = {
  deckRecord: ArtifactRecord;
  activeTab: DeckTab;
  onTabChange: (tab: DeckTab) => void;
  /** 活跃 deck 标签——透给 PreviewPane 决定是否绑 document 级翻页键 / 全屏同步（多 deck 并存防串触发）。 */
  isActive: boolean;
};

export function DeckCenter({ deckRecord, activeTab, onTabChange, isActive }: Props) {
  const { t } = useTranslation('deck');
  const artifactId = deckRecord.id;
  const narrativePath = `${deckName(deckRecord)}/.narrative.md`;
  const chromeState = useArtifactStore((s) => s.chromeStateByArtifactId[artifactId] ?? 'work');
  const slideCount = useArtifactStore((s) => s.deckMetaByArtifact[artifactId]?.slideCount ?? 0);
  const submission = useArtifactStore((s) => s.submissionByArtifact[artifactId] ?? null);
  const annotations = useArtifactStore((s) => s.annotationsByArtifact[artifactId] ?? EMPTY_ANNOTATIONS);
  const generateDeck = useArtifactStore((s) => s.generateDeck);
  const updateFromNarrative = useArtifactStore((s) => s.updateFromNarrative);
  const showToast = useToastStore((s) => s.show);
  // 「从文稿生成」任务状态（生成中/排队中）——点了按钮必须看得见反馈，也天然防重复点击（走查二批该修 4）
  const genState = useDeckGenerateState(artifactId);

  // 文稿标签实时落盘，没有「保存」动作；标签栏放「历史版本」入口（读 editorStore 该文稿的桶——NarrativeTab 已 open 此文件）
  const editorContent = useEditorStore((s) => s.files[narrativePath]?.content ?? '');
  const restoreFromHistory = useEditorStore((s) => s.restoreFromHistory);
  const [historyOpen, setHistoryOpen] = useState(false);

  const pendingCount = useMemo(
    () => annotations.filter((a) => a.status === 'pending').length,
    [annotations],
  );

  const hasActiveSubmission = submission != null;
  const { primaryAction } = deckTabChrome({ slideCount });

  const [confirmOpen, setConfirmOpen] = useState(false);

  function handlePrimary() {
    if (hasActiveSubmission) return; // 有进行中提交：禁用（与按钮 disabled 一致）
    if (slideCount === 0) {
      if (genState) return; // 已在生成/排队：禁用（与按钮 disabled 一致）
      onTabChange('preview'); // 切到预览看生成结果
      void generateDeck(artifactId).then((r) => {
        if (!r.ok) showToast(r.reason); // 失败必可见（无活跃对话 / 后端拒绝）
      });
      return;
    }
    // 更新：有未处理标注先弹确认，否则直接仅按文稿改
    if (pendingCount > 0) {
      setConfirmOpen(true);
    } else {
      onTabChange('preview'); // 切到预览看进度卡 + 改后预览
      void updateFromNarrative(artifactId, false);
    }
  }

  // 沉浸/全屏态：chrome 全收起——不渲染标签栏，强制显示预览（PreviewPane 自带浮动退出按钮）。
  // PreviewPane 跨工作/沉浸态始终是同一实例（不随 chromeState 切换重挂载），避免切换重载 deck。
  const inWorkMode = chromeState === 'work';
  // 预览内容可见：工作态看 activeTab，沉浸/全屏态恒为真（不展示文稿编辑器）
  const previewVisible = !inWorkMode || activeTab === 'preview';

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      {/* 标签栏：预览 / 文稿 + 右侧按钮区——仅工作态渲染 */}
      {inWorkMode ? (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-elevated px-3.5">
          <TabButton active={activeTab === 'preview'} onClick={() => onTabChange('preview')}>
            {t('center.tabPreview')}
          </TabButton>
          <TabButton active={activeTab === 'narrative'} onClick={() => onTabChange('narrative')}>
            {t('center.tabNarrative')}
          </TabButton>

          {/* 工具栏右侧随视图切换：预览态走 PreviewControls（文件路径/沉浸/全屏/关闭，无更新按钮）；
              文稿态才有历史 + 从文稿生成/更新演示设计（核心动作，带文字置最右）。 */}
          {activeTab === 'preview' ? (
            <PreviewControls artifactId={artifactId} deckPath={deckRecord.path} />
          ) : (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {/* 历史版本入口（实时落盘，无保存按钮） */}
              <ToolbarIconButton onClick={() => setHistoryOpen(true)} title={t('center.narrativeHistoryTitle')}>
                <History className="h-[13px] w-[13px]" strokeWidth={1.5} />
              </ToolbarIconButton>

              {/* 主按钮：从文稿生成 / 更新演示设计（accent 实心，核心动作） */}
              <button
                type="button"
                disabled={hasActiveSubmission || (slideCount === 0 && genState !== null)}
                onClick={handlePrimary}
                title={
                  hasActiveSubmission
                    ? t('center.submissionBusy')
                    : genState
                      ? t(genState === 'running' ? 'center.generating' : 'center.generateQueued')
                      : undefined
                }
                className="flex h-7 items-center gap-1.5 rounded bg-accent px-3 text-base font-medium text-accent-fg transition hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles className="h-[13px] w-[13px]" strokeWidth={1.5} />
                {primaryAction === 'generate'
                  ? genState
                    ? t(genState === 'running' ? 'center.generating' : 'center.generateQueued')
                    : t('center.generate')
                  : t('center.update')}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {/* 标签内容：两个标签都常驻挂载（用 hidden 切换），避免切标签时
          PreviewPane 的 webview 重载 / NarrativeTab 反复 open。 */}
      <div className="relative min-h-0 flex-1">
        <div className={`absolute inset-0 ${previewVisible ? '' : 'hidden'}`}>
          {/* PreviewPane 始终挂载——它的 webview preload 是 slideCount 的唯一来源；
              空壳时 PreviewEmptyState 绝对定位盖在其上，生成完成 slideCount>0 后 overlay 自动消失，
              露出（reload 后已铺满的）预览。若改成空壳时不挂 PreviewPane，会陷入
              "要 webview 才有 slideCount、要 slideCount>0 才挂 webview" 的死锁、生成结果永不显示。 */}
          <PreviewPane
            artifactId={artifactId}
            deckPath={deckRecord.path}
            projectId={deckRecord.projectId}
            isActive={isActive}
          />
          {slideCount === 0 ? (
            <div className="absolute inset-0">
              <PreviewEmptyState
                disabled={hasActiveSubmission}
                busy={genState}
                onGenerate={() => {
                  onTabChange('preview');
                  void generateDeck(artifactId).then((r) => {
                    if (!r.ok) showToast(r.reason);
                  });
                }}
              />
            </div>
          ) : null}
        </div>
        {/* 文稿编辑器仅工作态挂载——沉浸/全屏是放映视图，不编辑文稿 */}
        {inWorkMode ? (
          <div className={`absolute inset-0 ${activeTab === 'narrative' ? '' : 'hidden'}`}>
            <NarrativeTab projectId={deckRecord.projectId} narrativePath={narrativePath} />
          </div>
        ) : null}
      </div>

      <FileHistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docRef={deckRecord.projectId && narrativePath ? { kind: 'project', projectId: deckRecord.projectId, path: narrativePath } : null}
        currentContent={editorContent}
        onRestore={(snapshotId) => restoreFromHistory(narrativePath, snapshotId)}
        languageExtensions={mdHistoryExtensions}
      />

      <UpdateAnnotationsDialog
        open={confirmOpen}
        pendingCount={pendingCount}
        onClose={() => setConfirmOpen(false)}
        onNarrativeOnly={() => {
          setConfirmOpen(false);
          onTabChange('preview'); // 切到预览看进度卡 + 改后预览
          void updateFromNarrative(artifactId, false);
        }}
        onWithAnnotations={() => {
          setConfirmOpen(false);
          onTabChange('preview');
          void updateFromNarrative(artifactId, true);
        }}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 shrink-0 rounded-md px-3 text-xs transition ${
        active
          ? 'bg-sunken font-medium text-text-primary'
          : 'text-text-tertiary hover:bg-hover hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  );
}
