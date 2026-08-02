/**
 * 「项目未版本管理提示」条
 *
 * 由 chat.gitHint 事件触发（当天首次要改某个非 git 项目）。对话流里一条独立的、
 * 淡琥珀底色、单行 ⚠ + 一句话、没有任何按钮的提示条——客观事实陈述（系统口吻）。
 * 不依附提案卡，稳稳留在对话记录里事后翻得到。
 */
import { AlertTriangle } from 'lucide-react';
import type { ChatMessage } from '@shared/types';

type Props = {
  message: ChatMessage; // kind === 'git-hint'
};

export function GitHintNotice({ message }: Props) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warn bg-warn-soft px-3 py-2 text-xs text-text-secondary">
      <AlertTriangle size={14} strokeWidth={1.5} className="shrink-0 text-warn" />
      <span>{message.text}</span>
    </div>
  );
}
