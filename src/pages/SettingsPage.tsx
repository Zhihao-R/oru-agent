/**
 * Settings 完整页（v0.6）——替代 SettingsDialog 弹窗。
 *
 * 三栏 grid（沿用任务板 TaskboardMainView 范式）：
 *   ┌──────────┬──────────────────┬─────────────────┐
 *   │ Sidebar  │ Section          │ Detail (按需)    │
 *   │ 200px    │ flex 1           │ 408px           │
 *   └──────────┴──────────────────┴─────────────────┘
 *
 * 左导航七项：通用 / 权限与行为 / 模型 / 用量 / 能力 / 平台连接 / 数据。
 * 详情面板（408px）都挂在「能力」页，出现条件：
 *   - 选中某条 MCP server → McpDetailPanel（有 dirty 编辑态）
 *   - 选中某条 skill → SkillDetailPanel（无 dirty）
 * 同一栏只容一个：选中 skill 与选中 MCP 互斥。
 *
 * 关闭路径：
 *   - McpDetailPanel 有 dirty 编辑态 → 走 ref.requestClose()，panel 自己判 dirty 决定
 *     是直接 onClose 还是弹丢弃 dialog（异步）。"切到别的 server / 切 tab / 切去开 skill"也走这条路径，
 *     用 pendingTab/pendingMcpId/pendingSkillId 排队，panel 真关后 useEffect 兑现。
 *   - SkillDetailPanel 无 dirty 直接 onClose；切 row / 切 tab / 切去开 MCP 都同步——不需要 ref、不需要 pending。
 *
 * pendingTab/pendingSkillId 仍要保留：当 MCP panel 有 dirty 时用户切走，得等用户确认丢弃后再兑现。
 */
import { useEffect, useRef, useState } from 'react';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { GeneralSection } from '@/components/settings/GeneralSection';
import { PermissionsSection } from '@/components/settings/PermissionsSection';
import { ModelsSection } from '@/components/settings/ModelsSection';
import { UsageSection } from '@/components/settings/UsageSection';
import { CapabilitiesSection } from '@/components/settings/CapabilitiesSection';
import { PlatformsSection } from '@/components/settings/PlatformsSection';
import { DataSection } from '@/components/settings/DataSection';
import { McpDetailPanel, type McpDetailPanelHandle } from '@/components/settings/extensions/McpDetailPanel';
import { SkillDetailPanel } from '@/components/settings/extensions/SkillDetailPanel';

export type SettingsTab = 'general' | 'permissions' | 'models' | 'usage' | 'capabilities' | 'platforms' | 'data';

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  /** MCP panel 走 requestClose 排队（可能 async dialog）；skill panel 无 dirty，只在被 MCP 挡关时排队开 */
  const [pendingTab, setPendingTab] = useState<SettingsTab | null>(null);
  const [pendingMcpId, setPendingMcpId] = useState<string | null>(null);
  const [pendingSkillId, setPendingSkillId] = useState<string | null>(null);

  const mcpPanelRef = useRef<McpDetailPanelHandle | null>(null);

  const hasOpenPanel = selectedMcpId !== null || selectedSkillId !== null;

  /** 请求关闭当前打开的 panel——MCP 走 ref（可能 async dialog），Skill 直接同步关 */
  const requestCloseOpen = () => {
    if (selectedMcpId !== null) mcpPanelRef.current?.requestClose();
    else if (selectedSkillId !== null) setSelectedSkillId(null);
  };

  // Esc 触发请求关闭（panel 内部判 dirty 决定真关还是弹 Dialog）
  useEffect(() => {
    if (!hasOpenPanel) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        (target?.isContentEditable ?? false);
      if (e.key === 'Escape' && !inField) {
        e.preventDefault();
        requestCloseOpen();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hasOpenPanel, selectedMcpId, selectedSkillId]);

  // panel 真关后兑现 pending。注意闭包问题：requestClose 同步触发 onClose 时，
  // onClose 里读不到刚 set 的 pending（同事件循环内 setState enqueue 后不可同步读）。
  // 改用 effect 监听 selectedX 变 null 后兑现，sync/async 关闭路径都接得上。
  useEffect(() => {
    if (selectedMcpId !== null || selectedSkillId !== null) return;
    if (pendingTab !== null) {
      setTab(pendingTab);
      setPendingTab(null);
      if (pendingMcpId !== null) setPendingMcpId(null);
      if (pendingSkillId !== null) setPendingSkillId(null);
      return;
    }
    if (pendingMcpId !== null) {
      setSelectedMcpId(pendingMcpId);
      setPendingMcpId(null);
      return;
    }
    if (pendingSkillId !== null) {
      setSelectedSkillId(pendingSkillId);
      setPendingSkillId(null);
    }
  }, [selectedMcpId, selectedSkillId, pendingTab, pendingMcpId, pendingSkillId]);

  const onChangeTab = (next: SettingsTab) => {
    if (next === tab) return;
    if (hasOpenPanel) {
      setPendingTab(next);
      requestCloseOpen();
      return;
    }
    setTab(next);
  };

  const onSelectMcp = (id: string | null) => {
    if (id === selectedMcpId) return;
    // 选中 MCP 与选中 skill 互斥；skill 无 dirty，同步清掉即可
    if (id !== null && selectedSkillId !== null) setSelectedSkillId(null);
    if (selectedMcpId !== null && id !== null) {
      setPendingMcpId(id);
      mcpPanelRef.current?.requestClose();
      return;
    }
    if (id === null && selectedMcpId !== null) {
      mcpPanelRef.current?.requestClose();
      return;
    }
    setSelectedMcpId(id);
  };

  /** Skill 无 dirty 态——直接换 id；若当前开着（可能 dirty 的）MCP panel，走 pending 排队等它关 */
  const onSelectSkill = (id: string | null) => {
    if (id !== null && selectedMcpId !== null) {
      setPendingSkillId(id);
      mcpPanelRef.current?.requestClose();
      return;
    }
    setSelectedSkillId(id);
  };

  const showMcpDetail = tab === 'capabilities' && selectedMcpId !== null;
  const showSkillDetail = tab === 'capabilities' && selectedSkillId !== null;
  const showDetail = showMcpDetail || showSkillDetail;

  return (
    <div
      data-aside-region="settings"
      className="grid h-full min-h-0 w-full overflow-hidden bg-canvas"
      style={{
        gridTemplateColumns: showDetail ? '200px 1fr 408px' : '200px 1fr',
      }}
    >
      <SettingsNav current={tab} onChange={onChangeTab} />
      <main className="flex min-w-0 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {tab === 'general' ? <GeneralSection /> : null}
          {tab === 'permissions' ? <PermissionsSection /> : null}
          {tab === 'models' ? <ModelsSection /> : null}
          {tab === 'usage' ? <UsageSection /> : null}
          {tab === 'platforms' ? <PlatformsSection /> : null}
          {tab === 'data' ? <DataSection /> : null}
          {tab === 'capabilities' ? (
            <CapabilitiesSection
              selectedSkillId={selectedSkillId}
              onSelectSkill={onSelectSkill}
              selectedMcpId={selectedMcpId}
              onSelectMcp={onSelectMcp}
            />
          ) : null}
        </div>
      </main>
      {showMcpDetail && selectedMcpId ? (
        <McpDetailPanel
          key={selectedMcpId}
          ref={mcpPanelRef}
          serverId={selectedMcpId}
          onClose={() => setSelectedMcpId(null)}
        />
      ) : null}
      {showSkillDetail && selectedSkillId ? (
        <SkillDetailPanel
          key={selectedSkillId}
          skillId={selectedSkillId}
          onClose={() => setSelectedSkillId(null)}
        />
      ) : null}
    </div>
  );
}
