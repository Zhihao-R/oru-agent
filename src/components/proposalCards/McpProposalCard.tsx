/**
 * MCP propose 卡片（v0.6）—— 3 种 kind 共享外壳；status 切换 pending / executed / failed / rejected 四种视觉。
 *
 * status 视觉：
 * - pending  : 实底 + [让他去做] [我自己来] 双按钮
 * - executed : 灰底 + ✓ + 摘要
 * - failed   : 灰底 + 红色细条 + 错因
 * - rejected : 灰底 + "你选择自己来"
 *
 * 由 ChatArea 的 ProposalCard 入口按 proposal.kind 分发到此组件。
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, AlertCircle, Loader2 } from 'lucide-react';
import type {
  McpDeleteProposal,
  McpInstallProposal,
  McpUpdateProposal,
} from '@shared/types';
import { behaviorForProposal } from '@shared/proposals/behaviors';
import { wsClient } from '@/lib/ws';
import { useAgentStore } from '@/stores/agentStore';
import { cn } from '@/lib/cn';
import { RejectNoteDisclosure } from './RejectNoteDisclosure';
import { ProposalTerminalLine } from './ProposalTerminalLine';
import { AlwaysAllowButton } from './AlwaysAllowButton';
import { Button } from '../ui/Button';

type AnyMcpProposal = McpInstallProposal | McpUpdateProposal | McpDeleteProposal;

export function McpProposalCard({ proposal }: { proposal: AnyMcpProposal }) {
  const [submitting, setSubmitting] = useState<'execute' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  // 工作 / 危险挡：pending 卡是分身自动触发并自动执行的——不让用户再点 [让他去做]（会重复执行）。
  // 只读挡下写类 mcp 卡本不该出现（工具 execute 入口已 readonlyWriteReject 直接拒、不弹卡）；
  // 兜底：若 readonly 仍渲染到此卡，按"非自动执行"呈现，不谎称已自动跑。
  // 用 active agent 的 approvalMode——MVP 单 agent 永远是同一个；多 agent 场景
  // 切换查看历史时这里会取错值，是已知的 future bug（proposal 不带 agentId，需要
  // 从 conversationId 反查 agentId 的机制），跟"propose 完整持久化"一起下期解决
  const isReadonly = useAgentStore(
    (s) => (s.agents.find((a) => a.id === s.activeAgentId)?.approvalMode ?? 'work') === 'readonly',
  );

  const onAccept = (always: boolean) => {
    if (submitting || proposal.status !== 'pending') return;
    setSubmitting('execute');
    void wsClient
      .request({ type: 'proposal.execute', proposalId: proposal.id, always })
      .catch(() => setSubmitting(null));
    // status 落定由 proposal.statusChanged broadcast 推回
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
      <Body proposal={proposal} />
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

// ─── Shell：外壳 + 状态色 + 标题 ──────────────────────────────

function Shell({
  proposal,
  children,
}: {
  proposal: AnyMcpProposal;
  children: ReactNode;
}) {
  const isDone = proposal.status !== 'pending';
  const { t } = useTranslation('proposal');
  // 行为分类（决策 1）：标题写行为类型「变更系统环境 · MCP」，原 title 降为对象描述行
  const behavior = behaviorForProposal(proposal);
  return (
    <div
      className={cn(
        'mt-2 rounded-lg border p-3 transition-colors',
        isDone
          ? 'border-border bg-canvas/50'
          : 'border-accent bg-elevated shadow-sm',
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

function StatusIcon({ status }: { status: AnyMcpProposal['status'] }) {
  if (status === 'executed')
    return (
      <Check size={14} strokeWidth={2} className="text-success" />
    );
  if (status === 'failed')
    return (
      <AlertCircle size={14} strokeWidth={2} className="text-danger" />
    );
  if (status === 'rejected')
    return <X size={14} strokeWidth={2} className="text-text-tertiary" />;
  // pending / executing 都不带图标——executing 若复用 X 会被读成「已拒绝」
  return null;
}

// ─── Body：按 kind 渲染主体 ────────────────────────────────────

function Body({ proposal }: { proposal: AnyMcpProposal }) {
  if (proposal.kind === 'mcp.install') return <InstallBody p={proposal} />;
  if (proposal.kind === 'mcp.update') return <UpdateBody p={proposal} />;
  return <DeleteBody p={proposal} />;
}

function InstallBody({ p }: { p: McpInstallProposal }) {
  const env = p.config.env ?? {};
  return (
    <div className="space-y-2 text-base">
      {p.config.description ? (
        <p className="italic text-text-secondary">{p.config.description}</p>
      ) : null}
      <KvRow label="command" value={<code className="font-mono">{p.config.command}</code>} />
      <KvRow
        label="args"
        value={
          <div className="flex flex-wrap gap-1">
            {p.config.args.map((a, i) => (
              <span
                key={i}
                className="rounded border border-border bg-canvas px-1.5 py-[1px] font-mono text-xs"
              >
                {a}
              </span>
            ))}
          </div>
        }
      />
      {Object.keys(env).length > 0 ? (
        <KvRow
          label="env"
          value={
            <div className="space-y-0.5 font-mono text-xs">
              {Object.entries(env).map(([k, v]) => (
                <div key={k} className="break-all">
                  <span className="text-text-primary">{k}</span>
                  <span className="text-text-tertiary"> = </span>
                  <span className="text-text-secondary">{v}</span>
                </div>
              ))}
            </div>
          }
        />
      ) : null}
      {p.config.probeTool ? (
        <KvRow label="probe" value={<code className="font-mono">{p.config.probeTool}</code>} />
      ) : null}
    </div>
  );
}

function UpdateBody({ p }: { p: McpUpdateProposal }) {
  const { t } = useTranslation('proposal');
  const onlyEnabled =
    Object.keys(p.patch).length === 1 && 'enabled' in p.patch;
  if (onlyEnabled) {
    return (
      <p className="text-md italic text-text-secondary">
        {p.patch.enabled ? t('mcp.enable') : t('mcp.disable')} <code className="font-mono">{p.before.label}</code>
      </p>
    );
  }
  return (
    <div className="space-y-2 text-base">
      <p className="italic text-text-secondary">
        {t('mcp.modify')} <code className="font-mono">{p.before.label}</code>{t('mcp.configColon')}
      </p>
      {Object.entries(p.patch).map(([k, v]) => (
        <KvRow
          key={k}
          label={k}
          value={
            <div className="font-mono text-xs text-text-secondary">
              {String((p.before as Record<string, unknown>)[k])} → {JSON.stringify(v)}
            </div>
          }
        />
      ))}
    </div>
  );
}

function DeleteBody({ p }: { p: McpDeleteProposal }) {
  const { t } = useTranslation('proposal');
  return (
    <div className="space-y-1 text-base">
      <p className="text-text-primary">
        {t('mcp.delete')} <code className="font-mono">{p.target.label}</code>
        {p.target.description ? <span className="text-text-tertiary">：{p.target.description}</span> : null}
      </p>
      {p.target.toolCount ? (
        <p className="text-xs text-text-tertiary">
          {t('mcp.deleteStatus', { status: p.target.runtimeStatus ?? 'idle', count: p.target.toolCount })}
        </p>
      ) : null}
      <p className="text-xs italic text-text-quaternary">
        {t('mcp.tokenWarn')}
      </p>
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
  proposal: AnyMcpProposal;
  submitting: 'execute' | 'reject' | null;
  /** 工作 / 危险挡（非只读）下分身已自动触发执行；UI 不能让用户再点[让他去做] */
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
  // 这张卡后端会自己执行完（不需要审批）→ 不给按钮，只转圈。判据是提案自身要不要审批，
  // 不是挡位：装卸类在工作挡是**要问人**的（forceApproval），按挡位猜会让批准按钮根本不渲染、
  // 后端却在等确认，卡永远悬着。
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
          {t('reject')}
        </Button>
      </div>
    </div>
  );
}
