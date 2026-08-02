/**
 * Settings ▸ 数据
 *
 * 把散落的数据生命周期设置收拢：对话久了归档、整体可备份、要销毁走清除。
 * 销毁和恢复相邻，「删之前先备份」是自然动线。三个分组：
 *   对话归档（自动归档 + 归档时长 + 归档前确认）/ 备份与还原（S07·G124/G125）/ 清除（清空主对话）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { wsClient } from '@/lib/ws';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { resolveOruName } from '@/lib/oruName';
import { SettingsSection } from '@/components/settings/ui/SettingsSection';
import { SettingsRow } from '@/components/settings/ui/SettingsRow';
import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';

export function DataSection() {
  const { t } = useTranslation('settings');
  return (
    <div className="mx-auto max-w-[640px] px-12 py-12">
      <h1 className="mb-9 font-serif text-[30px] font-semibold leading-[1.15] tracking-tight">
        {t('data.heading')}
      </h1>

      <ArchiveSection />
      <BackupSection />
      <ClearSection />
    </div>
  );
}

// ─── 对话归档 ───────────────────────────────────────────

export function ArchiveSection() {
  const { t } = useTranslation('settings');
  const autoArchive = useSettingsStore((s) => s.settings.autoArchive);
  const confirmBeforeArchive = useSettingsStore((s) => s.settings.confirmBeforeArchive);
  const update = useSettingsStore((s) => s.update);

  // 老/首屏 settings 可能还没带 autoArchive（后端权威值随 settings.state 到）——回落默认开、7 天。
  const enabled = autoArchive?.enabled ?? true;
  const thresholdHours = autoArchive?.thresholdHours ?? 168;
  // autoArchive 是嵌套对象、settings 走 shallow merge：每次传完整对象，不靠局部 patch。
  const setEnabled = (next: boolean) => void update({ autoArchive: { enabled: next, thresholdHours } });
  const setHours = (h: number) => void update({ autoArchive: { enabled, thresholdHours: Math.max(1, h) } });

  return (
    <SettingsSection title={t('data.archiveTitle')}>
      <SettingsRow
        label={t('data.autoArchive')}
        description={t('data.autoArchiveDesc')}
        control={<Switch checked={enabled} onChange={setEnabled} ariaLabel={t('data.autoArchive')} />}
      />
      <SettingsRow
        label={t('data.confirmArchive')}
        description={t('data.confirmArchiveDesc')}
        control={
          <Switch
            checked={confirmBeforeArchive ?? true}
            onChange={(next) => void update({ confirmBeforeArchive: next })}
            ariaLabel={t('data.confirmArchive')}
          />
        }
      />
      {enabled ? (
        <SettingsRow
          label={t('data.archiveHours')}
          description={t('data.archiveHoursDesc')}
          control={
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={thresholdHours}
                onChange={(e) => setHours(parseInt(e.target.value, 10) || 1)}
                aria-label={t('data.archiveHoursAria')}
                className="w-20 rounded border border-border bg-canvas px-2 py-1 text-right font-mono text-xs text-text-primary"
              />
              <span className="text-xs text-text-tertiary">{t('data.hoursUnit')}</span>
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

// ─── 备份与还原（S07·G124/G125）─────────────────────────

function BackupSection() {
  const { t } = useTranslation('settings');
  const [includeKeys, setIncludeKeys] = useState(false);
  const [busy, setBusy] = useState<null | 'export' | 'restore'>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const onExport = async () => {
    setBusy('export');
    setStatus(null);
    try {
      const r = await window.oruBackup.export(includeKeys);
      if (r.ok) setStatus({ kind: 'ok', text: t('data.exportOk', { path: r.path }) });
      else if (r.error) setStatus({ kind: 'err', text: t('data.exportFail', { error: r.error }) });
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async () => {
    setBusy('restore');
    setStatus(null);
    try {
      // 成功即将重启，无需处理 ok 分支的后续 UI；仅在失败/取消时留状态
      const r = await window.oruBackup.restore();
      if (!r.ok && r.error) setStatus({ kind: 'err', text: t('data.restoreFail', { error: r.error }) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection title={t('data.backupTitle')}>
      <SettingsRow
        label={t('data.exportLabel')}
        description={t('data.exportDesc')}
        control={
          <Button variant="ghost" onClick={onExport} disabled={busy !== null}>
            {busy === 'export' ? t('data.exporting') : t('data.exportBtn')}
          </Button>
        }
      />
      <SettingsRow
        label={t('data.includeKeys')}
        description={t('data.includeKeysDesc')}
        control={<Switch checked={includeKeys} onChange={setIncludeKeys} ariaLabel={t('data.includeKeys')} />}
      />
      <SettingsRow
        label={t('data.restoreLabel')}
        description={t('data.restoreDesc')}
        control={
          <Button variant="ghost" onClick={onRestore} disabled={busy !== null}>
            {busy === 'restore' ? t('data.restoring') : t('data.restoreBtn')}
          </Button>
        }
      />
      {status ? (
        <div
          className={cn(
            'mt-2 break-all text-xs',
            status.kind === 'ok' ? 'text-text-tertiary' : 'text-warn',
          )}
        >
          {status.text}
        </div>
      ) : null}
    </SettingsSection>
  );
}

// ─── 清除 ───────────────────────────────────────────────

function ClearSection() {
  const { t } = useTranslation('settings');
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const active = agents.find((a) => a.id === activeId);
  const oruName = resolveOruName(active?.name); // 称呼收敛：无 active 时回落 Oru
  const clearConv = useConversationStore((s) => s.clear);

  if (!active) return null;

  const onClearMain = () => {
    if (confirm(t('data.clearMainConfirm', { name: oruName }))) {
      void clearConv(active.id, `main_${active.id}`);
    }
  };

  return (
    <SettingsSection title={t('data.clearTitle')}>
      <SettingsRow
        label={t('data.clearMainLabel')}
        control={
          <Button
            variant="danger"
            size="sm"
            onClick={onClearMain}
            leftIcon={<Trash2 size={12} strokeWidth={1.5} />}
          >
            {t('data.clear')}
          </Button>
        }
      />
    </SettingsSection>
  );
}
