/**
 * Settings ▸ 能力
 *
 * 合并旧「Skill」页与「拓展」页——同属「给 Oru 加装能力」。四个分组顺序堆叠、不做页内子导航：
 *   Skill（按来源三组）/ Plugin / MCP 服务 / 上网搜索。
 * Plugin 与 Skill 相邻——Plugin 附带 skill，两区互相引用。
 *
 * 详情面板（第三栏）由父级 SettingsPage 托管：选中某条 skill → SkillDetailPanel，某条 MCP → McpDetailPanel。
 * skill 与 mcp 选中互斥（同一栏只能开一个），互斥切换在 SettingsPage 里处理。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import type { SkillRecord } from '@shared/types';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSkillModuleStore } from '@/stores/skillModuleStore';
import { useMcpRuntimeStore } from '@/stores/mcpRuntimeStore';
import { wsClient } from '@/lib/ws';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/cn';
import { useOruName } from '@/lib/oruName';
import { McpList } from '@/components/settings/extensions/McpList';
import { PluginList } from '@/components/settings/extensions/PluginList';
import { PluginInstallButton } from '@/components/settings/extensions/PluginInstallButton';
import { SkillToggle } from '@/components/settings/extensions/SkillToggle';
import { WebSearchSettingsSection } from '@/components/WebSearchSettingsSection';
import { SettingsSection } from '@/components/settings/ui/SettingsSection';
import { Button } from '@/components/ui/Button';

export function CapabilitiesSection({
  selectedSkillId,
  onSelectSkill,
  selectedMcpId,
  onSelectMcp,
}: {
  selectedSkillId: string | null;
  onSelectSkill: (id: string | null) => void;
  selectedMcpId: string | null;
  onSelectMcp: (id: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="mx-auto max-w-[640px] px-12 py-12">
      <h1 className="mb-9 font-serif text-[30px] font-semibold leading-[1.15] tracking-tight">
        {t('capabilities.heading')}
      </h1>

      <SkillGroups selectedSkillId={selectedSkillId} onSelectSkill={onSelectSkill} />
      <PluginBlock selectedSkillId={selectedSkillId} onSelectSkill={onSelectSkill} />
      <McpBlock selectedMcpId={selectedMcpId} onSelectMcp={onSelectMcp} />

      <SettingsSection title={t('extensions.webSearch')}>
        <WebSearchSettingsSection />
      </SettingsSection>
    </div>
  );
}

// ─── Skill（按来源三组：内置 / 独立装 / Plugin 内）───────────

export function SkillGroups({
  selectedSkillId,
  onSelectSkill,
}: {
  selectedSkillId: string | null;
  onSelectSkill: (id: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const oruName = useOruName();
  const skills = useSkillModuleStore((s) => s.skills);
  const grouped = useMemo(() => groupBySource(skills), [skills]);

  // Plugin 内的 skill 已收进 Plugin 区（各 plugin 折叠展开）——此处只管内置 / 独立装。
  const standaloneCount = grouped.builtin.length + grouped.standalone.length;
  if (standaloneCount === 0) {
    return (
      <div className="mb-4 flex flex-col items-center gap-2 py-8 text-center">
        <div className="text-sm text-text-secondary">{t('skills.empty')}</div>
        <p className="text-xs text-text-tertiary">{t('skills.emptyHint', { name: oruName })}</p>
      </div>
    );
  }

  return (
    <>
      <SkillGroup title={t('extensions.skillSource.builtin')} skills={grouped.builtin} selectedId={selectedSkillId} onSelect={onSelectSkill} />
      <SkillGroup title={t('extensions.skillSource.standalone')} skills={grouped.standalone} selectedId={selectedSkillId} onSelect={onSelectSkill} />
    </>
  );
}

function SkillGroup({
  title,
  skills,
  selectedId,
  onSelect,
}: {
  title: string;
  skills: SkillRecord[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <SettingsSection title={`${title} · ${skills.length}`}>
      <ul className="-mx-2">
        {skills.map((s) => (
          <li key={s.id}>
            <SkillRow
              skill={s}
              isSelected={selectedId === s.id}
              onSelect={() => onSelect(s.id === selectedId ? null : s.id)}
            />
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

function SkillRow({
  skill,
  isSelected,
  onSelect,
}: {
  skill: SkillRecord;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('settings');
  const dim = !skill.enabled;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        '-ml-0.5 flex w-full cursor-pointer items-start gap-3 border-b border-border py-3 pl-1 pr-2 text-left transition-colors',
        isSelected
          ? 'border-l-2 border-l-accent bg-hover'
          : 'border-l-2 border-l-transparent hover:bg-hover',
      )}
    >
      {/* 色点：启用=绿，未启用=浅灰；跟 MCP 列表同一套语言 */}
      <span
        title={skill.enabled ? t('status.enabled') : t('status.disabled')}
        className={cn(
          'mt-[7px] inline-block h-[6px] w-[6px] flex-shrink-0 cursor-help rounded-full',
          skill.enabled ? 'bg-success' : 'bg-text-quaternary/50',
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-sm font-semibold leading-[1.45] tracking-tight',
            dim ? 'text-text-tertiary' : 'text-text-primary',
          )}
        >
          {skill.name}
        </span>
        <span
          className={cn(
            'mt-[3px] block truncate text-[12.5px] leading-[1.55]',
            dim ? 'text-text-quaternary' : 'text-text-secondary',
          )}
        >
          {skill.description}
        </span>
        {skill.parentPluginId ? (
          <span className="mt-[2px] block font-mono text-[10.5px] text-text-quaternary">
            plugin: {skill.parentPluginId}
          </span>
        ) : null}
      </span>
      <span className="mt-[2px] inline-flex">
        <SkillToggle skillId={skill.id} enabled={skill.enabled} source={skill.source} />
      </span>
    </button>
  );
}

/** 只分 内置 / 独立装——plugin 内的 skill 收进 Plugin 区各自 plugin 底下，不在此列。 */
function groupBySource(skills: SkillRecord[]): {
  builtin: SkillRecord[];
  standalone: SkillRecord[];
} {
  return {
    builtin: skills.filter((s) => s.source === 'builtin'),
    standalone: skills.filter((s) => s.source === 'standalone'),
  };
}

// ─── Plugin ─────────────────────────────────────────────

function PluginBlock({
  selectedSkillId,
  onSelectSkill,
}: {
  selectedSkillId: string | null;
  onSelectSkill: (id: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const pluginsCount = useSkillModuleStore((s) => s.plugins.length);
  return (
    <SettingsSection title={t('extensions.pluginSection', { count: pluginsCount })} trailing={<PluginInstallButton />}>
      <PluginList selectedSkillId={selectedSkillId} onSelectSkill={onSelectSkill} />
    </SettingsSection>
  );
}

// ─── MCP 服务 ───────────────────────────────────────────

function McpBlock({
  selectedMcpId,
  onSelectMcp,
}: {
  selectedMcpId: string | null;
  onSelectMcp: (id: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const serversCount = useSettingsStore((s) => s.settings.mcpServers?.length ?? 0);
  const upsertRuntime = useMcpRuntimeStore((s) => s.upsert);
  const [creating, setCreating] = useState(false);

  const onAddMcp = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await wsClient.request({
        type: 'mcp.create',
        config: { label: t('extensions.mcpDefaultLabel'), command: '', args: [], enabled: false },
      });
      if (res.type === 'mcp.create.result' && res.ok) {
        upsertRuntime({ serverId: res.serverId, status: 'idle' });
        onSelectMcp(res.serverId);
      } else if (res.type === 'mcp.create.result') {
        console.warn('[mcp] create 失败', res.message);
        toastError(t('toast.mcpCreateFailed'));
      }
    } catch (e) {
      console.warn('[mcp] create 异常', e);
      toastError(t('toast.mcpCreateFailed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <SettingsSection
      title={t('extensions.mcpSection', { count: serversCount })}
      trailing={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onAddMcp()}
          disabled={creating}
          leftIcon={<Plus size={12} strokeWidth={1.5} />}
          className="text-text-secondary"
        >
          {creating ? t('extensions.creating') : t('extensions.add')}
        </Button>
      }
    >
      <McpList selectedId={selectedMcpId} onSelect={onSelectMcp} />
    </SettingsSection>
  );
}
