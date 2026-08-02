/**
 * Settings ▸ 通用
 *
 * 身份 / 外观 / 界面（语言 + 自动隐藏左栏）/ 开发者（藏在版本号 5 次点击后）。
 * 所有 row 走统一的 SettingsSection + SettingsRow 范式。
 * 原「偏好」页拆分后的落点：归档/备份去「数据」，挡位/点睛/家目录去「权限与行为」。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FolderOpen, Check, Play, Trash2 } from 'lucide-react';
import type { DreamRunOutcome } from '@shared/types';
import { effectiveMode } from '@/lib/theme';
import { wsClient } from '@/lib/ws';
import { useAgentStore } from '@/stores/agentStore';
import { resolveOruName } from '@/lib/oruName';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { AvatarPair } from '@/components/AvatarPair';
import { EditProfileDialog } from '@/components/EditProfileDialog';
import { useLayoutStore } from '@/stores/layoutStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { THEMES, type ThemeMeta } from '@/lib/themes';
import { SettingsSection } from '@/components/settings/ui/SettingsSection';
import { SettingsRow } from '@/components/settings/ui/SettingsRow';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';

export function GeneralSection() {
  const { t } = useTranslation('settings');
  return (
    <div className="mx-auto max-w-[640px] px-12 py-12">
      <h1 className="mb-9 font-serif text-[30px] font-semibold leading-[1.15] tracking-tight">
        {t('general.heading')}
      </h1>

      <IdentitySection />
      <AppearanceSection />
      <InterfaceSection />
      <DeveloperSection />
    </div>
  );
}

// ─── 身份（双头像，A6 从主页迁入）──────────────────────
// 双头像 + 呼吸 / 翻转动画（AvatarPair，含 index.css 的 oru-pair 系）原样保留；
// hover 铅笔照常开 EditProfileDialog（改名 / 换头像）。主页启动器已另有编辑入口，此处是设置页落位。
function IdentitySection() {
  const { t } = useTranslation('pages');
  const activeAgent = useAgentStore((s) => s.agents.find((a) => a.id === s.activeAgentId) ?? null);
  const oruName = resolveOruName(activeAgent?.name);
  const userProfile = useUserProfileStore((s) => s.profile);
  const [editing, setEditing] = useState(false);
  return (
    <div className="mb-11 flex justify-center pt-2">
      <AvatarPair
        user={{ name: userProfile?.name ?? t('home.userFallback'), avatarPath: userProfile?.avatarPath ?? null }}
        twin={{ name: oruName, avatarPath: activeAgent?.avatarPath ?? null }}
        onEdit={() => setEditing(true)}
        paused={editing}
      />
      {editing ? <EditProfileDialog onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

// ─── 外观 ───────────────────────────────────────────────

function AppearanceSection() {
  const { t } = useTranslation('settings');
  const mode = useSettingsStore((s) => s.settings.theme);
  const colorScheme = useSettingsStore((s) => s.settings.colorScheme);
  const update = useSettingsStore((s) => s.update);
  const effective = effectiveMode(mode);

  return (
    <SettingsSection title={t('general.appearance.title')}>
      <SettingsRow
        label={t('general.appearance.modeLabel')}
        control={
          <div
            role="radiogroup"
            aria-label={t('general.appearance.modeLabel')}
            className="inline-flex gap-0.5 rounded-md border border-border bg-canvas p-0.5"
          >
            {(['light', 'dark', 'system'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => void update({ theme: m })}
                className={`rounded-sm px-2.5 py-0.5 text-xs transition-colors ${
                  mode === m
                    ? 'bg-[var(--segment-on)] text-[var(--segment-on-fg)]'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {t(`general.appearance.mode.${m}`)}
              </button>
            ))}
          </div>
        }
      />
      <div className="py-3">
        <div className="mb-2 text-sm text-text-primary">{t('general.appearance.colorScheme')}</div>
        <div role="radiogroup" aria-label={t('general.appearance.colorScheme')} className="grid grid-cols-2 gap-2">
          {THEMES.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              effective={effective}
              selected={colorScheme === theme.id}
              onSelect={() => void update({ colorScheme: theme.id })}
            />
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}

function ThemeCard({
  theme,
  effective,
  selected,
  onSelect,
}: {
  theme: ThemeMeta;
  effective: 'light' | 'dark';
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('settings');
  const swatch = effective === 'dark' ? theme.dark : theme.light;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`relative flex flex-col items-stretch gap-2 rounded-md border p-2 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent-soft'
          : 'border-border bg-canvas hover:bg-hover'
      }`}
    >
      {selected ? (
        <Check
          size={12}
          strokeWidth={2}
          className="absolute right-1.5 top-1.5 text-accent"
        />
      ) : null}
      <div
        className="flex h-7 overflow-hidden rounded"
        style={{ border: '1px solid rgba(0,0,0,0.06)' }}
      >
        <div className="flex-1" style={{ background: swatch.bg }} />
        <div className="flex-1" style={{ background: swatch.elev }} />
        <div className="flex-[1.4]" style={{ background: swatch.accent }} />
      </div>
      <span className="text-xs text-text-primary">{t(`general.appearance.themeName.${theme.id}`)}</span>
    </button>
  );
}

// ─── 界面（语言 + 自动隐藏左栏；归档已迁「数据」、点睛/轮数已迁「权限与行为」）──

function InterfaceSection() {
  const { t } = useTranslation('settings');
  const autoHideSidebar = useLayoutStore((s) => s.autoHideSidebar);
  const setAutoHideSidebar = useLayoutStore((s) => s.setAutoHideSidebar);
  const language = useSettingsStore((s) => s.settings.language) ?? 'system';
  const update = useSettingsStore((s) => s.update);

  return (
    <SettingsSection title={t('general.interface.title')}>
      <SettingsRow
        label={t('general.interface.language')}
        description={t('general.interface.languageDesc')}
        control={
          <Select
            size="sm"
            value={language}
            onChange={(e) => void update({ language: e.target.value as 'zh' | 'en' | 'system' })}
            options={[
              { value: 'system', label: t('general.interface.langSystem') },
              { value: 'zh', label: t('general.interface.langZh') },
              { value: 'en', label: t('general.interface.langEn') },
            ]}
            aria-label={t('general.interface.language')}
          />
        }
      />
      <SettingsRow
        label={t('general.interface.autoHide')}
        description={t('general.interface.autoHideDesc')}
        control={
          <Switch
            checked={autoHideSidebar}
            onChange={setAutoHideSidebar}
            ariaLabel={t('general.interface.autoHide')}
          />
        }
      />
    </SettingsSection>
  );
}

// ─── 开发者（藏在 H1 上方版本号 5 次点击后）─────────────────────

function renderDreamRunOutcome(r: DreamRunOutcome, t: TFunction): string {
  switch (r.kind) {
    case 'ok':
      return t('settings:general.dev.dreamOutcome.ok', {
        facts: r.userFactsChanged,
        fields: r.projectFieldsChanged,
        episodes: r.episodesMerged,
        profile:
          r.profileWrites.length === 0
            ? t('settings:general.dev.dreamOutcome.none')
            : '\n  - ' + r.profileWrites.join('\n  - '),
      });
    case 'skipped':
      return r.reason === 'concurrent-run'
        ? t('settings:general.dev.dreamOutcome.skippedConcurrent')
        : t('settings:general.dev.dreamOutcome.skippedNoNew');
    case 'failed':
      return t('settings:general.dev.dreamOutcome.failed', {
        error: r.error || t('settings:general.dev.dreamOutcome.noError'),
      });
  }
}

function DeveloperSection() {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const unlocked = useSettingsStore((s) => s.devModeUnlocked);
  const setDevModeUnlocked = useSettingsStore((s) => s.setDevModeUnlocked);
  const [clickCount, setClickCount] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [dreamRunning, setDreamRunning] = useState(false);
  const [dreamResult, setDreamResult] = useState<DreamRunOutcome | null>(null);

  const debugLogging = settings.developer?.debugLogging === true;

  const onVersionClick = () => {
    if (unlocked) return;
    const next = clickCount + 1;
    if (next >= 5) {
      setDevModeUnlocked(true);
      setClickCount(0);
    } else {
      setClickCount(next);
    }
  };

  const onRunDream = async () => {
    setDreamRunning(true);
    setDreamResult(null);
    try {
      // dream 跑一次完整 LLM 推理 + 落盘，10-60s 是常态；默认 30s 会误报"请求超时"
      const resp = await wsClient.request({ type: 'memory.dream.runNow' }, 5 * 60_000);
      if (resp.type !== 'memory.dream.runNow.result') {
        setDreamResult({ kind: 'failed', error: t('general.dev.dreamOutcome.badResponse') });
        return;
      }
      setDreamResult(resp.summary);
    } catch (e) {
      setDreamResult({ kind: 'failed', error: e instanceof Error ? e.message : String(e) });
    } finally {
      setDreamRunning(false);
    }
  };

  const onToggleDebug = async () => {
    // 显式展开现有 developer 子对象——避免将来加新字段时被覆盖（settings 是 shallow merge）
    await updateSettings({ developer: { ...settings.developer, debugLogging: !debugLogging } });
  };

  const onOpenDir = async () => {
    try {
      await window.oruDebug.openDir();
    } catch (e) {
      console.warn('[debug] openDir failed', e);
    }
  };

  const onClearAll = async () => {
    if (!confirm(t('general.dev.clearAllConfirm'))) return;
    setClearing(true);
    try {
      await window.oruDebug.clearAll();
    } catch (e) {
      console.warn('[debug] clearAll failed', e);
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      {/* 解锁开关：版本号 5 次点击 */}
      <div className="mt-8 border-t border-border pt-3">
        <button
          type="button"
          onClick={onVersionClick}
          className="text-[10px] text-text-tertiary/60 hover:text-text-tertiary"
          title={unlocked ? t('general.dev.unlockedTitle') : undefined}
        >
          Oru
        </button>
      </div>

      {unlocked ? (
        <SettingsSection title={t('general.dev.title')} className="mt-4">
          <SettingsRow
            label={t('general.dev.dream')}
            description={t('general.dev.dreamDesc')}
            control={
              <Button
                variant="ghost"
                size="sm"
                onClick={onRunDream}
                disabled={dreamRunning}
                leftIcon={<Play size={12} strokeWidth={1.5} />}
                className="text-text-secondary"
              >
                {dreamRunning ? t('general.dev.dreamRunning') : t('general.dev.dreamRun')}
              </Button>
            }
          />
          {dreamResult ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-canvas px-3 py-2 font-mono text-xs leading-relaxed text-text-secondary">
              {renderDreamRunOutcome(dreamResult, t)}
            </pre>
          ) : null}
          <SettingsRow
            label={t('general.dev.debugLog')}
            description={t('general.dev.debugLogDesc')}
            control={
              <Switch
                checked={debugLogging}
                onChange={() => void onToggleDebug()}
                ariaLabel={t('general.dev.debugLog')}
              />
            }
          />
          <SettingsRow
            label={t('general.dev.debugDir')}
            description="~/.oru/users/local-user/debug/"
            control={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenDir}
                  leftIcon={<FolderOpen size={12} strokeWidth={1.5} />}
                  className="text-text-secondary"
                >
                  {t('general.dev.open')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClearAll}
                  disabled={clearing}
                  leftIcon={<Trash2 size={12} strokeWidth={1.5} />}
                  className="text-text-secondary"
                >
                  {clearing ? t('general.dev.clearing') : t('general.dev.clearAll')}
                </Button>
              </>
            }
          />
        </SettingsSection>
      ) : null}
    </>
  );
}
