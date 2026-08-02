/**
 * 对话类别图标——对话列表 ConvRow 与定时任务对话选择器共用一份渲染。
 * 类别判定走 conversationIconKind（共享纯函数），加第三种来源零成本。
 */
import { MessageSquare, Sparkle } from 'lucide-react';
import type { Conversation } from '@shared/types';
import { PlatformGlyph } from '@/components/PlatformGlyph';
import { conversationIconKind } from '@/lib/conversationGrouping';

export function ConversationIcon({ conv, size = 12 }: { conv: Conversation; size?: number }) {
  const kind = conversationIconKind(conv);
  if (kind === 'aside') {
    return <Sparkle size={size} strokeWidth={1.5} className="shrink-0 text-text-tertiary" />;
  }
  if (kind === 'platform' && conv.source) {
    return (
      <PlatformGlyph
        platform={conv.source.platform}
        size={size}
        className="shrink-0 text-text-tertiary"
      />
    );
  }
  return <MessageSquare size={size} strokeWidth={1.5} className="shrink-0 text-text-tertiary" />;
}
