import { useTranslation } from 'react-i18next';
import { FileWebview } from '@/components/FileWebview';
import { EditorPane } from '@/components/editor/EditorPane';
import { CsvEditor } from '@/components/table/CsvEditor';
import { XlsxPreview } from '@/components/table/XlsxPreview';
import { HtmlViewer } from '@/components/HtmlViewer';
import { DeckTabBody } from '@/components/deck/DeckTabBody';
import { PdfViewer } from '@/components/pdf/PdfViewer';
import { TabBar } from '@/components/workspace/TabBar';
import { useWorkspaceStore, type Tab } from '@/stores/workspaceStore';
import { useProjectStore } from '@/stores/projectStore';

/**
 * 右栏标签工作区（tech design §3.2，路线 A keep-mounted）——
 * 标签栏 + 视口。视口里每个打开的标签各渲染一个查看器面板，全部常驻 DOM，
 * 只让活跃标签可见（`display`，真机验证见 §5.3：webview 隐藏往返滚动/尺寸完整保留）。
 *
 * 已接入 md / csv / image / html / deck（各按 ref/artifactId 分桶）。
 * html/deck 的批注栏是独立右列，由 App.tsx 在活跃标签是 html/deck 时渲染（见 App.tsx），不在此 keep-mounted。
 * deck 的预览 webview 在此 keep-mounted（切走 display:none、不卸载，§5.3 真机已验滚动/尺寸保留）。
 */
/** 标签内容按 kind 派发——加查看器 kind 只在此一处加分支（与 workspace/KindIcon 同构）。 */
function TabBody({ tab, active, projectRoot }: { tab: Tab; active: boolean; projectRoot: string | null }): JSX.Element {
  const { t } = useTranslation('app');
  switch (tab.kind) {
    case 'editor':
      return <EditorPane path={tab.ref} isActive={active} />;
    case 'table':
      return <CsvEditor path={tab.ref} isActive={active} />;
    case 'xlsx':
      // xlsx 只读预览（内存转换零落盘）；「转为可编辑」后原地 replaceTab 成 table 标签
      return <XlsxPreview path={tab.ref} projectId={tab.projectId} />;
    case 'html':
      // 标签体只放 webview（keep-mounted）；批注栏由 App.tsx 在活跃 html 标签时渲染到独立右列（非 keep-mounted）。
      return <HtmlViewer path={tab.ref} projectId={tab.projectId} />;
    case 'deck':
      // 标签体放 DeckCenter（工具栏 + 预览 webview + 文稿）；webview 随本 keep-mounted 机制存活。
      // 批注栏由 App.tsx 在活跃 deck 标签时渲染到独立右列（同 html）。tab.ref = artifactId。
      // isActive 透传到 PreviewPane：只有活跃 deck 绑 document 级翻页键 / 全屏同步，避免多 deck 并存时串触发。
      return <DeckTabBody artifactId={tab.ref} isActive={active} />;
    case 'pdf':
      // 自绘 PDF 查看器（keep-mounted）：工具栏 + 连续滚动 + 选字/搜索。tab.ref = 项目相对 path。
      return <PdfViewer path={tab.ref} projectId={tab.projectId} isActive={active} />;
    case 'image':
      // 图片：无工具条的纯居中预览（Chromium 内建图片视图自动居中适配，同既有机制）
      return projectRoot === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-text-tertiary">{t('loading')}</div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <FileWebview absPath={`${projectRoot}/${tab.ref}`} />
        </div>
      );
  }
}

function TabPanel({ tab, active, projectRoot }: { tab: Tab; active: boolean; projectRoot: string | null }): JSX.Element {
  // 路线 A keep-mounted：所有标签常驻 DOM，只切 display（§5.3 真机验证：webview 隐藏往返现场不丢）
  return (
    <div className="absolute inset-0 flex flex-col" style={{ display: active ? 'flex' : 'none' }}>
      <TabBody tab={tab} active={active} projectRoot={projectRoot} />
    </div>
  );
}

/**
 * hideTabBar：deck 沉浸/全屏态隐去标签栏（PRD §五/§8）——deck 标签在 WorkspacePane 里 keep-mounted，
 * 沉浸态时这条文件标签栏也要收掉（与 TopBar/侧栏一起隐），退出恢复。
 */
export function WorkspacePane({ hideTabBar = false }: { hideTabBar?: boolean } = {}): JSX.Element {
  const openTabs = useWorkspaceStore((s) => s.openTabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const projects = useProjectStore((s) => s.projects);
  const rootOf = (projectId: string) => projects.find((p) => p.id === projectId)?.path ?? null;

  return (
    // h-full（不是 flex-1）：非 deck 态的容器是固定宽度 div、非 flex 父，flex-1 不会撑高 → 查看器塌成 0 高。
    // 用 h-full 直接吃满容器高度（容器在 main 的 flex 行里被 stretch 到满高），与旧查看器外壳一致。
    <div className="flex h-full min-h-0 flex-col">
      {hideTabBar ? null : <TabBar />}
      <div className="relative min-h-0 flex-1">
        {openTabs.map((tab) => (
          <TabPanel key={tab.id} tab={tab} active={tab.id === activeTabId} projectRoot={rootOf(tab.projectId)} />
        ))}
      </div>
    </div>
  );
}
