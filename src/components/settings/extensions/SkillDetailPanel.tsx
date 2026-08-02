/**
 * Skill 详情侧栏 —— 沿用 McpDetailPanel 范式：
 *   border-l + bg-elevated + 顶部 Toolbar（删除 / 关闭）+ scrollable body
 *
 * 跟 MCP 详情面板的关键差异：
 * - 没有可编辑字段：v1 用户直接编辑 SKILL.md 暂无 UI 入口，只读预览
 *   （分身可通过 skill.patch proposal 修改；用户的"自主编辑入口"是已知 v1 缺口，
 *    可在后续版本补 inline 编辑或"打开文件"按钮）
 * - 无 dirty 状态机 → 关闭直接 onClose；父级 SettingsPage 不需要持 ref
 * - 删除按钮仅对 standalone 显示；builtin 灰掉，plugin 内提示去 plugin 行卸
 * - SKILL.md 全文只读预览（懒拉一次）
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, X } from 'lucide-react';
import { wsClient } from '@/lib/ws';
import { DeleteConfirm } from '@/components/ui/DeleteConfirm';
import { useSkillModuleStore } from '@/stores/skillModuleStore';
import { SkillToggle } from './SkillToggle';
import { cn } from '@/lib/cn';

export type SkillDetailPanelProps = {
  skillId: string;
  onClose: () => void;
};

export function SkillDetailPanel({ skillId, onClose }: SkillDetailPanelProps) {
  const { t } = useTranslation('settings');
  const skill = useSkillModuleStore((s) => s.skills.find((x) => x.id === skillId));

  const [skillMd, setSkillMd] = useState<string | null>(null);
  const [loadingMd, setLoadingMd] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 切换 skill 时拉一次 SKILL.md（懒加载——避免列表打开时把所有 skill 文本都拉过来）
  useEffect(() => {
    setSkillMd(null);
    setLoadingMd(true);
    let cancelled = false;
    void wsClient
      .request({ type: 'skill.get', skillId })
      .then((res) => {
        if (cancelled) return;
        if (res.type === 'skill.get.result') {
          setSkillMd(res.skillMd ?? t('skillDetail.mdReadFailed'));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setSkillMd(t('skillDetail.readError', { error: (e as Error).message }));
      })
      .finally(() => {
        if (!cancelled) setLoadingMd(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId, t]);

  const onDelete = async () => {
    if (!skill) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await wsClient.request({ type: 'skill.delete', skillId });
      if (res.type === 'skill.delete.result' && res.ok) {
        setConfirmDelete(false);
        onClose();
      } else {
        setDeleteError(
          res.type === 'skill.delete.result' ? res.message ?? t('skillDetail.deleteFailed') : t('skillDetail.deleteFailed'),
        );
      }
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  if (!skill) {
    return (
      <aside className="flex h-full min-w-0 flex-col border-l border-border bg-elevated">
        <div className="flex items-center justify-end gap-1 px-3 pt-3">
          <button
            type="button"
            title={t('skillDetail.close')}
            aria-label={t('common:close')}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.6} />
          </button>
        </div>
        <div className="px-7 py-12 text-center text-sm text-text-tertiary">
          {t('skillDetail.notFound')}
        </div>
      </aside>
    );
  }

  const canDelete = skill.source === 'standalone';
  const deleteHint =
    skill.source === 'builtin'
      ? t('skillDetail.deleteBuiltin')
      : skill.source === 'plugin'
        ? t('skillDetail.deletePlugin')
        : t('common:delete');

  return (
    <aside className="flex h-full min-w-0 flex-col border-l border-border bg-elevated">
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-1 px-3 pt-3">
        <button
          type="button"
          title={deleteHint}
          aria-label={t('common:delete')}
          disabled={!canDelete}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded transition-colors',
            canDelete
              ? 'text-text-secondary hover:bg-hover hover:text-danger'
              : 'cursor-not-allowed text-text-quaternary',
          )}
          onClick={() => canDelete && setConfirmDelete(true)}
        >
          <Trash2 size={14} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          title={t('skillDetail.close')}
          aria-label={t('common:close')}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          onClick={onClose}
        >
          <X size={14} strokeWidth={1.6} />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-8 pt-1">
        <h2 className="-mx-1 mb-1 px-1 font-sans text-[20px] font-semibold leading-tight tracking-tight text-text-primary">
          {skill.name}
        </h2>
        {skill.description ? (
          <p className="-mx-1 px-1 font-serif text-[13.5px] italic leading-relaxed text-text-secondary">
            {skill.description}
          </p>
        ) : null}

        {/* 状态条：左色点+状态文字，右开关。plugin 内 skill 在开关旁补一句"由父 plugin 控制"
            说明为什么不能切；非 plugin 不再重复一遍"已启用/未启用"——开关本身就是状态。 */}
        <div className="my-4 flex items-center gap-3 border-b border-t border-border py-2.5">
          <span
            className={cn(
              'inline-flex items-center gap-2 text-xs',
              skill.enabled ? 'text-success' : 'text-text-quaternary',
            )}
          >
            <span className="inline-block h-[7px] w-[7px] rounded-full bg-current" />
            <span className="font-medium">{skill.enabled ? t('status.enabled') : t('status.disabled')}</span>
          </span>
          <span className="flex-1" />
          <SkillToggle
            skillId={skill.id}
            enabled={skill.enabled}
            source={skill.source}
          />
          {skill.source === 'plugin' ? (
            <span className="text-xs text-text-tertiary">{t('skillDetail.byPlugin')}</span>
          ) : null}
        </div>

        {/* 元数据 */}
        <FieldBlock label={t('skillDetail.fieldSource')}>
          <span className="text-xs text-text-secondary">{t(`extensions.skillSource.${skill.source}`)}</span>
          {skill.parentPluginId ? (
            <span className="ml-2 font-mono text-[11px] text-text-tertiary">
              {skill.parentPluginId}
            </span>
          ) : null}
        </FieldBlock>

        <FieldBlock label={t('skillDetail.fieldPath')}>
          <code className="block break-all rounded border border-border bg-canvas px-2 py-1 font-mono text-[11px] text-text-secondary">
            {skill.path}
          </code>
        </FieldBlock>

        <FieldBlock label="SKILL.md">
          {loadingMd ? (
            <p className="text-xs text-text-tertiary">{t('common:loading')}</p>
          ) : (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded border border-border bg-canvas px-2.5 py-2 text-[12px] leading-[1.55] text-text-secondary">
              {skillMd}
            </pre>
          )}
        </FieldBlock>
      </div>

      <DeleteConfirm
        open={confirmDelete}
        description={t('skillDetail.deleteConfirm', { name: skill.name })}
        deleting={deleting}
        error={deleteError}
        onConfirm={() => void onDelete()}
        onClose={() => setConfirmDelete(false)}
      />
    </aside>
  );
}

function FieldBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}
