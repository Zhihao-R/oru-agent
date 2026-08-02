/**
 * "Oru 思考中…" 静态行：与 CommentRow 同款 [头像 + 内容] 布局。
 *
 * MVP 简化（per 用户决定）：
 * - 不加 idle watchdog（靠 ws 断 / chat.error / 用户手动 abort）
 * - 不接 hint（动态从 toolCall 推 hint 增加复杂度，先看实际体验再加）
 */
import { useTranslation } from 'react-i18next';
import { TwinAvatar } from '@/components/TwinAvatar';
import { useAgentStore } from '@/stores/agentStore';

export function OruThinkingRow() {
  const { t } = useTranslation('taskboard');
  const oruAvatarPath = useAgentStore(
    (s) => s.agents.find((a) => a.id === s.activeAgentId)?.avatarPath ?? null,
  );
  return (
    <div className="flex gap-3 py-2">
      <TwinAvatar size={24} avatarPath={oruAvatarPath} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex gap-0.5 text-text-tertiary">
          <span className="animate-pulse">●</span>
          <span className="animate-pulse" style={{ animationDelay: '120ms' }}>●</span>
          <span className="animate-pulse" style={{ animationDelay: '240ms' }}>●</span>
        </div>
        <span className="text-xs text-text-tertiary">{t('oruThinking')}</span>
      </div>
    </div>
  );
}
