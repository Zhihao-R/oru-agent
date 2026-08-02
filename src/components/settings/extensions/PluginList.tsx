/**
 * Plugin 列表（Skill 模块 v1）—— 能力页 ▸ Plugin 章节的主体。
 *
 * 每行：展开箭头 + 名字 + version + 描述 + enabled toggle + 卸载按钮。
 * plugin 附带的 skill 收纳在此：点箭头折叠展开，列出它带的 skill（点行开详情）。
 * 这些 skill 的 enabled 恒等于父 plugin、无独立开关，所以归在 plugin 底下、不再单列一组。
 * 没有 plugin 时空态文案。
 *
 * 数据来源：useSkillModuleStore.plugins（main 推 plugins.state broadcast 同步）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, ArrowUpCircle, ChevronRight } from 'lucide-react';
import type { SkillRecord } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { toastError } from '@/lib/toast';
import { useSkillModuleStore } from '@/stores/skillModuleStore';
import { cn } from '@/lib/cn';
import { useOruName } from '@/lib/oruName';

export function PluginList({
  selectedSkillId,
  onSelectSkill,
}: {
  selectedSkillId: string | null;
  onSelectSkill: (id: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const oruName = useOruName();
  const plugins = useSkillModuleStore((s) => s.plugins);
  const updates = useSkillModuleStore((s) => s.updates);
  const setUpdates = useSkillModuleStore((s) => s.setUpdates);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 拓展页进入时静默检查 plugin 升级（git ls-remote，几百 ms）
  useEffect(() => {
    if (plugins.length === 0) return;
    void wsClient
      .request({ type: 'plugin.checkUpdates' })
      .then((res) => {
        if (res.type === 'plugin.checkUpdates.result') setUpdates(res.updates);
      })
      .catch((e) => console.warn('[plugin.checkUpdates] failed', e));
  }, [plugins.length, setUpdates]);

  const onUpgrade = async (pluginId: string) => {
    if (busyPluginId) return;
    setBusyPluginId(pluginId);
    try {
      const res = await wsClient.request({ type: 'plugin.update', pluginId });
      if (res.type === 'plugin.action.result' && !res.ok) {
        console.warn(`[plugin.update] 失败: ${res.message}`);
        toastError(t('toast.pluginUpdateFailed'));
      }
    } finally {
      setBusyPluginId(null);
    }
  };

  const onToggle = async (pluginId: string, enabled: boolean) => {
    try {
      const res = await wsClient.request({ type: 'plugin.setEnabled', pluginId, enabled });
      // handler 本地 catch 后失败以 ok=false 回来（不再 reject），这里不检查就成静默失败
      if (res.type === 'plugin.setEnabled.result' && !res.ok) {
        console.warn('[plugin] setEnabled 失败', res.message);
        toastError(t('toast.pluginToggleFailed'));
      }
    } catch (e) {
      console.warn('[plugin] setEnabled 失败', e);
      toastError(t('toast.pluginToggleFailed'));
    }
  };

  const onUninstall = async (pluginId: string) => {
    if (busyPluginId) return;
    setBusyPluginId(pluginId);
    try {
      const res = await wsClient.request({ type: 'plugin.uninstall', pluginId });
      if (res.type === 'plugin.action.result' && !res.ok) {
        console.warn(`[plugin] uninstall 失败: ${res.message}`);
        toastError(t('toast.pluginUninstallFailed'));
      }
    } finally {
      setBusyPluginId(null);
    }
  };

  if (plugins.length === 0) {
    return (
      <div className="py-3 text-sm text-text-tertiary">
        {t('extensions.pluginEmpty')}
        <span className="ml-2 text-text-quaternary">{t('extensions.pluginEmptyHint', { name: oruName })}</span>
      </div>
    );
  }

  return (
    <ul className="-mx-2">
      {plugins.map((p) => {
        const upd = updates[p.id];
        const hasUpdate =
          !!upd && !upd.errorMessage && upd.latestCommit && upd.latestCommit !== upd.currentCommit;
        const isExpanded = expanded.has(p.id);
        const hasSkills = p.skills.length > 0;
        return (
        <li key={p.id} className="border-b border-border py-3 pl-1 pr-2">
          <div className="flex items-start gap-3">
            {/* 展开箭头：有附带 skill 才可点，否则留占位保持对齐 */}
            {hasSkills ? (
              <button
                type="button"
                onClick={() => toggleExpanded(p.id)}
                aria-label={t('extensions.pluginToggleSkills')}
                aria-expanded={isExpanded}
                className="mt-[3px] rounded p-0.5 text-text-tertiary hover:bg-hover hover:text-text-secondary"
              >
                <ChevronRight
                  size={13}
                  strokeWidth={1.5}
                  className={cn('transition-transform', isExpanded && 'rotate-90')}
                />
              </button>
            ) : (
              <span className="mt-[3px] inline-block h-[18px] w-[18px] flex-shrink-0" />
            )}
            <span
              className={cn(
                'mt-[7px] inline-block h-[6px] w-[6px] flex-shrink-0 rounded-full',
                p.enabled ? 'bg-success' : 'bg-text-quaternary/50',
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="block text-sm font-semibold leading-[1.45] tracking-tight text-text-primary">
                  {p.manifest.name}
                </span>
                {p.manifest.version ? (
                  <span className="text-[11px] text-text-tertiary">v{p.manifest.version}</span>
                ) : p.oruExtension.source.commit ? (
                  <span className="text-[11px] text-text-tertiary">
                    {p.oruExtension.source.commit.slice(0, 7)}
                  </span>
                ) : null}
                <span className="text-[11px] text-text-quaternary">
                  · {p.skills.length} skill / {p.mcpServers.length} MCP
                </span>
                {hasUpdate ? (
                  <span className="rounded bg-accent-soft px-1.5 py-[1px] text-[10px] text-accent">
                    {t('extensions.pluginHasUpdate', { commit: upd.latestCommit.slice(0, 7) })}
                  </span>
                ) : null}
              </div>
              <p className="mt-[3px] truncate text-[12.5px] leading-[1.55] text-text-secondary">
                {p.manifest.description}
              </p>
              {p.oruExtension.source.url ? (
                <p className="mt-[2px] truncate font-mono text-[10.5px] text-text-quaternary">
                  {p.oruExtension.source.url}
                </p>
              ) : null}
              {p.ignoredSections.length > 0 ? (
                <p className="mt-[2px] text-[10.5px] italic text-text-quaternary">
                  {t('extensions.pluginIgnored', { sections: p.ignoredSections.join(' / ') })}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void onToggle(p.id, !p.enabled)}
              className={cn(
                'flex h-5 w-9 items-center rounded-full transition-colors',
                p.enabled ? 'bg-accent' : 'bg-text-quaternary/30',
              )}
              aria-label={p.enabled ? t('extensions.pluginToggleOff') : t('extensions.pluginToggleOn')}
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 rounded-full bg-canvas shadow transition-transform',
                  p.enabled ? 'translate-x-4' : 'translate-x-[2px]',
                )}
              />
            </button>
            {hasUpdate ? (
              <button
                type="button"
                onClick={() => void onUpgrade(p.id)}
                disabled={busyPluginId === p.id}
                title={t('extensions.pluginUpgradeTitle')}
                className="rounded p-1 text-accent hover:bg-hover disabled:opacity-50"
              >
                <ArrowUpCircle size={12} strokeWidth={1.5} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void onUninstall(p.id)}
              disabled={busyPluginId === p.id}
              title={t('extensions.pluginUninstallTitle')}
              className="rounded p-1 text-text-tertiary hover:bg-hover hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={12} strokeWidth={1.5} />
            </button>
          </div>
          {isExpanded && hasSkills ? (
            <ul className="mt-2 space-y-px pl-[30px]">
              {p.skills.map((s) => (
                <li key={s.id}>
                  <PluginSkillRow
                    skill={s}
                    isSelected={selectedSkillId === s.id}
                    onSelect={() => onSelectSkill(s.id === selectedSkillId ? null : s.id)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </li>
        );
      })}
    </ul>
  );
}

/**
 * plugin 折叠展开后的单条 skill——点行开详情（与 Skill 区行同款交互）。
 * 无独立开关：plugin 内 skill 的 enabled 恒等于父 plugin，此处只读展示状态色点。
 */
function PluginSkillRow({
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
        'flex w-full cursor-pointer items-start gap-2.5 rounded py-2 pl-1.5 pr-2 text-left transition-colors',
        isSelected ? 'border-l-2 border-l-accent bg-hover' : 'border-l-2 border-l-transparent hover:bg-hover',
      )}
    >
      <span
        title={skill.enabled ? t('status.enabled') : t('status.disabled')}
        className={cn(
          'mt-[6px] inline-block h-[5px] w-[5px] flex-shrink-0 rounded-full',
          skill.enabled ? 'bg-success' : 'bg-text-quaternary/50',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[13px] font-medium leading-[1.45]', dim ? 'text-text-tertiary' : 'text-text-primary')}>
          {skill.name}
        </span>
        <span className={cn('mt-[2px] block truncate text-[11.5px] leading-[1.5]', dim ? 'text-text-quaternary' : 'text-text-secondary')}>
          {skill.description}
        </span>
      </span>
    </button>
  );
}
