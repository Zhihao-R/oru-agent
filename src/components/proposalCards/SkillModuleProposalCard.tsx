/**
 * Skill 模块（v1）proposal 卡片 dispatcher。
 *
 * 5 种 kind 共享外壳 + 操作按钮，body 按 kind 分发：
 * - plugin.install   → PluginInstallBody（含 mcpConflicts 选项 / 含可执行脚本提示 / 忽略段提示）
 * - plugin.update    → PluginUpdateBody（commit 变迁 + diff 摘要折叠）
 * - plugin.uninstall → PluginUninstallBody（含 sideEffects 副作用提示）
 * - skill.create     → SkillCreateBody（含 description 可改输入框）
 * - skill.patch      → SkillPatchBody（含 description 可改 + diffPreview）
 *
 * 第 2 / 5 / 6 期分批接入完整 UI；本卡先把外壳和审批按钮接通，body 用最小可读形式占位。
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, AlertCircle, Loader2 } from 'lucide-react';
import type {
  PluginInstallProposal,
  PluginUpdateProposal,
  PluginUninstallProposal,
  SkillCreateProposal,
  SkillPatchProposal,
  SkillInstallProposal,
} from '@shared/types';
import { behaviorForProposal } from '@shared/proposals/behaviors';
import { wsClient } from '@/lib/ws';
import { useAgentStore } from '@/stores/agentStore';
import { RejectNoteDisclosure } from './RejectNoteDisclosure';
import { ProposalTerminalLine } from './ProposalTerminalLine';
import { AlwaysAllowButton } from './AlwaysAllowButton';
import { Button } from '../ui/Button';
import { cn } from '@/lib/cn';

type AnySkillModuleProposal =
  | PluginInstallProposal
  | PluginUpdateProposal
  | PluginUninstallProposal
  | SkillCreateProposal
  | SkillPatchProposal
  | SkillInstallProposal;

export function SkillModuleProposalCard({ proposal }: { proposal: AnySkillModuleProposal }) {
  const [submitting, setSubmitting] = useState<'execute' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  // skill.create / skill.patch 允许用户在卡上改 description 后提交
  const initialDescription =
    proposal.kind === 'skill.create'
      ? proposal.skillDescription
      : proposal.kind === 'skill.patch'
        ? proposal.targetDescription
        : '';
  const [editedDescription, setEditedDescription] = useState(initialDescription);
  // 工作 / 危险挡：写类 skill 卡自动执行，不让用户再点[让他去做]。只读挡下写类 skill 卡本不该出现
  //（工具 execute 入口已 readonlyWriteReject 直接拒）；兜底按"非自动执行"呈现。
  const isReadonly = useAgentStore(
    (s) => (s.agents.find((a) => a.id === s.activeAgentId)?.approvalMode ?? 'work') === 'readonly',
  );
  const onAccept = (always: boolean) => {
    if (submitting || proposal.status !== 'pending') return;
    setSubmitting('execute');
    // skill.create / skill.patch 提交时把改过的 description 一起带上
    const payload: {
      type: 'proposal.execute';
      proposalId: string;
      always: boolean;
      descriptionOverride?: string;
    } = {
      type: 'proposal.execute',
      proposalId: proposal.id,
      always,
    };
    if (
      (proposal.kind === 'skill.create' || proposal.kind === 'skill.patch') &&
      editedDescription !== initialDescription
    ) {
      payload.descriptionOverride = editedDescription;
    }
    void wsClient.request(payload).catch(() => setSubmitting(null));
  };
  const onReject = () => {
    if (submitting || proposal.status !== 'pending') return;
    setSubmitting('reject');
    void wsClient
      // 拒绝附言（G02）随请求带上
      .request({ type: 'proposal.reject', proposalId: proposal.id, note: note.trim() || undefined })
      .catch(() => setSubmitting(null));
  };

  return (
    <Shell proposal={proposal}>
      <Body
        proposal={proposal}
        editedDescription={editedDescription}
        onChangeDescription={setEditedDescription}
      />
      <Footer
        proposal={proposal}
        submitting={submitting}
        autoExecuting={!proposal.forceApproval && !isReadonly}
        onAccept={onAccept}
        onReject={onReject}
        note={note}
        setNote={setNote}
      />
    </Shell>
  );
}

// ─── Shell ────────────────────────────────────────────────────

function Shell({
  proposal,
  children,
}: {
  proposal: AnySkillModuleProposal;
  children: ReactNode;
}) {
  const isDone = proposal.status !== 'pending';
  const { t } = useTranslation('proposal');
  // 行为分类（决策 1）：装卸类标题写行为类型（变更系统环境 · 插件 / Skill），原 title 降为
  // 对象描述行；skill.create / skill.patch 不在行为分类面（内容创作），保留自有标题。
  const behavior = behaviorForProposal(proposal);
  return (
    <div
      className={cn(
        'mt-2 rounded-lg border p-3 transition-colors',
        isDone ? 'border-border bg-canvas/50' : 'border-accent bg-elevated shadow-sm',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <StatusIcon status={proposal.status} />
        <div className="flex-1 text-lg font-semibold leading-tight text-text-primary">
          {behavior ? t(behavior.titleKey) : proposal.title}
        </div>
      </div>
      {behavior ? (
        <div className="mb-2 text-xs text-text-secondary">{proposal.title}</div>
      ) : null}
      {children}
    </div>
  );
}

function StatusIcon({ status }: { status: AnySkillModuleProposal['status'] }) {
  if (status === 'pending') return null;
  if (status === 'executed') return <Check size={14} strokeWidth={2} className="text-success" />;
  if (status === 'failed') return <AlertCircle size={14} strokeWidth={2} className="text-danger" />;
  return <X size={14} strokeWidth={2} className="text-text-tertiary" />;
}

// ─── Body ──────────────────────────────────────────────────────

function Body({
  proposal,
  editedDescription,
  onChangeDescription,
}: {
  proposal: AnySkillModuleProposal;
  editedDescription: string;
  onChangeDescription: (v: string) => void;
}) {
  if (proposal.kind === 'plugin.install') return <PluginInstallBody p={proposal} />;
  if (proposal.kind === 'skill.install') return <SkillInstallBody p={proposal} />;
  if (proposal.kind === 'plugin.update') return <PluginUpdateBody p={proposal} />;
  if (proposal.kind === 'plugin.uninstall') return <PluginUninstallBody p={proposal} />;
  if (proposal.kind === 'skill.create')
    return (
      <SkillCreateBody p={proposal} edited={editedDescription} onChange={onChangeDescription} />
    );
  return (
    <SkillPatchBody p={proposal} edited={editedDescription} onChange={onChangeDescription} />
  );
}

function PluginInstallBody({ p }: { p: PluginInstallProposal }) {
  const { t } = useTranslation('proposal');
  return (
    <div className="space-y-2 text-base">
      {p.pluginManifest.description ? (
        <p className="italic text-text-secondary">{p.pluginManifest.description}</p>
      ) : null}
      <KvRow label={t('skill.kvSource')} value={<code className="font-mono text-xs">{p.source.url}</code>} />
      <KvRow
        label="commit"
        value={<code className="font-mono text-xs">{p.source.commit.slice(0, 7)}</code>}
      />
      {p.containedSkills.length > 0 ? (
        <KvRow
          label={t('skill.kvContainedSkill')}
          value={
            <ul className="space-y-0.5 text-sm">
              {p.containedSkills.map((s) => (
                <li key={s.name} className="text-text-secondary">
                  <code className="font-mono">{s.name}</code>
                  {s.description ? ` — ${s.description}` : ''}
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
      {p.containedMcpServers.length > 0 ? (
        <KvRow
          label={t('skill.kvContainedMcp')}
          value={
            <ul className="space-y-0.5 text-sm">
              {p.containedMcpServers.map((m) => (
                <li key={m.name} className="text-text-secondary">
                  <code className="font-mono">{m.name}</code>
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
      {p.containsExecutableScripts ? (
        <p className="rounded bg-warn-soft px-2 py-1 text-xs text-warn">
          {t('skill.execScriptsWarn')}
        </p>
      ) : null}
      {p.ignoredSections.length > 0 ? (
        <p className="text-xs italic text-text-quaternary">
          {t('skill.ignored', { sections: p.ignoredSections.join(' / ') })}
        </p>
      ) : null}
      {p.mcpConflicts && p.mcpConflicts.length > 0 ? (
        <div className="rounded border border-warn bg-warn-soft p-2">
          <p className="mb-1 text-sm font-medium text-warn">
            {t('skill.mcpConflicts', { count: p.mcpConflicts.length })}
          </p>
          <ul className="space-y-0.5 text-xs">
            {p.mcpConflicts.map((c, i) => (
              <li key={i} className="font-mono text-text-secondary">
                {c.existing.label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SkillInstallBody({ p }: { p: SkillInstallProposal }) {
  const { t } = useTranslation('proposal');
  return (
    <div className="space-y-2 text-base">
      {p.skillManifest.description ? (
        <p className="italic text-text-secondary">{p.skillManifest.description}</p>
      ) : null}
      <KvRow label="skill" value={<code className="font-mono text-xs">{p.skillId}</code>} />
      <KvRow
        label={t('skill.kvSource')}
        value={
          <code className="font-mono text-xs">
            {p.source.type === 'local' ? p.source.path : p.source.url}
          </code>
        }
      />
      {p.source.type === 'github' && p.source.commit ? (
        <KvRow
          label="commit"
          value={<code className="font-mono text-xs">{p.source.commit.slice(0, 7)}</code>}
        />
      ) : null}
      {p.license ? <KvRow label={t('skill.kvLicense')} value={<span>{p.license}</span>} /> : null}
    </div>
  );
}

function PluginUpdateBody({ p }: { p: PluginUpdateProposal }) {
  const { t } = useTranslation('proposal');
  return (
    <div className="space-y-2 text-base">
      <p className="text-text-primary">
        {t('skill.upgrade')} <code className="font-mono">{p.pluginId}</code>
      </p>
      <p className="text-sm text-text-secondary">
        <code className="font-mono">{p.fromCommit.slice(0, 7)}</code> →{' '}
        <code className="font-mono">{p.toCommit.slice(0, 7)}</code>
      </p>
      {p.diffSummary.keyFiles.length > 0 ? (
        <p className="text-xs text-text-tertiary">
          {t('skill.keyFilesChanged', { count: p.diffSummary.keyFiles.length })} ·{' '}
          {p.diffSummary.otherFilesCount > 0
            ? t('skill.otherFiles', { count: p.diffSummary.otherFilesCount })
            : t('skill.noOther')}
        </p>
      ) : null}
    </div>
  );
}

function PluginUninstallBody({ p }: { p: PluginUninstallProposal }) {
  const { t } = useTranslation('proposal');
  const se = p.sideEffects;
  return (
    <div className="space-y-1 text-base">
      <p className="text-text-primary">
        {t('skill.uninstall')} <code className="font-mono">{p.pluginId}</code>
      </p>
      {se.blockingDependents.length > 0 ? (
        <p className="rounded bg-danger-soft px-2 py-1 text-xs text-danger">
          {t('skill.blockingDependents', { list: se.blockingDependents.join(' / ') })}
        </p>
      ) : null}
      {se.activatedInConversation ? (
        <p className="text-xs text-text-tertiary">
          {t('skill.activatedInConv')}
        </p>
      ) : null}
      {se.dependentSkills.length > 0 ? (
        <p className="text-xs text-text-tertiary">
          {t('skill.dependentSkills', { list: se.dependentSkills.join(', ') })}
        </p>
      ) : null}
    </div>
  );
}

function SkillCreateBody({
  p,
  edited,
  onChange,
}: {
  p: SkillCreateProposal;
  edited: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation('proposal');
  return (
    <div className="space-y-2 text-base">
      <p className="text-text-primary">
        {t('skill.createSkill')} <code className="font-mono">{p.skillName}</code>
      </p>
      <label className="block text-xs uppercase tracking-wider text-text-tertiary">
        {t('skill.descEditable')}
        <textarea
          value={edited}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded border border-border bg-canvas p-2 text-base text-text-primary"
        />
      </label>
      <details className="rounded border border-border bg-canvas/50 px-2 py-1">
        <summary className="cursor-pointer text-xs text-text-secondary">
          {t('skill.skillMdFull', { count: p.skillMd.length })}
        </summary>
        <pre className="mt-1 max-h-60 overflow-auto text-xs text-text-secondary">
          {p.skillMd}
        </pre>
      </details>
      {p.scripts && p.scripts.length > 0 ? (
        <p className="text-xs italic text-text-quaternary">
          {t('skill.scriptsCount', { count: p.scripts.length })}
        </p>
      ) : null}
    </div>
  );
}

function SkillPatchBody({
  p,
  edited,
  onChange,
}: {
  p: SkillPatchProposal;
  edited: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation('proposal');
  return (
    <div className="space-y-2 text-base">
      <p className="text-text-primary">
        {t('skill.modify')} {p.target === 'plugin-manifest' ? t('skill.pluginActivationDesc') : 'skill'}{' '}
        <code className="font-mono">{p.name}</code>
      </p>
      <label className="block text-xs uppercase tracking-wider text-text-tertiary">
        {t('skill.descEditable')}
        <textarea
          value={edited}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded border border-border bg-canvas p-2 text-base text-text-primary"
        />
      </label>
      <details className="rounded border border-border bg-canvas/50 px-2 py-1">
        <summary className="cursor-pointer text-xs text-text-secondary">{t('skill.diffPreview')}</summary>
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-xs text-text-secondary">
          {p.diffPreview}
        </pre>
      </details>
    </div>
  );
}

function KvRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-[60px] flex-shrink-0 text-xs uppercase tracking-wider text-text-tertiary">
        {label}
      </span>
      <div className="min-w-0 flex-1">{value}</div>
    </div>
  );
}

// ─── Footer：按钮 / 状态行 ────────────────────────────────────

function Footer({
  proposal,
  submitting,
  autoExecuting,
  onAccept,
  onReject,
  note,
  setNote,
}: {
  proposal: AnySkillModuleProposal;
  submitting: 'execute' | 'reject' | null;
  autoExecuting: boolean;
  onAccept: (always: boolean) => void;
  onReject: () => void;
  note: string;
  setNote: (v: string) => void;
}) {
  const { t } = useTranslation('proposal');
  if (proposal.status !== 'pending') {
    // 非 pending：只留一行终态存证（G31），执行过程与成败由对话流展示
    return (
      <div className="border-t border-border">
        <ProposalTerminalLine proposal={proposal} />
      </div>
    );
  }
  if (autoExecuting) {
    return (
      <div className="mt-3 flex items-center gap-1.5 border-t border-border pt-2.5 text-xs text-text-tertiary">
        <Loader2 size={11} className="animate-spin" />
        {t('autoExecuting')}
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-2.5">
      <div className="flex justify-start">
        <RejectNoteDisclosure note={note} setNote={setNote} disabled={!!submitting} />
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" type="button" onClick={() => onAccept(false)} disabled={!!submitting}>
          {submitting === 'execute' ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              {t('executing')}
            </>
          ) : (
            t('accept')
          )}
        </Button>
        {/* 「始终允许」按钮自带 grantable 空判（空则不渲染），六卡同一模式 */}
        <AlwaysAllowButton proposal={proposal} onClick={() => onAccept(true)} disabled={!!submitting} />
        <Button variant="ghost" size="sm" type="button" onClick={onReject} disabled={!!submitting}>
          {submitting === 'reject' ? t('processing') : t('reject')}
        </Button>
      </div>
    </div>
  );
}
