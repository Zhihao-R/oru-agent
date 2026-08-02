/**
 * 评论输入框：单层 textarea + 可选图片。
 *
 * 历史曾用 textarea + 透明文本 + overlay 高亮 双层方案在输入态展示 @oru chip，
 * 但 textarea 与 div 的 CJK 字体度量不一致（caret 与 overlay 文本错位 → "光标在字中间"），
 * 度量对齐难以稳定。chip 仅在提交后 CommentRow.renderUserText 渲染即可，输入态保持
 * 单层 textarea，光标自然对齐。
 *
 * 图片：选文件 / 粘贴 / 拖拽三件套，复用聊天侧的 useImagePicker + AttachmentStrip。
 * 上传始终可用（图片是给自己的可视笔记）；模型是否看得到由后端按 vision 能力决定——
 * 非 vision 模型 @oru 时图片仅作留言展示、不进模型输入。本地 state 持有待发送图，
 * 提交后由乐观消息接管 blob，applyNoteAdded 收到真实 oru-conv-img:// 时 revoke。
 *
 * 键盘（与主聊天一致，键位表见 docs/plans/2026-07-15-任务板块优化方案.md 五·minor）：
 *   - Enter：发送
 *   - Shift + Enter：换行
 *   - Esc：清空（保留——不杀对话流）
 *
 * 提交：检测正文是否含 @oru → mentions=['oru'] 走 comment.send；否则 [] 走 note.add
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Paperclip, Send } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { AttachmentStrip } from '@/components/ui/AttachmentStrip';
import { useImagePicker } from '@/components/ui/useImagePicker';
import { usePendingImages } from '@/components/ui/usePendingImages';
import { IMAGE_ACCEPT } from '@/lib/imageAttachments';
import { useTaskboardCommentStore } from '@/stores/taskboardCommentStore';

const MENTION_REGEX = /(@oru\b)/gi;

export type CommentInputProps = {
  taskId: string;
  /** 是否禁用——比如 task 已删除时（PR-D3 默认不传，由 caller 控制） */
  disabled?: boolean;
};

export function CommentInput({ taskId, disabled }: CommentInputProps) {
  const { t } = useTranslation('taskboard');
  const [text, setText] = useState('');
  // 待发送图片：原子上限 + blob 生命周期（含卸载清理）都由 hook 收口；上传始终可用，无 vision 门控
  const images = usePendingImages();
  const send = useTaskboardCommentStore((s) => s.send);

  const picker = useImagePicker(images.add);

  const submit = async () => {
    const trimmed = text.trim();
    if ((!trimmed && images.items.length === 0) || disabled) return;
    const mentions = MENTION_REGEX.test(trimmed) ? ['oru'] : [];
    // reset MENTION_REGEX 状态（global flag 有 lastIndex 副作用）
    MENTION_REGEX.lastIndex = 0;
    const sent = images.items;
    setText('');
    // 不 revoke——乐观消息仍引用这些 blob，由 applyNoteAdded 收到 oru-conv-img:// 时统一 revoke
    images.clearWithoutRevoke();
    await send(taskId, trimmed, mentions, sent.length > 0 ? sent : undefined);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition 期间（中文 / 日文等输入法选词中）不响应快捷键，避免发送未完成的拼音
    if (e.nativeEvent.isComposing) return;
    // 回车发送、Shift+Enter 换行（Shift+Enter 走 textarea 默认换行，不拦）
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      // 丢弃草稿：文本 + 待发送图一并清掉（图需 revoke——不会被任何消息接管）
      setText('');
      images.clear();
    }
  };

  const canSend = !disabled && (text.trim().length > 0 || images.items.length > 0);

  return (
    <div>
      <div
        {...picker.dragHandlers}
        className={cn(
          'flex flex-col gap-2 rounded-md border bg-transparent px-2.5 py-2 transition-colors duration-150',
          disabled
            ? 'border-border opacity-60'
            : 'border-border focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring',
          picker.isDragOver ? 'border-accent ring-2 ring-accent-ring' : '',
        )}
      >
        <AttachmentStrip items={images.items} onRemove={images.remove} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={picker.onPaste}
          placeholder={t('comment.placeholder')}
          disabled={disabled}
          rows={3}
          className="block w-full resize-y bg-transparent text-sm leading-[1.5] text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <input
          ref={picker.fileInputRef}
          type="file"
          multiple
          accept={IMAGE_ACCEPT}
          hidden
          onChange={(e) => {
            picker.onPickFiles(e.target.files);
            e.target.value = ''; // 让同名文件再次选择能 trigger
          }}
        />
        <IconButton
          size="sm"
          label={t('comment.attach')}
          disabled={disabled}
          onClick={picker.openPicker}
        >
          <Paperclip size={14} strokeWidth={1.8} />
        </IconButton>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-text-tertiary sm:inline">{t('comment.sendHint')}</span>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Send size={12} strokeWidth={1.5} />}
            onClick={() => void submit()}
            disabled={!canSend}
          >
            {t('comment.send')}
          </Button>
        </div>
      </div>
    </div>
  );
}
