/**
 * Settings ▸ 平台连接（三方平台接入第一期）——飞书 / Discord 远程入口。
 *
 * 每平台一个 SettingsSection：状态徽标 + 启用开关收在 trailing，凭证（一次性写入、
 * 永不回读——红线 1）落在 body。凭证密文只上行不下行，UI 永远只看到「是否已配置」。
 * 页面壳与字号严格对齐其余设置页（max-w-640 + serif H1 + SettingsSection/SettingsRow）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Loader2, Check, X } from 'lucide-react';
import type { Platform, PlatformConnState, PlatformStatus, FeishuUserAuthState } from '@shared/platform/message';
import type { WhitelistEntry } from '@shared/types';
import type { PlatformConfigEvent, PlatformDoctorResultEvent } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { toastError } from '@/lib/toast';
import { useAgentStore } from '@/stores/agentStore';
import { SettingsSection } from '@/components/settings/ui/SettingsSection';
import { SettingsRow } from '@/components/settings/ui/SettingsRow';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

type Config = PlatformConfigEvent['config'];

function statusOf(config: Config | null, platform: Platform): PlatformStatus | undefined {
  return config?.statuses.find((s) => s.platform === platform);
}

export function PlatformsSection() {
  const { t } = useTranslation('settings');
  const agents = useAgentStore((s) => s.agents);
  const [config, setConfig] = useState<Config | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);

  useEffect(() => {
    void wsClient.request({ type: 'platform.getConfig' }).then((r) => {
      if (r.type === 'platform.config') setConfig(r.config);
    });
    // 实时状态：连接/断线/凭证错由主进程主动推
    return wsClient.subscribe((ev) => {
      if (ev.type === 'platform.config') setConfig(ev.config);
      if (ev.type === 'platform.status') {
        setConfig((c) =>
          c ? { ...c, statuses: [...c.statuses.filter((s) => s.platform !== ev.status.platform), ev.status] } : c,
        );
      }
    });
  }, []);

  const refresh = async () => {
    const r = await wsClient.request({ type: 'platform.getConfig' });
    if (r.type === 'platform.config') setConfig(r.config);
  };

  const issuePairing = async () => {
    const r = await wsClient.request({ type: 'platform.issuePairingCode' });
    if (r.type === 'platform.pairingCode') setPairing({ code: r.code, expiresAt: r.expiresAt });
  };

  return (
    <div className="mx-auto max-w-[640px] px-12 py-12">
      <h1 className="mb-3 font-serif text-[30px] font-semibold leading-[1.15] tracking-tight">
        {t('platforms.heading')}
      </h1>
      <p className="mb-8 text-sm leading-relaxed text-text-secondary">
        {t('platforms.intro')}
      </p>

      {!config ? (
        <div className="flex items-center gap-2 text-sm text-text-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('common:loading')}
        </div>
      ) : (
        <>
          <SettingsSection title={t('platforms.remoteSection')}>
            <SettingsRow
              label={t('platforms.remoteDefault')}
              description={t('platforms.remoteDefaultDesc')}
              control={
                <Select
                  size="sm"
                  aria-label={t('platforms.remoteDefault')}
                  value={config.remoteDefaultAgentId ?? ''}
                  onChange={(e) =>
                    void wsClient
                      .request({ type: 'platform.setRemoteAgent', agentId: e.target.value || null })
                      .then(refresh)
                  }
                  options={[
                    { value: '', label: t('platforms.unspecified') },
                    ...agents.map((a) => ({ value: a.id, label: a.name })),
                  ]}
                />
              }
            />
            <SettingsRow
              label={t('platforms.pairingCode')}
              description={t('platforms.pairingCodeDesc')}
              control={
                <>
                  {pairing ? (
                    <code className="rounded-md border border-border bg-canvas px-2 py-1 font-mono text-base tracking-widest text-text-primary">
                      {pairing.code}
                    </code>
                  ) : null}
                  <Button size="sm" variant="primary" onClick={() => void issuePairing()}>
                    {t('platforms.issuePairing')}
                  </Button>
                </>
              }
            />
          </SettingsSection>

          <FeishuCard config={config} onChanged={refresh} />
          <DiscordCard config={config} onChanged={refresh} />
        </>
      )}
    </div>
  );
}

/** 白名单条目副标题：手动 · 绑定日期（平台在卡片层已隐含，不再重复）；无元数据则回落静态"已绑定"。 */
function whitelistSubtitle(entry: WhitelistEntry, t: ReturnType<typeof useTranslation>['t']): string {
  const parts: string[] = [];
  if (entry.source === 'manual') parts.push(t('platforms.whitelistManual'));
  if (entry.boundAt) parts.push(new Date(entry.boundAt).toLocaleDateString());
  return parts.length ? parts.join(' · ') : t('platforms.whitelistBound');
}

/**
 * 单渠道白名单：谁的准入谁管理，添加时平台由卡片隐含、不再选。
 * 归属：platform 匹配本渠道；platform 留空的旧数据（迁移前裸字符串）归到飞书（飞书先上线，历史绑定几乎都是它），
 * 免得旧条目无处显示、无法撤销。移除按 id（平台无关）。
 */
function WhitelistBlock({
  platform,
  config,
  onChanged,
}: {
  platform: Platform;
  config: Config;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [id, setId] = useState('');
  const [adding, setAdding] = useState(false);
  const entries = config.whitelist.filter((e) =>
    platform === 'feishu' ? e.platform === 'feishu' || !e.platform : e.platform === platform,
  );

  const add = async () => {
    if (!id.trim()) return;
    setAdding(true);
    try {
      await wsClient.request({ type: 'platform.addToWhitelist', id: id.trim(), platform });
      setId('');
    } catch (e) {
      console.warn('[platform] addToWhitelist 失败', e);
      toastError(t('toast.whitelistAddFailed'));
      return;
    } finally {
      setAdding(false);
    }
    // 加白已成功，刷新失败最多让新条目这次不显示、下次进设置补上——不能算作「添加失败」误报
    await onChanged();
  };

  return (
    <div className="mt-1 border-t border-border pt-3">
      <div className="mb-1 text-xs font-medium text-text-secondary">{t('platforms.whitelist')}</div>
      {entries.length === 0 ? (
        <div className="py-2 text-xs text-text-tertiary">{t('platforms.whitelistEmpty')}</div>
      ) : (
        <div className="flex flex-col">
          {entries.map((entry) => (
            <SettingsRow
              key={entry.id}
              label={
                entry.displayName ? (
                  <span className="flex items-center gap-2">
                    <span className="text-sm text-text-primary">{entry.displayName}</span>
                    <code className="font-mono text-[11px] text-text-tertiary">{entry.id}</code>
                  </span>
                ) : (
                  <code className="font-mono text-xs text-text-secondary">{entry.id}</code>
                )
              }
              description={whitelistSubtitle(entry, t)}
              control={
                <Button
                  variant="danger"
                  size="sm"
                  leftIcon={<Trash2 size={12} strokeWidth={1.5} />}
                  onClick={() =>
                    void wsClient.request({ type: 'platform.removeFromWhitelist', id: entry.id }).then(onChanged)
                  }
                >
                  {t('platforms.remove')}
                </Button>
              }
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 py-2">
        <Input
          className="flex-1"
          placeholder={t('platforms.whitelistAddId')}
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <Button variant="primary" size="sm" disabled={!id.trim() || adding} onClick={() => void add()}>
          {t('platforms.whitelistAdd')}
        </Button>
      </div>
    </div>
  );
}

function StatusBadge({ state }: { state: PlatformConnState }) {
  const { t } = useTranslation('settings');
  const tone =
    state === 'connected'
      ? 'text-success'
      : state === 'credential-error' || state === 'held-by-other'
        ? 'text-warn'
        : 'text-text-tertiary';
  return <span className={`text-xs ${tone}`}>{t(`platforms.state.${state}`)}</span>;
}

/** 章节 trailing 簇：连接状态徽标 + 启用开关。 */
function StatusToggle({
  state,
  enabled,
  ariaLabel,
  onToggle,
}: {
  state: PlatformConnState;
  enabled: boolean;
  ariaLabel: string;
  onToggle: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <StatusBadge state={state} />
      <Switch ariaLabel={ariaLabel} checked={enabled} onChange={onToggle} />
    </div>
  );
}

/** 凭证一次性录入面板——未配置时露出输入，配置后只显示「已配置 + 清除」。 */
function CredentialForm({
  fields,
  saving,
  canSave,
  onSave,
}: {
  fields: ReactNode;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-2 py-3">
      {fields}
      <div className="flex justify-end">
        <Button variant="primary" size="sm" disabled={!canSave || saving} onClick={onSave}>
          {saving ? t('common:saving') : t('platforms.saveCredential')}
        </Button>
      </div>
    </div>
  );
}

function ClearedRow({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation('settings');
  return (
    <SettingsRow
      label={t('platforms.credential')}
      description={t('platforms.credentialConfigured')}
      control={
        <Button variant="danger" size="sm" leftIcon={<Trash2 size={12} strokeWidth={1.5} />} onClick={onClear}>
          {t('platforms.clear')}
        </Button>
      }
    />
  );
}

function FeishuCard({ config, onChanged }: { config: Config; onChanged: () => Promise<void> }) {
  const { t } = useTranslation('settings');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const state = statusOf(config, 'feishu')?.state ?? (config.feishuConfigured ? 'disconnected' : 'not-configured');

  const save = async () => {
    if (!appId.trim() || !appSecret.trim()) return;
    setSaving(true);
    try {
      await wsClient.request({ type: 'platform.setCredential', platform: 'feishu', appId: appId.trim(), appSecret: appSecret.trim() });
      setAppId('');
      setAppSecret('');
      await onChanged();
    } finally {
      setSaving(false); // 请求 reject 时也复位，否则「保存」按钮永久 disable
    }
  };

  return (
    <SettingsSection
      title={t('platforms.feishu')}
      trailing={
        <StatusToggle
          state={state}
          enabled={config.feishuEnabled}
          ariaLabel={t('platforms.feishuEnableAria')}
          onToggle={(v) => void wsClient.request({ type: 'platform.setEnabled', platform: 'feishu', enabled: v }).then(onChanged)}
        />
      }
    >
      {config.feishuConfigured ? (
        <>
          <ClearedRow onClear={() => void wsClient.request({ type: 'platform.clearCredential', platform: 'feishu' }).then(onChanged)} />
          <FeishuSetup />
          <FeishuUserAuth config={config} onChanged={onChanged} />
        </>
      ) : (
        <CredentialForm
          saving={saving}
          canSave={appId.trim().length > 0 && appSecret.trim().length > 0}
          onSave={() => void save()}
          fields={
            <>
              <Input placeholder="App ID" value={appId} onChange={(e) => setAppId(e.target.value)} />
              <Input placeholder="App Secret" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} />
            </>
          }
        />
      )}
      <WhitelistBlock platform="feishu" config={config} onChanged={onChanged} />
    </SettingsSection>
  );
}

/**
 * 飞书首次适配（§A）——一键开权限 + 检查。凭证已配置后显示：
 * - 「一键开通权限」：Oru 算出所需 scope 并集、拼飞书原生申请深链，点开后台全部预勾、确认+发布。
 * - 「检查」：跑 doctor 自检（config/auth/连通逐项）+ 校验 scope 是否到位；缺啥给「点这申请」直达链接。
 */
function FeishuSetup() {
  const { t } = useTranslation('settings');
  const [busy, setBusy] = useState<null | 'scope' | 'doctor'>(null);
  const [doctor, setDoctor] = useState<PlatformDoctorResultEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  // busy 一律在 finally 里复位——否则请求 reject（超时/后端抛错）时按钮永久卡「检查中…」。
  const openScopeLink = async () => {
    setBusy('scope');
    setError(null);
    try {
      const r = await wsClient.request({ type: 'platform.feishuScopeLink' });
      if (r.type === 'platform.scopeLink') window.open(r.link, '_blank');
      else if (r.type === 'error') setError(r.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const runDoctor = async () => {
    setBusy('doctor');
    setError(null);
    try {
      // doctor 后台串行跑多次 lark-cli（doctor + schema + auth scopes），npx 冷启动 + 联网较慢，
      // 默认 30s 超时必被这条链路撞爆——给足 90s，别让「检查」注定超时。
      const r = await wsClient.request({ type: 'platform.doctor' }, 90_000);
      if (r.type === 'platform.doctorResult') setDoctor(r);
      else if (r.type === 'error') setError(r.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void openScopeLink()} className="text-text-secondary">
          {busy === 'scope' ? t('platforms.scopeGenerating') : t('platforms.scopeOpen')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void runDoctor()} className="text-text-secondary">
          {busy === 'doctor' ? t('platforms.doctorRunning') : t('platforms.doctorRun')}
        </Button>
      </div>
      {error ? <div className="text-xs text-danger">{t('platforms.checkFailed', { error })}</div> : null}
      {doctor ? <DoctorReport result={doctor} /> : null}
    </div>
  );
}

/**
 * 飞书用户身份（S5 · device flow）——「以本人身份读写飞书文档」的授权入口。
 * 状态机在主进程（feishuUserAuth.ts），这里只渲染快照 + 发四个请求
 * （start / cancel / revoke / sendLink）；迁移经 platform.feishuUserAuth 事件实时推。
 */
function FeishuUserAuth({ config, onChanged }: { config: Config; onChanged: () => Promise<void> }) {
  const { t } = useTranslation('settings');
  const [flow, setFlow] = useState<FeishuUserAuthState>({ phase: 'idle' });
  const [busy, setBusy] = useState<null | 'start' | 'send'>(null);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      wsClient.subscribe((ev) => {
        if (ev.type === 'platform.feishuUserAuth') {
          setFlow(ev.state);
          // 授权成功 → 刷新配置快照（行状态翻「已授权」）
          if (ev.state.phase === 'authorized') void onChanged();
        }
      }),
    [onChanged],
  );

  // busy 一律 finally 复位（同 FeishuSetup 的纪律：reject 不能卡死按钮）
  const start = async () => {
    setBusy('start');
    setError(null);
    setSent(false);
    try {
      const r = await wsClient.request({ type: 'platform.feishuUserAuthStart' });
      if (r.type === 'platform.feishuUserAuth') setFlow(r.state);
      else if (r.type === 'error') setError(r.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    const r = await wsClient.request({ type: 'platform.feishuUserAuthCancel' });
    if (r.type === 'platform.feishuUserAuth') setFlow(r.state);
  };

  const revoke = async () => {
    await wsClient.request({ type: 'platform.feishuUserAuthRevoke' });
    setFlow({ phase: 'idle' });
    await onChanged();
  };

  const sendLink = async () => {
    setBusy('send');
    setError(null);
    try {
      const r = await wsClient.request({ type: 'platform.feishuUserAuthSendLink' });
      if (r.type === 'platform.feishuUserAuth') setSent(true);
      else if (r.type === 'error') setError(r.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async (link: string) => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border py-3">
      <SettingsRow
        label={t('platforms.userAuth')}
        description={
          config.feishuUserAuthorized
            ? t('platforms.userAuthAuthorized', { name: config.feishuUserName ?? '' })
            : t('platforms.userAuthNotAuthorized')
        }
        control={
          config.feishuUserAuthorized ? (
            <Button variant="danger" size="sm" leftIcon={<Trash2 size={12} strokeWidth={1.5} />} onClick={() => void revoke()}>
              {t('platforms.userAuthRevoke')}
            </Button>
          ) : flow.phase === 'pending' ? null : (
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void start()}>
              {busy === 'start' ? t('platforms.userAuthStarting') : t('platforms.userAuthStart')}
            </Button>
          )
        }
      />
      {flow.phase === 'pending' ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-canvas p-2.5 text-xs">
          <span className="text-text-secondary">
            {t('platforms.userAuthPending', { minutes: Math.max(1, Math.round((flow.expiresAt - Date.now()) / 60000)) })}
          </span>
          <button
            type="button"
            className="break-all text-left text-accent underline"
            onClick={() => window.open(flow.verificationUriComplete, '_blank')}
          >
            {flow.verificationUriComplete}
          </button>
          <div className="flex items-center gap-2">
            <code className="rounded-md border border-border px-2 py-1 font-mono tracking-widest text-text-primary">
              {flow.userCode}
            </code>
            <Button variant="ghost" size="sm" className="text-text-secondary" onClick={() => void copyLink(flow.verificationUriComplete)}>
              {copied ? t('platforms.userAuthCopied') : t('platforms.userAuthCopy')}
            </Button>
            <Button variant="ghost" size="sm" className="text-text-secondary" disabled={busy !== null} onClick={() => void sendLink()}>
              {sent ? t('platforms.userAuthSent') : t('platforms.userAuthSend')}
            </Button>
            <Button variant="ghost" size="sm" className="text-text-secondary" onClick={() => void cancel()}>
              {t('platforms.userAuthCancel')}
            </Button>
          </div>
        </div>
      ) : null}
      {flow.phase === 'denied' ? <div className="text-xs text-warn">{t('platforms.userAuthDenied')}</div> : null}
      {flow.phase === 'expired' ? <div className="text-xs text-warn">{t('platforms.userAuthExpired')}</div> : null}
      {flow.phase === 'error' ? (
        <div className="text-xs text-danger">{t('platforms.userAuthFailed', { error: flow.message })}</div>
      ) : null}
      {error ? <div className="text-xs text-danger">{t('platforms.userAuthFailed', { error })}</div> : null}
    </div>
  );
}

function DoctorReport({ result }: { result: PlatformDoctorResultEvent }) {
  const { t } = useTranslation('settings');
  const { doctor, scopeCheck, applyLink } = result;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-canvas p-2.5 text-xs">
      {doctor.error ? <div className="text-danger">{doctor.error}</div> : null}
      {doctor.checks.map((c) => (
        <div key={c.name} className="flex items-center gap-2">
          {c.status === 'pass' ? (
            <Check size={13} strokeWidth={1.5} className="shrink-0 text-success" />
          ) : (
            <X size={13} strokeWidth={1.5} className="shrink-0 text-danger" />
          )}
          <span className="text-text-secondary">{c.name}</span>
          <span className="truncate text-text-tertiary">{c.message}</span>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-2 border-t border-border pt-1.5">
        {scopeCheck.ok ? (
          <span className="flex items-center gap-1 text-success">
            <Check size={13} strokeWidth={1.5} /> {t('platforms.scopeOk')}
          </span>
        ) : scopeCheck.error ? (
          <span className="text-danger">{t('platforms.scopeCheckError', { error: scopeCheck.error })}</span>
        ) : (
          <>
            <span className="text-warn">
              {t('platforms.scopeMissing', {
                count: scopeCheck.missing.length,
                list: scopeCheck.missing.join(', '),
              })}
            </span>
            {applyLink ? (
              <Button variant="ghost" size="sm" className="text-accent" onClick={() => window.open(applyLink, '_blank')}>
                {t('platforms.applyLink')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function DiscordCard({ config, onChanged }: { config: Config; onChanged: () => Promise<void> }) {
  const { t } = useTranslation('settings');
  const [botToken, setBotToken] = useState('');
  const [saving, setSaving] = useState(false);
  const state = statusOf(config, 'discord')?.state ?? (config.discordConfigured ? 'disconnected' : 'not-configured');

  const save = async () => {
    if (!botToken.trim()) return;
    setSaving(true);
    try {
      await wsClient.request({ type: 'platform.setCredential', platform: 'discord', botToken: botToken.trim() });
      setBotToken('');
      await onChanged();
    } finally {
      setSaving(false); // 请求 reject 时也复位，否则「保存」按钮永久 disable
    }
  };

  return (
    <SettingsSection
      title={t('platforms.discord')}
      trailing={
        <StatusToggle
          state={state}
          enabled={config.discordEnabled}
          ariaLabel={t('platforms.discordEnableAria')}
          onToggle={(v) => void wsClient.request({ type: 'platform.setEnabled', platform: 'discord', enabled: v }).then(onChanged)}
        />
      }
    >
      {config.discordConfigured ? (
        <ClearedRow onClear={() => void wsClient.request({ type: 'platform.clearCredential', platform: 'discord' }).then(onChanged)} />
      ) : (
        <CredentialForm
          saving={saving}
          canSave={botToken.trim().length > 0}
          onSave={() => void save()}
          fields={<Input placeholder="Bot Token" type="password" value={botToken} onChange={(e) => setBotToken(e.target.value)} />}
        />
      )}
      <WhitelistBlock platform="discord" config={config} onChanged={onChanged} />
    </SettingsSection>
  );
}
