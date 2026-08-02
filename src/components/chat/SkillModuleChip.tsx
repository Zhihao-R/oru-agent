/**
 * Skill 模块（v1）chip 渲染——7 个 kind 共享一个轻量 chip 风格，跟现有工具调用 chip 视觉一致。
 *
 * kind 映射文案：
 * - plugin-install / -update / -uninstall : 已安装 / 升级 / 卸载 plugin X
 * - plugin-activate                       : ⚙ 激活了 X plugin（PRD L128）
 * - skill-call                            : 📖 用了 X skill（PRD L129）
 * - skill-create / -patch                 : 已新建 / 修改 skill X
 *
 * 错误态：errorMessage 有值时改红色 + "操作失败"前缀。
 */
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ChatMessage } from '@shared/types';
import { Check, AlertCircle, Cog, BookOpen, RefreshCw, Trash2, FilePlus, Pencil } from 'lucide-react';
import { cn } from '@/lib/cn';

type Props = { message: ChatMessage };

export function SkillModuleChip({ message }: Props) {
  const { t } = useTranslation('chat');
  const kind = message.kind;
  const payload = message.skillModuleAction;
  const isError = !!payload?.errorMessage;

  const { icon: Icon, text, tone } = renderContent(kind, payload, isError, t);

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 self-start rounded-md border px-2 py-1 text-xs',
        tone === 'error'
          ? 'border-danger bg-danger-soft text-danger'
          : tone === 'success'
            ? 'border-success bg-success-soft text-success'
            : 'border-border bg-canvas/50 text-text-secondary',
      )}
    >
      <Icon size={12} strokeWidth={2} />
      <span>{text}</span>
    </div>
  );
}

function renderContent(
  kind: ChatMessage['kind'],
  payload: ChatMessage['skillModuleAction'],
  isError: boolean,
  t: TFunction,
): {
  icon: typeof Check;
  text: string;
  tone: 'error' | 'success' | 'neutral';
} {
  if (isError) {
    return {
      icon: AlertCircle,
      text: t('skillModule.opFailed', { error: payload?.errorMessage ?? t('skillModule.unknownError') }),
      tone: 'error',
    };
  }
  const name = payload?.name ?? '';
  switch (kind) {
    case 'plugin-install':
      return { icon: Check, text: t('skillModule.pluginInstalled', { name }), tone: 'success' };
    case 'plugin-update':
      return { icon: RefreshCw, text: t('skillModule.pluginUpdated', { name }), tone: 'success' };
    case 'plugin-uninstall':
      return { icon: Trash2, text: t('skillModule.pluginUninstalled', { name }), tone: 'neutral' };
    case 'plugin-activate':
      return { icon: Cog, text: t('skillModule.pluginActivated', { name }), tone: 'neutral' };
    case 'skill-call':
      return { icon: BookOpen, text: t('skillModule.skillCalled', { name }), tone: 'neutral' };
    case 'skill-create':
      return { icon: FilePlus, text: t('skillModule.skillCreated', { name }), tone: 'success' };
    case 'skill-patch':
      return { icon: Pencil, text: t('skillModule.skillPatched', { name }), tone: 'success' };
    default:
      return { icon: Check, text: t('skillModule.opDone'), tone: 'neutral' };
  }
}
