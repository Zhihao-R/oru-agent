/**
 * MCP 列表 —— 拓展页 ▸ MCP 服务 章节的主体。
 *
 * 每行展示：色点 + 名字 + 简介（可选）+ toggle。
 * 行点击 → 选中（父级控制详情面板）。
 *
 * 数据来源：
 * - 配置：useSettingsStore.settings.mcpServers
 * - 运行时状态：useMcpRuntimeStore
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { McpServerStatus } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { useOruName } from '@/lib/oruName';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMcpRuntimeStore, type McpRuntime } from '@/stores/mcpRuntimeStore';
import { McpToggle } from './McpToggle';
import { cn } from '@/lib/cn';

function dotColorClass(s: McpServerStatus | undefined, enabled: boolean): string {
  if (!enabled) return 'bg-text-quaternary/50';
  if (s === 'connected_ready' || s === 'connected') return 'bg-success';
  if (s === 'probe_failed') return 'bg-warn';
  if (s === 'failed') return 'bg-danger';
  return 'bg-text-quaternary/50';
}

function isSpawning(s: McpServerStatus | undefined, enabled: boolean): boolean {
  return enabled && (s === 'starting' || s === 'reconnecting');
}

/** tooltip。`rt` 是主进程那份长驻连接的运行时细节（toolCount / lastError），三个后端同源。 */
function statusTooltip(
  s: McpServerStatus | undefined,
  enabled: boolean,
  t: TFunction,
  rt: McpRuntime | undefined,
): string {
  if (!enabled) return t('extensions.mcpStatus.idle');
  const eff = s ?? 'idle';
  const base = t(`extensions.mcpStatus.${eff}`);
  if (eff === 'connected_ready' && rt?.toolCount)
    return t('extensions.mcpStatus.toolCount', { base, count: rt.toolCount });
  if (eff === 'failed' && rt?.lastError)
    return t('extensions.mcpStatus.withError', { base, error: rt.lastError });
  return base;
}

export function McpList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation('settings');
  const servers = useSettingsStore((s) => s.settings.mcpServers ?? []);
  const runtimes = useMcpRuntimeStore((s) => s.byId);
  const loaded = useMcpRuntimeStore((s) => s.loaded);
  const [unmanaged, setUnmanaged] = useState<string[]>([]);
  // 界面提及 AI 主体走个体名插值（无名回落 Oru），不硬编码
  const oruName = useOruName();
  const setAll = useMcpRuntimeStore((s) => s.setAll);

  // 打开面板就拉一次 runtime states（loaded 后不重拉，避免冲掉乐观中间态）
  useEffect(() => {
    void (async () => {
      try {
        const res = await wsClient.request({ type: 'mcp.runtime.list' });
        if (res.type === 'mcp.runtime.list.result') {
          if (!loaded) setAll(res.states);
          setUnmanaged(res.unmanaged ?? []);
        }
      } catch (e) {
        console.warn('[mcp] runtime.list 失败', e);
      }
    })();
    // servers 变化时重拉：用户按提示把缺的服务装进来后，提示要当场消失而不是等设置页重新挂载
    // （loaded/setAll 是稳定引用，不进依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.length]);

  // 提示要排在空态之前：升级后 Oru 里一个 MCP 都没有的用户，正是「以前在别处配的那批突然全没了」
  // 的那批人——把提示放进列表分支等于恰好漏掉目标人群。
  const unmanagedHint =
    unmanaged.length > 0 ? (
      <p className="mb-2 px-2 text-xs leading-relaxed text-text-tertiary">
        {t('extensions.mcpUnmanagedHint', { names: unmanaged.join(t('extensions.mcpUnmanagedSep')), name: oruName })}
      </p>
    ) : null;

  if (servers.length === 0) {
    return (
      <>
        {unmanagedHint}
        <div className="py-3 text-sm text-text-tertiary">{t('extensions.mcpEmpty')}</div>
      </>
    );
  }

  return (
    <>
      {unmanagedHint}
      <ul className="-mx-2">
      {servers.map((server) => {
        const rt = runtimes[server.id];
        const effStatus = rt?.status ?? 'idle';
        const tip = statusTooltip(effStatus, server.enabled, t, rt);
        const isSelected = selectedId === server.id;
        return (
          <li key={server.id}>
            <button
              type="button"
              onClick={() => onSelect(server.id)}
              className={cn(
                '-ml-0.5 flex w-full cursor-pointer items-start gap-3 border-b border-border py-3 pl-1 pr-2 text-left transition-colors',
                isSelected
                  ? 'border-l-2 border-l-accent bg-hover'
                  : 'border-l-2 border-l-transparent hover:bg-hover',
              )}
            >
              <span
                title={tip}
                className={cn(
                  'relative mt-[7px] inline-block h-[6px] w-[6px] flex-shrink-0 cursor-help rounded-full',
                  dotColorClass(effStatus, server.enabled),
                )}
              >
                {isSpawning(effStatus, server.enabled) ? (
                  <span className="absolute -inset-[3px] animate-spin rounded-full border border-text-tertiary/40 border-t-transparent" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold leading-[1.45] tracking-tight text-text-primary">
                  {server.label}
                </span>
                {server.description ? (
                  <span className="mt-[3px] block truncate text-[12.5px] leading-[1.55] text-text-secondary">
                    {server.description}
                  </span>
                ) : null}
              </span>
              <span className="mt-[2px] inline-flex">
                <McpToggle serverId={server.id} enabled={server.enabled} />
              </span>
            </button>
          </li>
        );
      })}
      </ul>
    </>
  );
}
