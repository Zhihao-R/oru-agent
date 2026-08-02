import { useArtifactStore, useDeckRecord } from '@/stores/artifactStore';
import { DeckCenter } from '@/components/deck/DeckCenter';

/**
 * 右栏标签工作区里的 deck 标签体（阶段4，§3.2）——把 artifactId 接到 DeckCenter，
 * 子标签（预览 / 文稿）选择按 artifactId 存在 store（每个 deck 标签各记一份）。
 *
 * 这层只做「artifactId → deckRecord + deckTab 桶」的接线；DeckCenter 仍是纯受控组件。
 * 预览 webview 由 DeckCenter/PreviewPane 持有，随 WorkspacePane 的 keep-mounted 机制存活
 *（切走父容器 display:none、不卸载，§5.3）。批注栏是独立右列，由 App.tsx 渲染（同 html）。
 */
type Props = { artifactId: string; isActive: boolean };

export function DeckTabBody({ artifactId, isActive }: Props): JSX.Element {
  const deckRecord = useDeckRecord(artifactId);
  const deckTab = useArtifactStore((s) => s.deckTabByArtifactId[artifactId] ?? 'preview');
  const setDeckTab = useArtifactStore((s) => s.setDeckTab);

  // 列表未到位（启动竞态：标签先于 artifact.list 回包）——留空，到位后自然渲染
  if (!deckRecord) return <div className="min-h-0 flex-1 bg-canvas" />;

  return (
    <DeckCenter
      deckRecord={deckRecord}
      activeTab={deckTab}
      onTabChange={(t) => setDeckTab(artifactId, t)}
      isActive={isActive}
    />
  );
}
