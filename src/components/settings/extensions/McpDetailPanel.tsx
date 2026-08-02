/**
 * MCP 详情侧栏（v0.6）—— 沿用任务板 TaskDetailPanel 范式：
 *   border-l + bg-elevated + 顶部 Toolbar（删除 / 关闭）+ scrollable body
 *
 * 可编辑字段（受本地 staging 控制，不被外部 runtime 状态冲）：
 *   label / description / command / args[] / env{} / probeTool / enabled
 * 只读字段（永远显示最新 runtime）：
 *   lastStatus / lastError / lastStderr / toolCount
 *
 * 关键交互：
 * - title / description 是 inline 编辑（Enter 提交、Esc 取消、blur 提交）
 * - command / args / env / probeTool 修改 → staging.dirty → 启用"保存"按钮
 * - 关闭面板时 dirty 弹 DeleteConfirm 风格 dialog 提示"丢弃未保存修改"
 * - 测试连接：5s 固定停留 + running 中 disabled
 * - 工具 chip 点击展开 description（懒加载 mcp.listTools）
 * - stderr 节选展开后 max-height 200px 独立滚动
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Trash2, X, Loader2, Eye, EyeOff, RefreshCw } from 'lucide-react';
import type { McpServerConfig, McpServerStatus } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { DeleteConfirm } from '@/components/ui/DeleteConfirm';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMcpRuntimeStore, type McpRuntime } from '@/stores/mcpRuntimeStore';
import { McpToggle } from './McpToggle';
import { cn } from '@/lib/cn';

type StagingDraft = Pick<
  McpServerConfig,
  'label' | 'description' | 'command' | 'args' | 'env' | 'probeTool'
>;

type DraftKey = keyof StagingDraft;

function statusColor(s: McpServerStatus, enabled: boolean): string {
  if (!enabled) return 'text-text-quaternary';
  if (s === 'connected_ready' || s === 'connected') return 'text-success';
  if (s === 'probe_failed') return 'text-warn';
  if (s === 'failed') return 'text-danger';
  // starting / reconnecting / idle 等过渡或未连态都落静默色
  return 'text-text-quaternary';
}

function makeDraft(cfg: McpServerConfig): StagingDraft {
  return {
    label: cfg.label,
    description: cfg.description,
    command: cfg.command,
    args: [...cfg.args],
    env: { ...(cfg.env ?? {}) },
    probeTool: cfg.probeTool,
  };
}

function isDirty(staging: StagingDraft, cfg: McpServerConfig): boolean {
  if (staging.label !== cfg.label) return true;
  if ((staging.description ?? '') !== (cfg.description ?? '')) return true;
  if (staging.command !== cfg.command) return true;
  if (staging.probeTool !== cfg.probeTool) return true;
  if (staging.args.length !== cfg.args.length) return true;
  for (let i = 0; i < staging.args.length; i++) {
    if (staging.args[i] !== cfg.args[i]) return true;
  }
  const stagingEnv = staging.env ?? {};
  const cfgEnv = cfg.env ?? {};
  const k1 = Object.keys(stagingEnv);
  const k2 = Object.keys(cfgEnv);
  if (k1.length !== k2.length) return true;
  for (const k of k1) if (stagingEnv[k] !== cfgEnv[k]) return true;
  return false;
}

export type McpDetailPanelProps = {
  serverId: string;
  onClose: () => void;
};

/** 父级可以通过 ref.requestClose() 触发关闭——内部会判 dirty 决定弹 Dialog 还是直接 onClose */
export type McpDetailPanelHandle = {
  requestClose: () => void;
};

export const McpDetailPanel = forwardRef<McpDetailPanelHandle, McpDetailPanelProps>(
  function McpDetailPanel({ serverId, onClose }, ref) {
  const { t } = useTranslation('settings');
  const cfg = useSettingsStore((s) =>
    (s.settings.mcpServers ?? []).find((m) => m.id === serverId),
  );
  const runtime = useMcpRuntimeStore((s) => s.byId[serverId]);
  const upsertRuntime = useMcpRuntimeStore((s) => s.upsert);
  const removeRuntime = useMcpRuntimeStore((s) => s.remove);
  const markReconnecting = useMcpRuntimeStore((s) => s.markReconnecting);


  const [staging, setStaging] = useState<StagingDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const [expandedToolName, setExpandedToolName] = useState<string | null>(null);
  const [toolDescByName, setToolDescByName] = useState<Record<string, string>>({});
  const [toolsLoaded, setToolsLoaded] = useState(false);
  const [showStderr, setShowStderr] = useState(false);

  type TestState =
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'ok'; toolCount?: number }
    | { kind: 'failed'; message: string };
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (testTimerRef.current) clearTimeout(testTimerRef.current);
    };
  }, []);

  // 切到别的 server 时 reset staging + 状态
  useEffect(() => {
    setStaging(null);
    setSaving(false);
    setSaveError(null);
    setExpandedToolName(null);
    setToolDescByName({});
    setToolsLoaded(false);
    setShowStderr(false);
    setTestState({ kind: 'idle' });
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
  }, [serverId]);

  // server 已就绪时主动拉一次工具列表（首次打开看到 chip 列表，不用先点按钮）
  const cfgEnabled = cfg?.enabled ?? false;
  const rtStatus = runtime?.status;
  const rtToolCount = runtime?.toolCount ?? 0;
  useEffect(() => {
    if (!cfgEnabled || rtToolCount === 0) return;
    if (rtStatus !== 'connected' && rtStatus !== 'connected_ready') return;
    if (toolsLoaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await wsClient.request({ type: 'mcp.listTools', serverId });
        if (cancelled) return;
        if (res.type === 'mcp.tools.list') {
          const map = Object.fromEntries(res.tools.map((tool) => [tool.name, tool.description ?? '']));
          setToolDescByName(map);
          setToolsLoaded(true);
        }
      } catch (e) {
        console.warn('[mcp] listTools 失败', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, cfgEnabled, rtStatus, rtToolCount, toolsLoaded]);

  // ─── helpers ───────────────────────────────────────────
  const draft: StagingDraft | null = useMemo(() => {
    if (staging) return staging;
    if (cfg) return makeDraft(cfg);
    return null;
  }, [staging, cfg]);

  const dirty = useMemo(() => {
    if (!staging || !cfg) return false;
    return isDirty(staging, cfg);
  }, [staging, cfg]);

  const updateDraft = <K extends DraftKey>(key: K, value: StagingDraft[K]) => {
    setStaging((cur) => {
      const base = cur ?? (cfg ? makeDraft(cfg) : null);
      if (!base) return cur;
      return { ...base, [key]: value };
    });
  };

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  // 暴露给父级用于切 tab / 外部触发关闭
  useImperativeHandle(ref, () => ({ requestClose }), [dirty, onClose]);

  const onSave = async () => {
    if (!staging || !cfg || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const patch: Partial<StagingDraft & { enabled: boolean }> = {};
      if (staging.label !== cfg.label) patch.label = staging.label;
      if ((staging.description ?? '') !== (cfg.description ?? ''))
        patch.description = staging.description;
      if (staging.command !== cfg.command) patch.command = staging.command;
      if (staging.probeTool !== cfg.probeTool) patch.probeTool = staging.probeTool;
      // args / env 给整体（深比较 by isDirty）
      patch.args = staging.args;
      patch.env = staging.env;
      const res = await wsClient.request({
        type: 'mcp.update',
        serverId,
        patch,
      });
      if (res.type === 'mcp.update.result' && res.ok) {
        setStaging(null);
        if (res.status !== undefined) {
          upsertRuntime({
            serverId,
            status: res.status,
            toolCount: res.toolCount,
            lastError: res.message,
            circuitOpenUntil: res.circuitOpenUntil,
          });
        }
      } else {
        setSaveError(
          res.type === 'mcp.update.result' ? res.message ?? t('mcpDetail.saveFailed') : t('mcpDetail.saveFailed'),
        );
      }
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await wsClient.request({ type: 'mcp.delete', serverId });
      if (res.type === 'mcp.delete.result' && res.ok) {
        removeRuntime(serverId);
        setConfirmDelete(false);
        onClose();
      } else {
        setDeleteError(
          res.type === 'mcp.delete.result' ? res.message ?? t('mcpDetail.deleteFailed') : t('mcpDetail.deleteFailed'),
        );
      }
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const onTestConnection = async () => {
    if (testState.kind === 'running' || !cfg) return;
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    setTestState({ kind: 'running' });
    try {
      const res = await wsClient.request({ type: 'mcp.testConnection', serverId });
      if (res.type === 'mcp.test.result') {
        if (res.status === 'connected_ready' || res.status === 'connected') {
          setTestState({ kind: 'ok', toolCount: res.toolCount });
          // 成功即真值——回写 runtime store，状态行当场愈（曾只写本地 5 秒态，打磨 7 可选项）
          upsertRuntime({ serverId, status: res.status, toolCount: res.toolCount });
        } else {
          setTestState({ kind: 'failed', message: res.message ?? t(`mcpDetail.status.${res.status}`) });
        }
      } else {
        setTestState({ kind: 'failed', message: t('mcpDetail.badResponse') });
      }
    } catch (e) {
      setTestState({ kind: 'failed', message: (e as Error).message });
    }
    testTimerRef.current = setTimeout(() => {
      setTestState({ kind: 'idle' });
      testTimerRef.current = null;
    }, 5000);
  };

  const onExpandTool = (toolName: string) => {
    setExpandedToolName((cur) => (cur === toolName ? null : toolName));
  };

  // 手动重连：乐观置 reconnecting，restart RPC 落定后覆盖真状态（含清掉的熔断时间戳）。
  // restart 走 registry.restartServer → stopServerImpl 会清重连记账，故成功后 circuit 自然归零。
  const onReconnect = async () => {
    markReconnecting(serverId);
    try {
      const res = await wsClient.request({ type: 'mcp.restart', serverId });
      if (res.type === 'mcp.restart.result') {
        upsertRuntime({
          serverId,
          status: res.status,
          toolCount: res.toolCount,
          lastError: res.message,
          circuitOpenUntil: res.circuitOpenUntil,
        });
      }
    } catch (e) {
      upsertRuntime({ serverId, status: 'failed', lastError: (e as Error).message });
    }
  };

  if (!cfg || !draft) {
    return (
      <aside className="flex h-full min-w-0 flex-col border-l border-border bg-elevated">
        <div className="px-7 py-12 text-center text-sm text-text-tertiary">
          {t('mcpDetail.notFound')}
        </div>
      </aside>
    );
  }

  const stat = runtime?.status ?? 'idle';
  const statusText = (() => {
    if (!cfg.enabled) return t('mcpDetail.status.idle');
    const base = t(`mcpDetail.status.${stat}`);
    if (stat === 'connected_ready' && runtime?.toolCount)
      return t('mcpDetail.statusToolCount', { base, count: runtime.toolCount });
    return base;
  })();

  // 熔断态由 circuitOpenUntil 时间戳派生（非 status 枚举，避免两个真相源 §4.5）；不挂定时器自刷新。
  const circuitOpen = (runtime?.circuitOpenUntil ?? 0) > Date.now();
  const reconnecting = stat === 'reconnecting';
  // 重连按钮：已启用、且崩了 / 熔断 / 重连中（重连中转圈 + disabled 防连点）。三个后端都给——
  // 主进程这份连接就是模型在用的那份，不再有「claude-code 自己托管」一说。
  const showReconnect = cfg.enabled && (stat === 'failed' || circuitOpen || reconnecting);

  // 工具列表：从 mount effect 主动拉来填充 toolDescByName
  const toolNames = Object.keys(toolDescByName);

  return (
    <aside className="flex h-full min-w-0 flex-col border-l border-border bg-elevated">
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-1 px-3 pt-3">
        <button
          type="button"
          title={t('common:delete')}
          aria-label={t('common:delete')}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-danger"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={14} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          title={t('mcpDetail.close')}
          aria-label={t('common:close')}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          onClick={requestClose}
        >
          <X size={14} strokeWidth={1.6} />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-8 pt-1">
        <InlineLabelField
          initial={cfg.label}
          onCommit={(v) => updateDraft('label', v)}
        />
        <InlineDescriptionField
          initial={cfg.description ?? ''}
          onCommit={(v) => updateDraft('description', v.trim() || undefined)}
        />

        {/* 状态条。三个后端同源：都读主进程那份长驻连接的 runtime（chip / 重连 / 熔断提示一视同仁）。 */}
        <div className="my-4 flex items-center gap-3 border-b border-t border-border py-2.5">
          <span className={cn('inline-flex items-center gap-2 text-xs', statusColor(stat, cfg.enabled))}>
            <span className="inline-block h-[7px] w-[7px] rounded-full bg-current" />
            <span className="font-medium">{statusText}</span>
          </span>
          {showReconnect ? (
            <button
              type="button"
              onClick={() => void onReconnect()}
              disabled={reconnecting}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-hover disabled:opacity-50"
              title={t('mcpDetail.reconnectHint')}
            >
              <RefreshCw size={11} strokeWidth={1.6} className={cn(reconnecting && 'animate-spin')} />
              {reconnecting ? t('mcpDetail.reconnecting') : t('mcpDetail.reconnect')}
            </button>
          ) : null}
          {circuitOpen ? (
            <span className="text-xs text-warn">{t('mcpDetail.circuitOpen')}</span>
          ) : null}
          <span className="flex-1" />
          <McpToggle serverId={serverId} enabled={cfg.enabled} />
          <span className="text-xs text-text-tertiary">
            {cfg.enabled ? t('status.enabled') : t('status.disabled')}
          </span>
        </div>

        {/* 启动命令 */}
        <FieldBlock label={t('mcpDetail.fieldCommand')}>
          <input
            type="text"
            value={draft.command}
            onChange={(e) => updateDraft('command', e.target.value)}
            className="w-full rounded-md border border-border bg-canvas px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent"
          />
        </FieldBlock>

        <FieldBlock label={t('mcpDetail.fieldArgs')}>
          <ArgsField
            value={draft.args}
            onChange={(next) => updateDraft('args', next)}
          />
        </FieldBlock>

        <FieldBlock label={t('mcpDetail.fieldEnv')}>
          <EnvField
            value={draft.env ?? {}}
            onChange={(next) => updateDraft('env', next)}
          />
        </FieldBlock>

        <FieldBlock label={t('mcpDetail.fieldProbe')} hint={t('mcpDetail.optional')}>
          <input
            type="text"
            value={draft.probeTool ?? ''}
            onChange={(e) => updateDraft('probeTool', e.target.value || undefined)}
            placeholder={t('mcpDetail.optional')}
            className="w-full rounded-md border border-border bg-canvas px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent"
          />
        </FieldBlock>

        {/* 工具列表 / 错误条读主进程那份长驻连接的 runtime，三个后端同源。 */}
        {cfg.enabled && runtime?.toolCount ? (
          <FieldBlock label={t('mcpDetail.exposedTools', { count: runtime.toolCount })}>
            {toolNames.length > 0 ? (
              <ToolList
                names={toolNames}
                expanded={expandedToolName}
                onClick={onExpandTool}
                descMap={toolDescByName}
              />
            ) : (
              <span className="font-mono text-xs text-text-quaternary">{t('common:loading')}</span>
            )}
          </FieldBlock>
        ) : null}

        {/* 错误条 + stderr 展开 */}
        {runtime?.lastError ? (
          <div className="mt-4 rounded-md border-l-2 border-danger bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">
            <div>{runtime.lastError}</div>
            {runtime.lastStderr ? (
              <button
                type="button"
                onClick={() => setShowStderr((v) => !v)}
                className="mt-1 text-text-tertiary hover:text-text-primary"
              >
                {showStderr ? t('mcpDetail.hideStderr') : t('mcpDetail.showStderr')}
              </button>
            ) : null}
            {showStderr && runtime.lastStderr ? (
              <pre className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-canvas p-2 font-mono text-[11px] leading-snug text-text-secondary">
                {runtime.lastStderr}
              </pre>
            ) : null}
          </div>
        ) : null}

        {/* 行动栏 */}
        <div className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-xs">
          <TestConnectionButton state={testState} onClick={() => void onTestConnection()} />
          <span className="flex-1" />
          {saveError ? (
            <span className="text-danger">{saveError}</span>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void onSave()}
          >
            {saving ? t('common:saving') : t('common:save')}
          </Button>
        </div>
      </div>

      {/* Dialogs */}
      <DeleteConfirm
        open={confirmDelete}
        description={t('mcpDetail.deleteConfirm', { label: cfg.label })}
        deleting={deleting}
        error={deleteError}
        onConfirm={() => void onDelete()}
        onClose={() => setConfirmDelete(false)}
      />
      <Dialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title={t('mcpDetail.discardTitle')}
        description={t('mcpDetail.discardDesc')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(false)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setStaging(null);
                setConfirmDiscard(false);
                onClose();
              }}
            >
              {t('mcpDetail.discard')}
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
    </aside>
  );
});

// ─── Inline label / description fields ─────────────────────────

function InlineLabelField({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (v: string) => void;
}) {
  const { t } = useTranslation('settings');
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setV(initial);
  }, [initial, editing]);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  const save = () => {
    setEditing(false);
    const trimmed = v.trim();
    if (trimmed && trimmed !== initial) onCommit(trimmed);
    else setV(initial);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        type="text"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
          if (e.key === 'Escape') {
            setV(initial);
            setEditing(false);
          }
        }}
        className="-mx-1 mb-1 block w-[calc(100%+0.5rem)] rounded-md border border-accent bg-canvas px-1 py-0 font-sans text-[20px] font-semibold leading-tight tracking-tight text-text-primary outline-none ring-2 ring-accent-ring"
      />
    );
  }
  return (
    <h2
      className="-mx-1 mb-1 cursor-text rounded-md px-1 font-sans text-[20px] font-semibold leading-tight tracking-tight text-text-primary transition-colors hover:bg-hover"
      onClick={() => setEditing(true)}
      title={t('mcpDetail.editHint')}
    >
      {initial}
    </h2>
  );
}

function InlineDescriptionField({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (v: string) => void;
}) {
  const { t } = useTranslation('settings');
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setV(initial);
  }, [initial, editing]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const save = () => {
    setEditing(false);
    if (v !== initial) onCommit(v);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        type="text"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
          if (e.key === 'Escape') {
            setV(initial);
            setEditing(false);
          }
        }}
        placeholder={t('mcpDetail.descPlaceholder')}
        className="-mx-1 block w-[calc(100%+0.5rem)] rounded-md border border-accent bg-canvas px-1 py-0 font-serif text-[13.5px] italic leading-relaxed text-text-secondary outline-none ring-2 ring-accent-ring"
      />
    );
  }
  return initial ? (
    <p
      className="-mx-1 cursor-text rounded-md px-1 font-serif text-[13.5px] italic leading-relaxed text-text-secondary transition-colors hover:bg-hover"
      onClick={() => setEditing(true)}
      title={t('mcpDetail.editHint')}
    >
      {initial}
    </p>
  ) : (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="-mx-1 cursor-text rounded-md px-1 font-serif text-[13.5px] italic leading-relaxed text-text-quaternary transition-colors hover:bg-hover hover:text-text-tertiary"
    >
      {t('mcpDetail.descPlaceholder')}
    </button>
  );
}

// ─── 表单 helpers ─────────────────────────────────────────

function FieldBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">
          {label}
        </span>
        {hint ? <span className="text-[11px] italic text-text-quaternary">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function ArgsField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation('settings');
  const [adding, setAdding] = useState(false);
  const [addV, setAddV] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const commitAdd = () => {
    const trimmed = addV.trim();
    if (trimmed) onChange([...value, trimmed]);
    setAddV('');
    setAdding(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((arg, idx) => (
        <span
          key={`${idx}-${arg}`}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-canvas py-[3px] pl-2 pr-1 font-mono text-[11.5px] text-text-primary"
        >
          {arg}
          <button
            type="button"
            onClick={() => onChange(value.filter((_, i) => i !== idx))}
            className="rounded px-1 text-text-quaternary hover:bg-hover hover:text-danger"
            title={t('common:delete')}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          type="text"
          value={addV}
          onChange={(e) => setAddV(e.target.value)}
          onBlur={commitAdd}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
            if (e.key === 'Enter') {
              e.preventDefault();
              commitAdd();
            }
            if (e.key === 'Escape') {
              setAddV('');
              setAdding(false);
            }
          }}
          className="rounded border border-accent bg-canvas px-2 py-[3px] font-mono text-[11.5px] text-text-primary outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded border border-dashed border-border-strong px-2 py-[3px] font-mono text-[11.5px] text-text-tertiary hover:border-accent hover:text-accent"
        >
          {t('mcpDetail.argAdd')}
        </button>
      )}
    </div>
  );
}

function EnvField({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const { t } = useTranslation('settings');
  const entries = Object.entries(value);
  const updateKey = (oldK: string, newK: string) => {
    if (newK === oldK) return;
    const next: Record<string, string> = {};
    for (const [k, v] of entries) {
      next[k === oldK ? newK : k] = v;
    }
    onChange(next);
  };
  const updateVal = (k: string, v: string) => {
    onChange({ ...value, [k]: v });
  };
  const remove = (k: string) => {
    const next = { ...value };
    delete next[k];
    onChange(next);
  };
  const add = () => {
    let base = 'KEY';
    let i = 1;
    while (Object.prototype.hasOwnProperty.call(value, i === 1 ? base : `${base}_${i}`)) i++;
    const k = i === 1 ? base : `${base}_${i}`;
    onChange({ ...value, [k]: '' });
  };

  return (
    <div className="flex flex-col gap-1.5">
      {entries.map(([k, v]) => (
        <EnvRow
          key={k}
          k={k}
          v={v}
          onUpdateKey={(newK) => updateKey(k, newK)}
          onUpdateVal={(newV) => updateVal(k, newV)}
          onRemove={() => remove(k)}
        />
      ))}
      <button
        type="button"
        onClick={add}
        className="self-start font-mono text-xs text-text-tertiary hover:text-accent"
      >
        {t('mcpDetail.envAdd')}
      </button>
    </div>
  );
}

/** 单行 env 字段：value 默认 password 隐藏，点击眼睛切换显示（v0.6 防肩窥）。 */
function EnvRow({
  k,
  v,
  onUpdateKey,
  onUpdateVal,
  onRemove,
}: {
  k: string;
  v: string;
  onUpdateKey: (next: string) => void;
  onUpdateVal: (next: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="grid grid-cols-[1fr_1fr_18px_14px] items-center gap-1.5">
      <input
        type="text"
        value={k}
        onChange={(e) => onUpdateKey(e.target.value)}
        className="rounded border border-border bg-canvas px-2 py-1 font-mono text-xs text-text-primary outline-none focus:border-accent"
      />
      <input
        type={revealed ? 'text' : 'password'}
        value={v}
        onChange={(e) => onUpdateVal(e.target.value)}
        className="rounded border border-border bg-canvas px-2 py-1 font-mono text-xs text-text-primary outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={() => setRevealed((b) => !b)}
        className="inline-flex items-center justify-center text-text-quaternary hover:text-text-secondary"
        title={revealed ? t('mcpDetail.hide') : t('mcpDetail.reveal')}
      >
        {revealed ? <EyeOff size={12} strokeWidth={1.5} /> : <Eye size={12} strokeWidth={1.5} />}
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="text-center font-mono text-text-quaternary hover:text-danger"
        title={t('common:delete')}
      >
        ×
      </button>
    </div>
  );
}

function ToolList({
  names,
  expanded,
  onClick,
  descMap,
}: {
  names: string[];
  expanded: string | null;
  onClick: (n: string) => void;
  descMap: Record<string, string>;
}) {
  const { t } = useTranslation('settings');
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {names.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onClick(n)}
            className={cn(
              'rounded border px-2 py-[2px] font-mono text-[11.5px] transition-colors',
              expanded === n
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border bg-canvas text-text-secondary hover:border-border-strong',
            )}
          >
            {n}
          </button>
        ))}
      </div>
      {expanded ? (
        <p className="mt-2 rounded border border-border bg-canvas px-2.5 py-1.5 font-serif text-[12.5px] leading-snug text-text-secondary">
          {descMap[expanded] ? descMap[expanded] : (
            <span className="italic text-text-quaternary">{t('mcpDetail.noToolDesc')}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}

function TestConnectionButton({
  state,
  onClick,
}: {
  state:
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'ok'; toolCount?: number }
    | { kind: 'failed'; message: string };
  onClick: () => void;
}) {
  const { t } = useTranslation('settings');
  const label = (() => {
    if (state.kind === 'idle') return t('mcpDetail.testConn');
    if (state.kind === 'running') return t('mcpDetail.testing');
    if (state.kind === 'ok')
      return state.toolCount ? t('mcpDetail.testOkTools', { count: state.toolCount }) : t('mcpDetail.testOk');
    return t('mcpDetail.testFailed', { message: state.message.slice(0, 60) });
  })();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state.kind === 'running'}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-3 py-1 text-xs transition-colors',
        state.kind === 'failed'
          ? 'border-danger text-danger'
          : state.kind === 'ok'
            ? 'border-success text-success'
            : 'border-border text-text-secondary hover:bg-hover',
      )}
    >
      {state.kind === 'running' ? <Loader2 size={11} className="animate-spin" /> : null}
      {label}
    </button>
  );
}
