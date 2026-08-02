/**
 * Settings ▸ 权限与行为
 *
 * 回答「Oru 被允许做什么、怎么工作」。两个分组：
 *   行动权限——审批挡位（定「以后能自动做什么」）+ 权限策略表（每类行为问不问、已允许的收件人）。
 *   工作方式——全局点睛（含系统权限自检）+ Loop 轮数上限 + 家目录。
 * 挡位 / 家目录来自 active agent；策略表静态行来自行为注册表（shared/proposals/behaviors.ts 单源），
 * grants store 是唯一数据源（表是它的全量视图，挂载拉一次、拨杆/撤销后回全量刷新）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import type { ApprovalMode, Grant } from '@shared/types';
import type { DesktopPresencePermissionsResultEvent } from '@shared/protocol';
import { grantKey } from '@shared/proposals/grantKey';
import { APPROVAL_BEHAVIOR_ROWS, type BehaviorRow } from '@shared/proposals/behaviors';
import { wsClient } from '@/lib/ws';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import { useAgentStore } from '@/stores/agentStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { resolveOruName } from '@/lib/oruName';
import { SettingsSection } from '@/components/settings/ui/SettingsSection';
import { SettingsRow } from '@/components/settings/ui/SettingsRow';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';

export function PermissionsSection() {
  const { t } = useTranslation('settings');
  return (
    <div className="mx-auto max-w-[640px] px-12 py-12">
      <h1 className="mb-9 font-serif text-[30px] font-semibold leading-[1.15] tracking-tight">
        {t('permissions.heading')}
      </h1>

      <ActionSection />
      <WorkSection />
    </div>
  );
}

// ─── 行动权限：审批挡位 + 已授权清单 ───────────────────────

function ActionSection() {
  const { t } = useTranslation('settings');
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const updateAgent = useAgentStore((s) => s.update);
  const active = agents.find((a) => a.id === activeId);
  const oruName = resolveOruName(active?.name);

  return (
    <SettingsSection title={t('permissions.actionTitle')}>
      {active ? (
        <SettingsRow
          label={t('permissions.approval')}
          description={t('permissions.approvalDesc')}
          control={
            <Select
              size="sm"
              value={active.approvalMode}
              onChange={(e) => void updateAgent(active.id, { approvalMode: e.target.value as ApprovalMode })}
              options={[
                { value: 'readonly', label: t('permissions.approvalReadonly') },
                { value: 'work', label: t('permissions.approvalWork') },
                { value: 'danger', label: t('permissions.approvalDanger') },
              ]}
              aria-label={t('permissions.approval')}
            />
          }
        />
      ) : (
        <div className="py-3 text-sm text-text-tertiary">{t('permissions.loading', { name: oruName })}</div>
      )}
      {/* 策略表只在工作挡渲染（2026-08-01 PM 拍板）：只读/危险挡规则内建、表无意义，
          留一行说明替代置灰表——置灰表曾误导用户以为显示的是当前挡实际行为 */}
      {active?.approvalMode === 'work' ? (
        <PolicyTable />
      ) : active ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-text-tertiary">
          {active.approvalMode === 'readonly' ? t('policy.readonlyNote') : t('policy.dangerNote')}
        </p>
      ) : null}
    </SettingsSection>
  );
}

/**
 * 权限策略表——审批行为分类的全量视图，回答「每类行为问不问」。**只在工作挡渲染**（只读/危险挡
 * 规则内建，ActionSection 显示一行说明替代）。
 * 静态行 = 注册表的行为行 + 修饰行；动态行 = 已授权的 delivery（收件人＋渠道，随首次授权长出）。
 * 双向开关（2026-07-31 PM 拍板，取代 v1「只做放行向」）：默认问的行拨开→免卡（grants.add，同卡上
 * 「始终允许」）、拨回→重问（grants.revoke）；默认不问且 askable 的行（create/modify/aiOwned）
 * 拨关→每次问（behaviorPolicy.setAsk 收紧覆盖）、拨开→恢复默认。开关语义统一「开=直接执行」。
 * read/dispatchSubagent 与只读挡职责重叠不做开关；noStructureGuarantee 是纯说明；灾难级锁定行
 * 无拨杆、显示「始终询问」。
 * grants store 与 behaviorPolicy store 是两个数据源（放行向 / 收紧向），挂载各拉一次、拨杆后回全量刷新。
 */
function PolicyTable() {
  const { t } = useTranslation('settings');
  const { t: tp } = useTranslation('proposal');
  const [grants, setGrants] = useState<Grant[] | null>(null); // null = 首拉未回
  const [askRows, setAskRows] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    void wsClient
      .request({ type: 'grants.list' })
      .then((r) => {
        if (alive && r.type === 'grants.list.result') setGrants(r.grants);
      })
      .catch(() => undefined);
    void wsClient
      .request({ type: 'behaviorPolicy.list' })
      .then((r) => {
        if (alive && r.type === 'behaviorPolicy.list.result') setAskRows(r.askRows);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const applyResult = (r: { type: string; grants?: Grant[]; grantPersistFailed?: boolean }) => {
    if (r.type === 'grants.list.result' && r.grants) setGrants(r.grants);
    // 写盘失败如实提示（同 settle 的 grantPersistFailed 口径）：本次仅内存生效，重启后仍会问
    if (r.grantPersistFailed) useToastStore.getState().show(t('policy.persistFailed'));
  };
  const applyPolicyResult = (r: { type: string; askRows?: string[]; persistFailed?: boolean }) => {
    if (r.type === 'behaviorPolicy.list.result' && r.askRows) setAskRows(r.askRows);
    if (r.persistFailed) useToastStore.getState().show(t('policy.askPersistFailed'));
  };
  const onToggle = (row: BehaviorRow, next: boolean) => {
    if (!row.scope) return;
    const key = grantKey(row.scope);
    // 拨杆写侧与卡上「始终允许」同一数据源；label 由后端经注册表推导（协议不传）
    const req = next
      ? wsClient.request({ type: 'grants.add', scope: row.scope })
      : wsClient.request({ type: 'grants.revoke', key });
    void req.then(applyResult).catch(() => undefined);
  };
  // 收紧向拨杆（askable 行）：开关语义与其他行统一「开=直接执行」——拨关写「每次问」覆盖，拨开清除
  const onToggleAsk = (row: BehaviorRow, next: boolean) => {
    void wsClient
      .request({ type: 'behaviorPolicy.setAsk', rowId: row.id, ask: !next })
      .then(applyPolicyResult)
      .catch(() => undefined);
  };
  const onRevoke = (g: Grant) => {
    void wsClient
      .request({ type: 'grants.revoke', key: grantKey(g.scope) })
      .then(applyResult)
      .catch(() => undefined);
  };

  const grantedKeys = new Set((grants ?? []).map((g) => grantKey(g.scope)));
  const deliveryGrants = (grants ?? []).filter((g) => g.scope.kind === 'delivery');

  const controlFor = (row: BehaviorRow) => {
    if (row.locked) {
      // 灾难级：必问、永不可授权
      return <span className="text-xs text-text-tertiary">{tp('behaviors.alwaysAsk')}</span>;
    }
    if (row.scope) {
      return (
        <Switch
          checked={grantedKeys.has(grantKey(row.scope))}
          onChange={(next) => onToggle(row, next)}
          ariaLabel={tp(row.titleKey)}
        />
      );
    }
    if (row.askable) {
      return (
        <Switch
          checked={!(askRows ?? []).includes(row.id)}
          onChange={(next) => onToggleAsk(row, next)}
          ariaLabel={tp(row.titleKey)}
        />
      );
    }
    if (row.perRecipient) return null; // 收件人行动态长出（下方）
    // 说明性修饰 / 与只读挡职责重叠的行：只显示状态、不提供拨杆
    return (
      <span className="text-xs text-text-tertiary">
        {row.defaultAsks ? tp('behaviors.askEveryTime') : tp('behaviors.noAsk')}
      </span>
    );
  };

  const zones: Array<{ zone: BehaviorRow['zone']; caption: string }> = [
    { zone: 'behavior', caption: t('policy.behaviorZone') },
    { zone: 'modifier', caption: t('policy.modifierZone') },
  ];

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-2 text-xs text-text-tertiary">{t('policy.intro')}</p>
      {zones.map(({ zone, caption }) => (
        <div key={zone} className="mt-3 first:mt-0">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-quaternary">
            {caption}
          </div>
          <div>
            {APPROVAL_BEHAVIOR_ROWS.filter((r) => r.zone === zone).map((row) => (
              <div key={row.id}>
                <SettingsRow
                  label={
                    // 技术解释进 hover tip（原生 title，与设置页既有模式一致）；无 tipKey 的行不带
                    <span title={row.tipKey ? tp(row.tipKey) : undefined}>{tp(row.titleKey)}</span>
                  }
                  description={tp(row.descKey)}
                  control={controlFor(row) ?? <span />}
                />
                {/* 发送内容到外部：已授权收件人行随首次授权动态长出（按收件人＋渠道逐一收回） */}
                {row.perRecipient
                  ? deliveryGrants.map((g) => (
                      <SettingsRow
                        key={grantKey(g.scope)}
                        className="pl-4"
                        label={<span className="text-text-secondary">{g.label}</span>}
                        description={t('grants.grantedAt', { time: formatRelativeTime(g.grantedAt) })}
                        control={
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onRevoke(g)}
                            className="shrink-0 text-warn hover:bg-warn-soft"
                          >
                            {t('grants.revoke')}
                          </Button>
                        }
                      />
                    ))
                  : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── 工作方式：全局点睛 + Loop 轮数 + 家目录 ───────────────

function WorkSection() {
  const { t } = useTranslation('settings');
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const active = agents.find((a) => a.id === activeId);
  const desktopPresence = useSettingsStore((s) => s.settings.desktopPresence);
  const loopMaxRounds = useSettingsStore((s) => s.settings.loopMaxRounds) ?? 5;
  const update = useSettingsStore((s) => s.update);

  // Loop 轮数上限（S21·G120）：范围 [1,20]，后端 load 亦 clamp（前端先钳好、少一次越界写盘）。
  const setLoopMaxRounds = (n: number) =>
    void update({ loopMaxRounds: Math.min(20, Math.max(1, Number.isFinite(n) ? Math.round(n) : 5)) });

  // 全局点睛（系统级唤起对话）——回落默认开；关闭后实时回收桌面常驻层。
  // 嵌套对象走 shallow merge，每次传完整对象（将来加触发键不丢字段）。
  const presenceEnabled = desktopPresence?.enabled ?? true;
  const setPresence = (next: boolean) =>
    void update({ desktopPresence: { ...desktopPresence, enabled: next } });

  // 对话中阻止休眠——回落默认关；读写 settings.keepAwake.enabled。
  const keepAwake = useSettingsStore((s) => s.settings.keepAwake);
  const keepAwakeEnabled = keepAwake?.enabled ?? false;
  const setKeepAwake = (next: boolean) => void update({ keepAwake: { ...keepAwake, enabled: next } });

  const onOpenHome = () => {
    if (!active) return;
    void wsClient.request({ type: 'system.openPath', path: active.homePath }).catch(() => undefined);
  };

  return (
    <SettingsSection title={t('permissions.workTitle')}>
      <SettingsRow
        label={t('permissions.presence')}
        description={t('permissions.presenceDesc')}
        control={<Switch checked={presenceEnabled} onChange={setPresence} ariaLabel={t('permissions.presence')} />}
      />
      {presenceEnabled ? <DesktopPresencePermissions /> : null}
      <SettingsRow
        label={t('permissions.keepAwake')}
        description={t('permissions.keepAwakeDesc')}
        control={<Switch checked={keepAwakeEnabled} onChange={setKeepAwake} ariaLabel={t('permissions.keepAwake')} />}
      />
      <SettingsRow
        label={t('permissions.loopMaxRounds')}
        description={t('permissions.loopMaxRoundsDesc')}
        control={
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              max={20}
              value={loopMaxRounds}
              onChange={(e) => setLoopMaxRounds(parseInt(e.target.value, 10))}
              aria-label={t('permissions.loopMaxRounds')}
              className="w-20 rounded border border-border bg-canvas px-2 py-1 text-right font-mono text-xs text-text-primary"
            />
            <span className="text-xs text-text-tertiary">{t('permissions.loopRoundsUnit')}</span>
          </div>
        }
      />
      {active ? (
        <SettingsRow
          label={t('permissions.home')}
          description={
            <span className="font-mono" title={active.homePath}>
              {active.homePath}
            </span>
          }
          control={
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenHome}
              leftIcon={<FolderOpen size={12} strokeWidth={1.5} />}
              className="text-text-secondary"
            >
              {t('permissions.openInFinder')}
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * 全局点睛的两道系统权限引导（开关开启时显示，替代旧 Tray 菜单）。
 * 屏幕录制可查状态；输入监控无 API 可查、只给跳转入口（授权后须重启）。
 */
function DesktopPresencePermissions() {
  const { t } = useTranslation('settings');
  const [screenRecording, setScreenRecording] =
    useState<DesktopPresencePermissionsResultEvent['screenRecording'] | null>(null);

  useEffect(() => {
    let alive = true;
    void wsClient
      .request({ type: 'desktopPresence.permissions' })
      .then((r) => {
        if (alive && r.type === 'desktopPresence.permissions.result') {
          setScreenRecording(r.screenRecording);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const openSettings = (target: 'screen' | 'input') =>
    void wsClient.request({ type: 'desktopPresence.openPermission', target }).catch(() => undefined);

  const screenGranted = screenRecording === 'granted';

  return (
    <>
      <SettingsRow
        label={t('permissions.screen')}
        description={screenGranted ? t('permissions.screenGranted') : t('permissions.screenDenied')}
        control={
          <Button variant="ghost" size="sm" onClick={() => openSettings('screen')} className="text-text-secondary">
            {t('permissions.openSystemSettings')}
          </Button>
        }
      />
      <SettingsRow
        label={t('permissions.input')}
        description={t('permissions.inputDesc')}
        control={
          <Button variant="ghost" size="sm" onClick={() => openSettings('input')} className="text-text-secondary">
            {t('permissions.openSystemSettings')}
          </Button>
        }
      />
    </>
  );
}
