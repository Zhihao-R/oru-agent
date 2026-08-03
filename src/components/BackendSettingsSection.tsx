/**
 * Settings ▸ 模型
 *
 * 三 section：供应商 / 模型 / 功能分配。
 * 走统一的 SettingsSection + SettingsRow 范式；底层 *Row form panel 保留。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOruName } from '@/lib/oruName';
import type { TFunction } from 'i18next';
import { Edit3, Trash2, RefreshCw, Save, X as XIcon, Loader2, Plus, Lightbulb } from 'lucide-react';
import { wsClient } from '@/lib/ws';
import {
  LLM_USAGES,
  defaultModelThinking,
  type BackendProvider,
  type BackendProviderType,
  type LlmUsage,
  type ModelAssignment,
  type ModelThinking,
  type RegisteredModel,
} from '@shared/types';
import {
  LOCAL_CLAUDE_MODELS,
  localClaudeAssignment,
  parseLocalClaudeAssignment,
} from '@shared/agent/localClaudeModels';
import {
  CODING_PLAN_DEFAULT_ENDPOINT,
  isCodingPlanType,
} from '@shared/agent/codingPlanEndpoints';
import { SettingsSection } from '@/components/settings/ui/SettingsSection';
import { hoverToolsCls } from '@/components/settings/ui/hoverTools';
import { useSettingsStore } from '@/stores/settingsStore';
import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/** 全部 provider 类型（select 选项用）；展示 label 经 settings ns 翻译。 */
const PROVIDER_TYPES: BackendProviderType[] = [
  'anthropic',
  'openrouter',
  'openai',
  'zhipu',
  'kimi',
  'custom-openai',
  'glm-coding',
  'kimi-coding',
  'minimax-coding',
];

/** BackendProviderType → 展示 label，t 由调用方按 settings ns 绑定传入。 */
function providerTypeLabel(type: BackendProviderType, t: TFunction): string {
  return t(`backend.providerType.${type}`);
}

/** LlmUsage → 展示 label，t 由调用方按 settings ns 绑定传入。twinMain/twinBackground 接个体名 name。 */
function usageLabel(usage: LlmUsage, name: string, t: TFunction): string {
  return t(`backend.usage.${usage}`, { name });
}

/**
 * 显示 baseUrl 字段的类型（三态）：
 * - custom-openai：必填（placeholder 提示必填）
 * - openrouter / openai：可覆盖，留空用默认（placeholder 通用提示）
 * - 三家 coding plan：可覆盖，placeholder 预填默认大陆端点（海外用户改这里）
 * 其余（anthropic / zhipu / kimi）：不显示，用固定端点。
 */
const SHOWS_BASE_URL: BackendProviderType[] = [
  'openrouter',
  'openai',
  'custom-openai',
  'glm-coding',
  'kimi-coding',
  'minimax-coding',
];

/** baseUrl 输入框 placeholder：coding plan 预填默认端点，custom-openai 提示必填，其余通用默认提示。 */
function baseUrlPlaceholder(type: BackendProviderType, t: TFunction): string {
  if (isCodingPlanType(type)) return CODING_PLAN_DEFAULT_ENDPOINT[type];
  if (type === 'custom-openai') return t('backend.baseUrlRequiredPlaceholder');
  return t('backend.baseUrlDefaultPlaceholder');
}

export function BackendSettingsSection() {
  const [providers, setProviders] = useState<BackendProvider[]>([]);
  const [models, setModels] = useState<RegisteredModel[]>([]);
  const [assignments, setAssignments] = useState<ModelAssignment>({
    twinMain: null,
    twinBackground: null,
    memoryDream: null,
    subagentCoder: null,
    conversationSummary: null,
    conversationTitle: null,
    twinSubagent: null,
    asideComment: null,
    loopReviewer: null,
    memoryRecall: null,
    scheduledRun: null,
    loopCompile: null,
  });
  const [modelThinking, setModelThinkingState] = useState<ModelThinking>(() => defaultModelThinking());

  useEffect(() => {
    void (async () => {
      try {
        const [p, m, s] = await Promise.all([
          wsClient.request({ type: 'providers.list' }),
          wsClient.request({ type: 'models.list' }),
          wsClient.request({ type: 'settings.get' }),
        ]);
        if (p.type === 'providers.state') setProviders(p.providers);
        if (m.type === 'models.state') setModels(m.models);
        if (s.type === 'settings.state') {
          setAssignments(s.settings.modelAssignments);
          setModelThinkingState({ ...defaultModelThinking(), ...(s.settings.modelThinking ?? {}) });
        }
      } catch {
        // 忽略 WS 未连接
      }
    })();
  }, []);

  useEffect(() => {
    return wsClient.subscribe((ev) => {
      if (ev.type === 'providers.state') setProviders(ev.providers);
      else if (ev.type === 'models.state') setModels(ev.models);
      else if (ev.type === 'modelAssignments.state') setAssignments(ev.assignments);
      else if (ev.type === 'settings.state') {
        setAssignments(ev.settings.modelAssignments);
        setModelThinkingState({ ...defaultModelThinking(), ...(ev.settings.modelThinking ?? {}) });
      }
    });
  }, []);

  return (
    <>
      <ProvidersSection providers={providers} />
      <ModelsSection providers={providers} models={models} />
      <AssignmentsSection
        providers={providers}
        models={models}
        assignments={assignments}
        modelThinking={modelThinking}
        onModelThinkingChange={(usage, thinking) => {
          // 乐观翻转本地显示 + 走 store 落盘（store 自带乐观写 + settings.state 回写权威值）
          setModelThinkingState((prev) => ({ ...prev, [usage]: thinking }));
          void useSettingsStore.getState().setModelThinking(usage, thinking);
        }}
      />
    </>
  );
}

// ─── 供应商 ─────────────────────────────────────────────

function ProvidersSection({ providers }: { providers: BackendProvider[] }) {
  const { t } = useTranslation('settings');
  const [adding, setAdding] = useState(false);

  return (
    <SettingsSection
      title={t('backend.providers')}
      trailing={
        !adding ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
            leftIcon={<Plus size={12} strokeWidth={1.5} />}
            className="text-text-secondary"
          >
            {t('backend.add')}
          </Button>
        ) : null
      }
    >
      {providers.length === 0 && !adding ? (
        <div className="border-b border-border py-3 text-xs text-text-tertiary">
          {t('backend.providersEmpty')}
        </div>
      ) : null}
      <div className="flex flex-col">
        {providers.map((p) => (
          <ProviderRow key={p.id} provider={p} />
        ))}
        {adding ? (
          <div className="border-b border-border py-3 last:border-b-0">
            <ProviderAddForm onDone={() => setAdding(false)} />
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function ProviderRow({ provider }: { provider: BackendProvider }) {
  const { t } = useTranslation('settings');
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await wsClient.request({ type: 'providers.test', id: provider.id });
      if (r.type === 'provider.test.result') {
        setTestResult({ ok: r.ok, message: r.message });
      }
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const onRemove = async () => {
    if (!confirm(t('backend.removeProviderConfirm', { label: provider.label }))) return;
    try {
      await wsClient.request({ type: 'providers.remove', id: provider.id });
    } catch {
      alert(t('backend.removeFailed'));
    }
  };

  if (editing) {
    return (
      <div className="border-b border-border py-3 last:border-b-0">
        <ProviderEditForm provider={provider} onDone={() => setEditing(false)} />
      </div>
    );
  }

  const toolCls = hoverToolsCls(testing);

  return (
    <div className="group flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-primary">{provider.label}</span>
          <span className="text-xs text-text-tertiary">{providerTypeLabel(provider.type, t)}</span>
          {testResult ? (
            <span
              className={`text-xs ${testResult.ok ? 'text-success' : 'text-danger'}`}
              title={testResult.message}
            >
              {testResult.ok ? t('backend.connected') : t('backend.failed')}
            </span>
          ) : null}
        </div>
        {provider.baseUrl ? (
          <div className="mt-0.5 truncate font-mono text-xs text-text-tertiary">{provider.baseUrl}</div>
        ) : null}
        {testResult && !testResult.ok ? (
          <div className="mt-0.5 truncate text-xs text-danger">{testResult.message}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onTest}
          disabled={testing}
          leftIcon={
            testing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} strokeWidth={1.5} />
            )
          }
          className={cn('text-text-secondary', toolCls)}
          title={t('backend.testTitle')}
        >
          {t('backend.test')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditing(true)}
          leftIcon={<Edit3 size={12} strokeWidth={1.5} />}
          className={cn('text-text-secondary', toolCls)}
          title={t('backend.edit')}
        >
          {t('backend.edit')}
        </Button>
        <button
          type="button"
          onClick={onRemove}
          className={cn('ml-1 text-text-tertiary hover:text-danger', toolCls)}
          title={t('common:delete')}
        >
          <Trash2 size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

function ProviderAddForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('settings');
  const [type, setType] = useState<BackendProviderType>('anthropic');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    if (!apiKey.trim()) {
      alert(t('backend.apiKeyEmpty'));
      return;
    }
    setSubmitting(true);
    try {
      await wsClient.request({
        type: 'providers.add',
        provider: {
          type,
          label: label.trim() || providerTypeLabel(type, t),
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
        },
      });
      onDone();
    } catch (e) {
      alert(t('backend.addFailedWith', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent bg-elevated p-2.5">
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as BackendProviderType)}
          className="rounded border border-border bg-canvas px-2 py-1 text-xs text-text-primary"
        >
          {PROVIDER_TYPES.map((pt) => (
            <option key={pt} value={pt}>
              {providerTypeLabel(pt, t)}
            </option>
          ))}
        </select>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('backend.labelPlaceholder')}
          className="flex-1 rounded border border-border bg-canvas px-2 py-1 text-xs text-text-primary"
        />
      </div>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="API Key"
        className="rounded border border-border bg-canvas px-2 py-1 font-mono text-xs text-text-primary"
      />
      {SHOWS_BASE_URL.includes(type) ? (
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={baseUrlPlaceholder(type, t)}
          className="rounded border border-border bg-canvas px-2 py-1 font-mono text-xs text-text-primary"
        />
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} className="text-text-tertiary">
          {t('common:cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={onSubmit} disabled={submitting}>
          {submitting ? t('backend.adding') : t('backend.add')}
        </Button>
      </div>
    </div>
  );
}

function ProviderEditForm({ provider, onDone }: { provider: BackendProvider; onDone: () => void }) {
  const { t } = useTranslation('settings');
  const [label, setLabel] = useState(provider.label);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [submitting, setSubmitting] = useState(false);

  const onSave = async () => {
    setSubmitting(true);
    try {
      const patch: Partial<Pick<BackendProvider, 'label' | 'apiKey' | 'baseUrl'>> = {};
      if (label.trim() && label !== provider.label) patch.label = label.trim();
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      if (baseUrl.trim() !== (provider.baseUrl ?? '')) {
        patch.baseUrl = baseUrl.trim() || undefined;
      }
      await wsClient.request({ type: 'providers.update', id: provider.id, patch });
      onDone();
    } catch (e) {
      alert(t('backend.saveFailedWith', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent bg-elevated p-2.5">
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('backend.displayName')}
        className="rounded border border-border bg-canvas px-2 py-1 text-xs text-text-primary"
      />
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={t('backend.newApiKeyPlaceholder')}
        className="rounded border border-border bg-canvas px-2 py-1 font-mono text-xs text-text-primary"
      />
      {SHOWS_BASE_URL.includes(provider.type) ? (
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={baseUrlPlaceholder(provider.type, t)}
          className="rounded border border-border bg-canvas px-2 py-1 font-mono text-xs text-text-primary"
        />
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} className="text-text-tertiary">
          {t('common:cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onSave}
          disabled={submitting}
          leftIcon={<Save size={12} strokeWidth={1.5} />}
        >
          {submitting ? t('common:saving') : t('common:save')}
        </Button>
      </div>
    </div>
  );
}

// ─── 模型 ───────────────────────────────────────────────

function ModelsSection({
  providers,
  models,
}: {
  providers: BackendProvider[];
  models: RegisteredModel[];
}) {
  const { t } = useTranslation('settings');
  const grouped = useMemo(() => {
    const m = new Map<string, RegisteredModel[]>();
    for (const md of models) {
      const arr = m.get(md.providerId) ?? [];
      arr.push(md);
      m.set(md.providerId, arr);
    }
    return m;
  }, [models]);

  if (providers.length === 0) return null;

  return (
    <SettingsSection title={t('backend.models')}>
      <div className="flex flex-col gap-5">
        {providers.map((p) => (
          <ProviderModelGroup key={p.id} provider={p} models={grouped.get(p.id) ?? []} />
        ))}
      </div>
    </SettingsSection>
  );
}

function ProviderModelGroup({
  provider,
  models,
}: {
  provider: BackendProvider;
  models: RegisteredModel[];
}) {
  const { t } = useTranslation('settings');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingCustom, setAddingCustom] = useState(false);

  const onRemove = async (id: string) => {
    try {
      await wsClient.request({ type: 'models.remove', id });
    } catch {
      alert(t('backend.removeFailed'));
    }
  };

  return (
    <div>
      <div className="mb-1 text-xs text-text-tertiary">{provider.label}</div>
      <div className="flex flex-col">
        {models.map((m) =>
          editingId === m.id ? (
            <div key={m.id} className="border-b border-border py-3 last:border-b-0">
              <ModelEditForm
                providerId={provider.id}
                providerType={provider.type}
                existing={m}
                onDone={() => setEditingId(null)}
              />
            </div>
          ) : (
            <ModelDisplayRow
              key={m.id}
              model={m}
              onEdit={() => setEditingId(m.id)}
              onRemove={() => onRemove(m.id)}
            />
          ),
        )}
        {addingCustom ? (
          <div className="border-b border-border py-3 last:border-b-0">
            <ModelEditForm
              providerId={provider.id}
              providerType={provider.type}
              existing={null}
              onDone={() => setAddingCustom(false)}
            />
          </div>
        ) : null}
      </div>
      {!addingCustom ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAddingCustom(true)}
          leftIcon={<Plus size={12} strokeWidth={1.5} />}
          className="mt-2 text-text-secondary"
        >
          {t('backend.customModel')}
        </Button>
      ) : null}
    </div>
  );
}

function ModelDisplayRow({
  model,
  onEdit,
  onRemove,
}: {
  model: RegisteredModel;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const missing = model.contextWindow == null || model.supportsVision == null;
  const toolCls = hoverToolsCls(false);
  return (
    <div className="group flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-primary">{model.label}</span>
          <span className="font-mono text-xs text-text-tertiary">{model.modelId}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-text-tertiary">
          <span title={t('backend.contextWindow')}>{t('backend.contextPrefix')} {formatWindow(model.contextWindow)}</span>
          <span title={t('backend.visionTitle')}>{t('backend.visionPrefix')} {formatBool(model.supportsVision)}</span>
          {missing ? (
            <span className="text-warn" title={t('backend.missingTitle')}>
              {t('backend.missing')}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          leftIcon={<Edit3 size={12} strokeWidth={1.5} />}
          className={cn('text-text-secondary', toolCls)}
          title={t('backend.edit')}
        >
          {t('backend.edit')}
        </Button>
        <button
          type="button"
          onClick={onRemove}
          className={cn('ml-1 text-text-tertiary hover:text-danger', toolCls)}
          title={t('common:delete')}
        >
          <XIcon size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

/**
 * 模型添加 / 编辑表单。
 * - existing=null：新建模式，modelId 可填
 * - existing=RegisteredModel：编辑模式，modelId 只读（要换 model 请删重加）
 *
 * 主面强制：contextWindow ≥ 1024、supportsVision 必选；详细参数默认折叠
 */
function ModelEditForm({
  providerId,
  providerType,
  existing,
  onDone,
}: {
  providerId: string;
  providerType: BackendProviderType;
  existing: RegisteredModel | null;
  onDone: () => void;
}) {
  const { t } = useTranslation('settings');
  const [modelId, setModelId] = useState(existing?.modelId ?? '');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [contextWindow, setContextWindow] = useState<string>(
    existing?.contextWindow != null ? String(existing.contextWindow) : '',
  );
  // 改 radio 为 Switch 后简化为 boolean；旧记录没存 (=== null) 默认 false（不支持），
  // 用户主动开才记为支持。
  const [supportsVision, setSupportsVision] = useState<boolean>(
    existing?.supportsVision === true,
  );
  const [showDetail, setShowDetail] = useState(false);
  const [maxOutputTokens, setMaxOutputTokens] = useState<string>(
    existing?.maxOutputTokens != null ? String(existing.maxOutputTokens) : '',
  );
  const [supportsPromptCache, setSupportsPromptCache] = useState<boolean>(
    existing?.supportsPromptCache === true,
  );
  const [supportsReasoning, setSupportsReasoning] = useState<boolean>(
    existing?.supportsReasoning === true,
  );
  const [reasoningEffort, setReasoningEffort] = useState<
    'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  >(existing?.reasoningEffort ?? 'medium');
  const [submitting, setSubmitting] = useState(false);

  const ctx = Number.parseInt(contextWindow, 10);
  const maxOut = maxOutputTokens.trim() ? Number.parseInt(maxOutputTokens, 10) : null;
  const ctxValid = Number.isInteger(ctx) && ctx >= 1024;
  const modelIdValid = existing != null || modelId.trim().length > 0;
  const labelValid = label.trim().length > 0 || modelId.trim().length > 0;
  const maxOutValid =
    maxOut == null || (Number.isInteger(maxOut) && maxOut > 0 && (!ctxValid || maxOut <= ctx));
  const canSave = ctxValid && modelIdValid && labelValid && maxOutValid && !submitting;

  const onSave = async () => {
    if (!canSave) return;
    setSubmitting(true);
    try {
      if (existing) {
        const patch: Record<string, unknown> = {};
        if (label.trim() !== existing.label) patch.label = label.trim();
        if (ctx !== existing.contextWindow) patch.contextWindow = ctx;
        // 老记录 supportsVision 可能是 undefined（"未填"）—— 改 Switch 后默认值就是 false，
        // 用 ?? false 做基准比较，避免点开未修改也回写 false 把"未填"静默改成"明确不支持"
        if (supportsVision !== (existing.supportsVision ?? false)) {
          patch.supportsVision = supportsVision;
        }
        if (maxOut !== (existing.maxOutputTokens ?? null)) {
          patch.maxOutputTokens = maxOut ?? undefined;
        }
        if (supportsPromptCache !== (existing.supportsPromptCache ?? false)) {
          patch.supportsPromptCache = supportsPromptCache;
        }
        if (supportsReasoning !== (existing.supportsReasoning ?? false)) {
          patch.supportsReasoning = supportsReasoning;
        }
        // effort 是偏好（不是能力）——独立持久化，不被 supportsReasoning / providerType 闸住，
        // 这样关掉再开启思考模式不丢用户偏好。运行时 backend 用 supportsReasoning 决定是否注入
        if (reasoningEffort !== (existing.reasoningEffort ?? 'medium')) {
          patch.reasoningEffort = reasoningEffort;
        }
        await wsClient.request({ type: 'models.update', id: existing.id, patch });
      } else {
        await wsClient.request({
          type: 'models.add',
          model: {
            providerId,
            modelId: modelId.trim(),
            label: label.trim() || modelId.trim(),
            contextWindow: ctx,
            supportsVision,
            maxOutputTokens: maxOut ?? undefined,
            supportsPromptCache,
            supportsReasoning,
            reasoningEffort,
          },
        });
      }
      onDone();
    } catch (e) {
      alert(t('backend.saveFailedWith', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent bg-elevated p-2.5">
      <div className="flex items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('backend.modelLabelPlaceholder')}
          className="flex-1 rounded border border-border bg-canvas px-2 py-1 text-xs text-text-primary"
        />
        <input
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder={t('backend.modelIdPlaceholder')}
          disabled={existing != null}
          className="flex-1 rounded border border-border bg-canvas px-2 py-1 font-mono text-xs text-text-primary disabled:opacity-60"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1 text-xs text-text-secondary">
          {t('backend.contextWindow')}
          <input
            value={contextWindow}
            onChange={(e) => setContextWindow(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder={t('backend.contextWindowPlaceholder')}
            className="w-24 rounded border border-border bg-canvas px-2 py-0.5 font-mono text-xs text-text-primary"
          />
          <span className="text-text-tertiary">token</span>
          <span className="text-danger">*</span>
        </label>

        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <Switch
            checked={supportsVision}
            onChange={setSupportsVision}
            ariaLabel={t('backend.supportsVision')}
          />
          {t('backend.supportsVision')}
        </label>
      </div>

      <button
        type="button"
        onClick={() => setShowDetail((v) => !v)}
        className="self-start text-xs text-text-tertiary hover:text-text-secondary"
      >
        {showDetail ? '▾' : '▸'} {t('backend.detailParams')}
      </button>
      {showDetail ? (
        <div className="flex flex-col gap-2 rounded border border-border bg-canvas/40 p-2">
          <label className="flex items-center gap-1 text-xs text-text-secondary">
            {t('backend.maxOutput')}
            <input
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={t('backend.maxOutputPlaceholder')}
              className="w-32 rounded border border-border bg-canvas px-2 py-0.5 font-mono text-xs text-text-primary"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <Switch
              checked={supportsPromptCache}
              onChange={setSupportsPromptCache}
              ariaLabel={t('backend.supportsPromptCache')}
            />
            {t('backend.supportsPromptCache')}
          </label>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <Switch
              checked={supportsReasoning}
              onChange={setSupportsReasoning}
              ariaLabel={t('backend.supportsReasoningAria')}
            />
            {t('backend.supportsReasoning')}
          </label>
          {providerType === 'openrouter' && supportsReasoning ? (
            <label className="ml-5 flex items-center gap-1 text-xs text-text-secondary">
              {t('backend.reasoningEffort')}
              <select
                value={reasoningEffort}
                onChange={(e) =>
                  setReasoningEffort(
                    e.target.value as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
                  )
                }
                className="rounded border border-border bg-canvas px-1 py-0.5 text-xs text-text-primary"
              >
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
              <span className="text-text-tertiary">
                {t('backend.reasoningEffortHint')}
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-danger">
          {!ctxValid && contextWindow ? t('backend.ctxInvalid') : ''}
          {!maxOutValid ? t('backend.maxOutInvalid') : ''}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDone} className="text-text-tertiary">
            {t('common:cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={!canSave}
            leftIcon={<Save size={12} strokeWidth={1.5} />}
          >
            {submitting ? t('common:saving') : t('common:save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatWindow(w: number | undefined): string {
  if (!w) return '?';
  if (w >= 1_000_000) return `${(w / 1_000_000).toFixed(0)}M`;
  if (w >= 1_000) return `${(w / 1_000).toFixed(0)}k`;
  return `${w}`;
}

function formatBool(v: boolean | undefined): string {
  if (v === true) return '✓';
  if (v === false) return '—';
  return '?';
}

// ─── 功能分配 ───────────────────────────────────────────

function AssignmentsSection({
  providers,
  models,
  assignments,
  modelThinking,
  onModelThinkingChange,
}: {
  providers: BackendProvider[];
  models: RegisteredModel[];
  assignments: ModelAssignment;
  modelThinking: ModelThinking;
  onModelThinkingChange: (usage: LlmUsage, thinking: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const oruName = useOruName();
  const providerById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);

  const onChange = async (usage: LlmUsage, modelId: string | null) => {
    // v0.3：切到无视觉模型时弹降级提示。
    // 仅 twinMain 弹——只有它直接消费用户输入的图，用户能感知"切完图变占位文字"；
    // twinBackground / memoryDream / conversationSummary 都是后台用途，用户不直接看到效果，
    // 不在 UI 上打扰。subagentCoder 完全不读历史。
    if (usage === 'twinMain' && needsDowngradeConfirm(modelId)) {
      const target = modelId ? models.find((m) => m.id === modelId) : null;
      const targetLabel = target ? target.label : t('backend.currentModel');
      const ok = window.confirm(t('backend.visionDowngradeConfirm', { label: targetLabel }));
      if (!ok) return;
    }
    try {
      await wsClient.request({ type: 'modelAssignments.update', usage, modelId });
    } catch {
      alert(t('backend.saveFailed'));
    }
  };

  function needsDowngradeConfirm(modelId: string | null): boolean {
    if (!modelId) return false;
    const model = models.find((m) => m.id === modelId);
    if (!model) return false;
    return model.supportsVision !== true;
  }

  // 当前行选到的模型是否支持思考（Track B）：未分配 / 本地 Claude = 支持；
  // 只有显式分配了 supportsReasoning!==true 的注册模型才不支持 → 思考开关隐藏/置灰。
  function rowSupportsReasoning(usage: LlmUsage): boolean {
    const id = assignments[usage];
    if (!id) return true;
    if (parseLocalClaudeAssignment(id)) return true;
    return models.find((m) => m.id === id)?.supportsReasoning === true;
  }

  return (
    <SettingsSection title={t('backend.assignments')}>
      <div className="flex flex-col">
        {LLM_USAGES
          .filter((u) => u !== 'twinSubagent') // 跟随 twinMain，UI 不暴露独立选项
          .map((usage) => {
            // 每用途思考开关（Track B）：点亮=该用途先思考再回应。默认分档（干活/对话类开、
            // 廉价判断类关）由 defaultModelThinking 提供；思考文字不展示，过程只给「思考中」状态。
            // 仅当前选到 supportsReasoning 的模型时可用（否则开了也没用，置灰）。
            const supports = rowSupportsReasoning(usage);
            const thinking = modelThinking[usage] ?? defaultModelThinking()[usage];
            return (
              <div
                key={usage}
                className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1 text-sm text-text-primary">
                  {usageLabel(usage, oruName, t)}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => supports && onModelThinkingChange(usage, !thinking)}
                    title={supports ? t('backend.thinkTitle') : t('backend.thinkDisabledTitle')}
                    aria-label={t('backend.thinkAria')}
                    aria-pressed={thinking}
                    disabled={!supports}
                    className={cn(
                      'group flex h-7 items-center justify-center rounded-md px-1 transition-colors',
                      thinking ? 'text-accent' : 'text-text-tertiary hover:text-text-secondary',
                      !supports && 'cursor-not-allowed opacity-40',
                    )}
                  >
                    <Lightbulb size={16} className={thinking ? 'fill-current' : undefined} />
                    {/* 平时只留灯泡；hover 滑出「思考」二字点明它是开关，title 给完整说明 */}
                    <span className="max-w-0 overflow-hidden whitespace-nowrap text-xs opacity-0 transition-all duration-200 group-hover:ml-1 group-hover:max-w-[3rem] group-hover:opacity-100">
                      {t('backend.think')}
                    </span>
                  </button>
                  <select
                    value={assignments[usage] ?? ''}
                    onChange={(e) => onChange(usage, e.target.value || null)}
                    className="min-w-[200px] rounded-md border border-border bg-elevated px-2 py-1 text-xs text-text-primary disabled:opacity-50"
                  >
                    <option value="">
                      {usage === 'conversationTitle'
                        ? t('backend.noAutoName')
                        : t('backend.defaultLocalClaude')}
                    </option>
                    <optgroup label={t('backend.localClaudeGroup')}>
                      {LOCAL_CLAUDE_MODELS.map((m) => (
                        <option key={m.sdkModel} value={localClaudeAssignment(m.sdkModel)}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                    {models.map((m) => {
                      const p = providerById.get(m.providerId);
                      return (
                        <option key={m.id} value={m.id}>
                          {p?.label ?? '?'} / {m.label}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>
            );
          })}
      </div>
    </SettingsSection>
  );
}
