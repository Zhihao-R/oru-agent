/**
 * Settings ▸ 拓展 ▸ Web 搜索
 *
 * 三件事：总开关 / 引擎列表（API key + 测试 + 排序） / 长摘要开关。
 * 用统一的 SettingsSection + SettingsRow 范式。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Trash2,
  ArrowUp,
  ArrowDown,
  Loader2,
  X as XIcon,
  Edit3,
  RefreshCw,
  Plus,
} from 'lucide-react';
import type {
  SearchEngineConfig,
  SearchEngineType,
  UnsupportedEngineConfig,
  WebSearchSettings,
} from '@shared/types';
import { wsClient } from '@/lib/ws';
import { useSettingsStore } from '@/stores/settingsStore';
import { useOruName } from '@/lib/oruName';
import { SettingsRow } from '@/components/settings/ui/SettingsRow';
import { hoverToolsCls } from '@/components/settings/ui/hoverTools';
import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/** 引擎官网 key 申请地址——外部 URL 属数据，不随语言变。 */
const ENGINE_KEY_URL: Record<SearchEngineType, string> = {
  bocha: 'https://open.bochaai.com/',
  tavily: 'https://tavily.com/',
  anysearch: 'https://anysearch.com/',
};

/** 引擎展示名 / 一句话提示 / 申请文案，t 由调用方按 settings ns 绑定传入。 */
function engineLabel(type: SearchEngineType, t: TFunction): string {
  return t(`webSearch.engineLabel.${type}`);
}
function engineHint(type: SearchEngineType, t: TFunction): string {
  return t(`webSearch.engineHint.${type}`);
}
function engineKeyApply(type: SearchEngineType, t: TFunction): string {
  return t(`webSearch.engineKeyApply.${type}`);
}

const ALL_ENGINE_TYPES: SearchEngineType[] = ['bocha', 'tavily', 'anysearch'];

function defaultWebSearch(): WebSearchSettings {
  return { enabled: false, engines: [], longPageSummary: true };
}

function makeId(): string {
  return `eng_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function WebSearchSettingsSection() {
  const { t } = useTranslation('settings');
  const oruName = useOruName();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const ws = settings.webSearch ?? defaultWebSearch();

  const [adding, setAdding] = useState(false);

  // settings.update 是乐观更新——store 已立即反映新值；写函数必须从 store 即时读，
  // 不能依赖渲染时快照的 ws，否则连续操作会用陈旧 base 覆盖前一次乐观值。
  function currentWs(): WebSearchSettings {
    return useSettingsStore.getState().settings.webSearch ?? defaultWebSearch();
  }

  async function setEnabled(enabled: boolean) {
    await update({ webSearch: { ...currentWs(), enabled } });
  }
  async function setLongPageSummary(longPageSummary: boolean) {
    await update({ webSearch: { ...currentWs(), longPageSummary } });
  }
  async function addEngine(cfg: SearchEngineConfig) {
    const cur = currentWs();
    await update({ webSearch: { ...cur, engines: [...cur.engines, cfg] } });
    setAdding(false);
  }
  async function updateEngine(id: string, patch: Partial<SearchEngineConfig>) {
    const cur = currentWs();
    const next = cur.engines.map((e) => (e.id === id ? { ...e, ...patch } : e));
    await update({ webSearch: { ...cur, engines: next } });
  }
  async function removeEngine(id: string) {
    const cur = currentWs();
    await update({ webSearch: { ...cur, engines: cur.engines.filter((e) => e.id !== id) } });
  }
  async function removeUnsupportedEngine(id: string) {
    const cur = currentWs();
    await update({
      webSearch: {
        ...cur,
        unsupportedEngines: (cur.unsupportedEngines ?? []).filter((e) => e.id !== id),
      },
    });
  }
  async function moveEngine(id: string, dir: -1 | 1) {
    const cur = currentWs();
    const idx = cur.engines.findIndex((e) => e.id === id);
    if (idx < 0) return;
    const next = [...cur.engines];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    await update({ webSearch: { ...cur, engines: next } });
  }

  return (
    <>
      <SettingsRow
        label={t('webSearch.enable')}
        description={t('webSearch.enableDesc')}
        control={
          <Switch
            checked={ws.enabled}
            onChange={(next) => void setEnabled(next)}
            ariaLabel={t('webSearch.enable')}
          />
        }
      />

      {ws.enabled && (
        <>
          {ws.engines.length === 0 && (ws.unsupportedEngines ?? []).length === 0 ? (
            <div className="border-b border-border py-3 text-xs text-text-tertiary">
              {t('webSearch.enginesEmpty')}
            </div>
          ) : (
            ws.engines.map((eng, i) => (
              <EngineRow
                key={eng.id}
                engine={eng}
                canMoveUp={i > 0}
                canMoveDown={i < ws.engines.length - 1}
                onUpdate={(patch) => void updateEngine(eng.id, patch)}
                onRemove={() => void removeEngine(eng.id)}
                onMoveUp={() => void moveEngine(eng.id, -1)}
                onMoveDown={() => void moveEngine(eng.id, 1)}
              />
            ))
          )}

          {(ws.unsupportedEngines ?? []).map((eng) => (
            <UnsupportedEngineRow
              key={eng.id}
              engine={eng}
              onRemove={() => void removeUnsupportedEngine(eng.id)}
            />
          ))}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
            leftIcon={<Plus size={12} strokeWidth={1.5} />}
            className="mt-2 text-text-secondary"
          >
            {t('webSearch.addEngine')}
          </Button>

          <SettingsRow
            label={t('webSearch.longSummary')}
            description={t('webSearch.longSummaryDesc', { name: oruName })}
            control={
              <Switch
                checked={ws.longPageSummary}
                onChange={(next) => void setLongPageSummary(next)}
                ariaLabel={t('webSearch.longSummary')}
              />
            }
          />
        </>
      )}

      {adding && (
        <AddEngineDialog
          existingTypes={ws.engines.map((e) => e.type)}
          onCancel={() => setAdding(false)}
          onConfirm={(cfg) => void addEngine(cfg)}
        />
      )}
    </>
  );
}

// ─── 单引擎行 ────────────────────────────────────────────

function EngineRow({
  engine,
  canMoveUp,
  canMoveDown,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  engine: SearchEngineConfig;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onUpdate: (patch: Partial<SearchEngineConfig>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { t } = useTranslation('settings');
  const [keyDraft, setKeyDraft] = useState(engine.apiKey);
  const [editing, setEditing] = useState(engine.apiKey.length === 0);
  const [testing, setTesting] = useState(false);

  // 父层 engine.apiKey 变化时（settings.state 广播 / 多 tab 同步）同步本地 draft，
  // 避免编辑时把已被远端更新的 key 静默覆盖回旧值
  useEffect(() => {
    if (!editing) setKeyDraft(engine.apiKey);
  }, [engine.apiKey, editing]);

  async function onTest() {
    if (testing) return;
    setTesting(true);
    try {
      const res = await wsClient.request({
        type: 'webSearch.testEngine',
        engineType: engine.type,
        apiKey: editing ? keyDraft : engine.apiKey,
      });
      if (res.type === 'webSearch.test.result') {
        onUpdate({
          lastTestStatus: res.ok ? 'ok' : 'failed',
          lastTestError: res.message,
          lastTestAt: Date.now(),
        });
      }
    } finally {
      setTesting(false);
    }
  }

  async function onSaveKey() {
    onUpdate({ apiKey: keyDraft, lastTestStatus: 'unknown', lastTestError: undefined });
    setEditing(false);
  }

  const status = engine.lastTestStatus ?? 'unknown';

  // editing / testing 时按钮常驻——后者让 spinner 可见，否则会跟按钮一起淡出
  const toolCls = hoverToolsCls(editing || testing);

  return (
    <div className="group flex items-start gap-2 border-b border-border py-3 last:border-b-0">
      <div className={cn('flex flex-col gap-0.5 pt-0.5', toolCls)}>
        <button
          type="button"
          onClick={onMoveUp}
          disabled={!canMoveUp}
          className="text-text-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
          title={t('webSearch.moveUpTitle')}
        >
          <ArrowUp size={12} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={!canMoveDown}
          className="text-text-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
          title={t('webSearch.moveDownTitle')}
        >
          <ArrowDown size={12} strokeWidth={1.5} />
        </button>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-primary">{engineLabel(engine.type, t)}</span>
          <span className="text-xs text-text-tertiary">{engineHint(engine.type, t)}</span>
          <StatusBadge status={status} apiKeyEmpty={engine.apiKey.length === 0} error={engine.lastTestError} />
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          {editing ? (
            <>
              <input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="API Key"
                className="flex-1 rounded border border-border bg-canvas px-2 py-0.5 text-xs"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onSaveKey()}
                disabled={keyDraft.trim().length === 0}
              >
                {t('common:save')}
              </Button>
              {engine.apiKey ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setKeyDraft(engine.apiKey);
                    setEditing(false);
                  }}
                  className="text-text-tertiary"
                >
                  {t('common:cancel')}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <span className="flex-1 truncate text-xs text-text-tertiary">
                {engine.apiKey
                  ? `${'•'.repeat(8)}${engine.apiKey.slice(-4)}`
                  : t('webSearch.notConfigured')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                leftIcon={<Edit3 size={12} strokeWidth={1.5} />}
                className={cn('text-text-secondary', toolCls)}
                title={t('webSearch.edit')}
              >
                {t('webSearch.edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onTest()}
                disabled={testing || engine.apiKey.length === 0}
                leftIcon={
                  testing ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} strokeWidth={1.5} />
                  )
                }
                className={cn('text-text-secondary', toolCls)}
                title={t('webSearch.testTitle')}
              >
                {t('webSearch.test')}
              </Button>
            </>
          )}
          <a
            href={ENGINE_KEY_URL[engine.type]}
            target="_blank"
            rel="noopener noreferrer"
            className="whitespace-nowrap text-xs text-accent hover:underline"
          >
            {engineKeyApply(engine.type, t)} ↗
          </a>
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className={cn('mt-1 text-text-tertiary hover:text-danger', toolCls)}
        title={t('webSearch.removeEngineTitle')}
      >
        <Trash2 size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

/** 反序列化容错剔除的未知引擎条目——灰化展示原始 type，只留删除一个动作 */
function UnsupportedEngineRow({
  engine,
  onRemove,
}: {
  engine: UnsupportedEngineConfig;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex items-center gap-2 border-b border-border py-3 opacity-60 last:border-b-0">
      <div className="min-w-0 flex-1">
        {/* 原始 type 是数据哨兵（本版本没有它的译名），不翻 */}
        <span className="text-sm text-text-tertiary">{engine.type}</span>
        <span className="ml-2 text-xs text-text-tertiary">{t('webSearch.unsupportedHint')}</span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="text-text-tertiary hover:text-danger"
        title={t('webSearch.removeEngineTitle')}
      >
        <Trash2 size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function StatusBadge({
  status,
  apiKeyEmpty,
  error,
}: {
  status: 'ok' | 'failed' | 'unknown';
  apiKeyEmpty: boolean;
  error?: string;
}) {
  const { t } = useTranslation('settings');
  if (apiKeyEmpty) {
    return <span className="text-xs text-text-tertiary">{t('webSearch.badgeNotConfigured')}</span>;
  }
  if (status === 'ok') {
    return <span className="text-xs text-success">{t('webSearch.badgeConnected')}</span>;
  }
  if (status === 'failed') {
    return (
      <span className="text-xs text-danger" title={error}>
        {t('webSearch.badgeFailed')}
      </span>
    );
  }
  return <span className="text-xs text-text-tertiary">{t('webSearch.badgeNotTested')}</span>;
}

// ─── 添加引擎对话框 ──────────────────────────────────────────

function AddEngineDialog({
  existingTypes,
  onCancel,
  onConfirm,
}: {
  existingTypes: SearchEngineType[];
  onCancel: () => void;
  onConfirm: (cfg: SearchEngineConfig) => void;
}) {
  const { t } = useTranslation('settings');
  const [type, setType] = useState<SearchEngineType>('bocha');
  const [apiKey, setApiKey] = useState('');
  const [testStatus, setTestStatus] = useState<'unknown' | 'ok' | 'failed'>('unknown');
  const [testError, setTestError] = useState<string | undefined>();
  const [testing, setTesting] = useState(false);

  const duplicated = existingTypes.includes(type);

  async function onTest() {
    if (testing || apiKey.trim().length === 0) return;
    setTesting(true);
    try {
      const res = await wsClient.request({
        type: 'webSearch.testEngine',
        engineType: type,
        apiKey,
      });
      if (res.type === 'webSearch.test.result') {
        setTestStatus(res.ok ? 'ok' : 'failed');
        setTestError(res.message);
      }
    } finally {
      setTesting(false);
    }
  }

  function onSave() {
    onConfirm({
      id: makeId(),
      type,
      apiKey,
      lastTestStatus: testStatus === 'unknown' ? 'unknown' : testStatus,
      lastTestError: testError,
      lastTestAt: testStatus !== 'unknown' ? Date.now() : undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[420px] rounded-lg border border-border bg-canvas p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-medium">{t('webSearch.dialogTitle')}</h4>
          <button
            type="button"
            onClick={onCancel}
            className="text-text-tertiary hover:text-text-primary"
          >
            <XIcon size={14} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-text-tertiary">{t('webSearch.typeLabel')}</label>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value as SearchEngineType);
                setTestStatus('unknown');
                setTestError(undefined);
              }}
              className="w-full rounded border border-border bg-elevated px-2 py-1 text-sm"
            >
              {ALL_ENGINE_TYPES.map((et) => (
                <option key={et} value={et}>
                  {engineLabel(et, t)} — {engineHint(et, t)}
                </option>
              ))}
            </select>
            {duplicated ? (
              <div className="mt-1 text-xs text-warn">
                {t('webSearch.duplicated')}
              </div>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-xs text-text-tertiary">
              API Key
              <a
                href={ENGINE_KEY_URL[type]}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-accent hover:underline"
              >
                {engineKeyApply(type, t)} ↗
              </a>
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTestStatus('unknown');
                setTestError(undefined);
              }}
              placeholder={t('webSearch.apiKeyPlaceholder')}
              className="w-full rounded border border-border bg-elevated px-2 py-1 text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onTest()}
              disabled={testing || apiKey.trim().length === 0}
              leftIcon={
                testing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} strokeWidth={1.5} />
                )
              }
              className="text-text-secondary"
            >
              {t('webSearch.testConn')}
            </Button>
            <span className="text-xs">
              {t('webSearch.statusPrefix')}
              {testStatus === 'unknown' && (
                <span className="text-text-tertiary">{t('webSearch.statusNotTested')}</span>
              )}
              {testStatus === 'ok' && <span className="text-success">{t('webSearch.statusOk')}</span>}
              {testStatus === 'failed' && (
                <span className="text-danger" title={testError}>
                  {t('webSearch.statusFailedWith', { error: testError ?? t('webSearch.unknownError') })}
                </span>
              )}
            </span>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} className="text-text-tertiary">
            {t('common:cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={apiKey.trim().length === 0}
          >
            {t('common:save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
