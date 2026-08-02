/**
 * 聊天输入框
 *
 * 三种添加图片方式（仅 visionEnabled=true 时生效）：
 *   1. 📎 按钮 → 系统文件选择器（多选）
 *   2. Cmd/Ctrl + V 粘贴 → 剪贴板含图自动入 strip
 *   3. 拖拽到输入区
 *
 * 限制：单张 ≤ 5 MB、单条 ≤ 8 张、4 种格式（PNG/JPEG/GIF/WEBP）
 * visionEnabled=false 时 📎 disabled、粘贴/拖图被拒并 alert
 *
 * 草稿与附件均由 chatStore 按 conv 分桶缓存（draftTextByConv / attachmentsByConv）——
 * 切对话只是读不同 bucket，无需清空；blob URL 生命周期由 store 的 removeAttachment /
 * loadHistory 收口。校验逻辑也在 store.addAttachments，本组件只管 UI（含 visionEnabled 门槛）。
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { flushSync } from 'react-dom';
import { ArrowUp, Paperclip, Repeat } from 'lucide-react';
import { LOOP_TYPED_PREFIX } from '@shared/loop/parseLoopCommand';
import { cn } from '@/lib/cn';
import { useOruName } from '@/lib/oruName';
import { IconButton } from '../ui/IconButton';
import { AttachmentStrip } from '../ui/AttachmentStrip';
import { LoopTag } from '../ui/LoopTag';
import { RefChip } from '../ui/RefChip';
import { useImagePicker } from '../ui/useImagePicker';
import { EMPTY_ATTACHMENTS, IMAGE_ACCEPT, type PendingAttachment } from '@/lib/imageAttachments';
import { EMPTY_REFS, useChatStore } from '@/stores/chatStore';
import { PendingHandbackStrip } from './PendingHandbackStrip';

export interface ChatInputProps {
  /** 当前 active conversation id；用于从 store 读/写本对话的草稿。null 时输入框可读但发送禁用 */
  conversationId: string | null;
  disabled?: boolean;
  /**
   * 该对话回合在跑（忙）。Steering：忙时**不再锁文字输入**（可中途补话转向），仅**禁附件入口**
   * （v1 纯文本 steering）。disabled（无对话等硬禁用）才整体不可用。
   */
  busy?: boolean;
  placeholder?: string;
  /** 当前 twinMain 模型是否支持视觉；false 时 📎 disabled、粘贴/拖图被拒 */
  visionEnabled?: boolean;
  /** visionEnabled=false 时 📎 tooltip 文案；上层由模型分配状况算出来 */
  visionDisabledHint?: string;
  /** 挂载时自动聚焦（草稿态新对话界面：打开即可直接敲字） */
  autoFocus?: boolean;
  onSend: (text: string, attachments?: PendingAttachment[]) => void;
}

export function ChatInput({
  conversationId,
  disabled,
  busy,
  placeholder,
  visionEnabled,
  visionDisabledHint,
  autoFocus,
  onSend,
}: ChatInputProps) {
  const { t } = useTranslation('chat');
  const oruName = useOruName();
  // text 直接从 store 读 active conv 的草稿——单一真相、零桥接
  const text = useChatStore((s) =>
    conversationId ? s.draftTextByConv[conversationId] ?? '' : '',
  );
  const setDraftText = useChatStore((s) => s.setDraftText);
  const attachments = useChatStore((s) =>
    conversationId ? s.attachmentsByConv[conversationId] ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS,
  );
  const addAttachments = useChatStore((s) => s.addAttachments);
  const setAttachments = useChatStore((s) => s.setAttachments);
  const removeAttachmentInStore = useChatStore((s) => s.removeAttachment);
  // 选段「加入对话」引用 chip（chip 前后照常打字，chip 在输入区上方独立成行）
  const refs = useChatStore((s) =>
    conversationId ? s.composerRefsByConv[conversationId] ?? EMPTY_REFS : EMPTY_REFS,
  );
  const removeComposerRef = useChatStore((s) => s.removeComposerRef);
  const addFileRef = useChatStore((s) => s.addFileRef);
  // Loop 模式是**发送意图**（boolean），不是塞进草稿的文字——输入框只呈现一枚 `/loop` 标签，
  // 送出时才前置 `/loop `（backend parseLoopCommand 的契约）。
  const loopMode = useChatStore((s) =>
    conversationId ? s.loopModeByConv[conversationId] ?? false : false,
  );
  const setLoopMode = useChatStore((s) => s.setLoopMode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 选图三件套接线；vision 门槛与 store 校验都在 onAddFiles 里收口
  const onAddFiles = (files: File[]): string | null => {
    if (!visionEnabled) return visionDisabledHint ?? t('input.visionUnsupported');
    if (!conversationId) return null;
    return addAttachments(conversationId, files);
  };
  // 文件树拖进对话：一律变成 file 引用（含图片，决策三）——不走视觉附件那条
  const onDropFileRef = (data: { path: string; name: string }): void => {
    if (!conversationId) return;
    addFileRef(conversationId, data);
  };
  const picker = useImagePicker(onAddFiles, onDropFileRef);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  // 草稿态新对话界面：挂载即聚焦输入框
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    // Steering：忙时（busy）不拦——中途补话进队列；硬禁用（disabled / 无对话）才拦。
    if (disabled || !conversationId) return;
    const trimmed = text.trim();
    // 仅引用 / 仅图 / 仅文都可发；refs 由 chatStore.send 拼进消息后清空
    if (!trimmed && attachments.length === 0 && refs.length === 0) return;
    // Loop 意图在送出这一刻才落成 `/loop ` 前缀（仅当有目标文字；裸 loop 无意义，与 Launcher 同）。
    const finalText = loopMode && trimmed ? `/loop ${trimmed}` : trimmed;
    onSend(finalText, attachments.length > 0 ? attachments : undefined);
    // 立即清空草稿 + 附件 + loop 意图——避免 pending 期间用户开始新输入被后续覆盖
    // 失败时用户可点 [重试]（chatStore.lastSentByConv 已存内容）
    // 注意：清空走 setAttachments 不 revoke——外层乐观 ChatMessage 仍引用 displayUrl，
    // 由 loadHistory 收到 oru-conv-img:// 版本时统一 revoke blob:。
    setDraftText(conversationId, '');
    setAttachments(conversationId, []);
    setLoopMode(conversationId, false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 光标压在最开头再按退格＝删掉 `/loop` 标签（与真 chip 的删除手势一致），不误删文字
    if (e.key === 'Backspace' && loopMode && conversationId) {
      const ta = textareaRef.current;
      if (ta && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        setLoopMode(conversationId, false);
        return;
      }
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey) {
      // Cmd/Ctrl+Enter 换行：修饰键默认不输入换行，手动在光标处插入
      e.preventDefault();
      insertNewlineAtCursor();
      return;
    }
    if (e.shiftKey) return; // Shift+Enter 走原生换行
    e.preventDefault();
    submit();
  };

  /** 在光标处插入换行；flushSync 同步 commit 后再复位光标，避免受控更新把光标冲到末尾 */
  const insertNewlineAtCursor = () => {
    const ta = textareaRef.current;
    if (!ta || !conversationId) return;
    const { selectionStart: start, selectionEnd: end } = ta;
    flushSync(() => {
      setDraftText(conversationId, text.slice(0, start) + '\n' + text.slice(end));
    });
    ta.selectionStart = ta.selectionEnd = start + 1;
  };

  const removeAttachment = (id: string) => {
    if (conversationId) removeAttachmentInStore(conversationId, id);
  };

  // Loop 模式开关（开关式）：点一次亮起标签、再点熄灭。标签是状态的唯一呈现，草稿文字保持干净。
  const toggleLoop = () => {
    if (!conversationId) return;
    setLoopMode(conversationId, !loopMode);
    textareaRef.current?.focus();
  };

  // 输入变更：用户在开头手打 `/loop ` 时自动识别——把命令前缀摘成 `/loop` 标签、点亮开关，
  // 文字只留目标。边界引用 @shared/loop/parseLoopCommand 单源（`/loop` 后须接空白，`/loopback`
  // 不算），仅在出现分隔空白时才转，避免打到一半的 `/loop` 被抢先吃掉。
  const onChangeText = (value: string) => {
    if (!conversationId) return;
    const m = LOOP_TYPED_PREFIX.exec(value);
    if (m && !loopMode) {
      setLoopMode(conversationId, true);
      setDraftText(conversationId, value.slice(m[0].length));
      return;
    }
    setDraftText(conversationId, value);
  };

  const hasContent = text.trim().length > 0 || attachments.length > 0 || refs.length > 0;
  // Steering：忙时仍可发（busy 不进禁用）；硬禁用 / 无内容才不可发。
  const canSend = !disabled && Boolean(conversationId) && hasContent;

  return (
    <div className="flex w-full flex-col gap-2">
      {/* 待处理项（G14）：故障 / 中断交还的机器触发与渠道消息，列在 composer 上方可放行 / 清掉 */}
      <PendingHandbackStrip conversationId={conversationId} />
      <div
      {...picker.dragHandlers}
      className={cn(
        // oru-lamp＝夜间聚焦呼吸光晕（index.css），需配 relative 给伪元素定位
        'oru-lamp relative flex w-full flex-col gap-2 rounded-sm border bg-elevated px-3 py-2 shadow-night transition-colors duration-150',
        disabled
          ? 'border-border opacity-60'
          : 'border-border focus-within:border-lamp-line focus-within:shadow-focus',
        picker.isDragOver ? 'border-accent ring-2 ring-accent-ring' : '',
      )}
    >
      {refs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {refs.map((ref) => (
            <RefChip
              key={ref.id}
              chatRef={ref}
              onRemove={() => conversationId && removeComposerRef(conversationId, ref.id)}
            />
          ))}
        </div>
      )}

      <AttachmentStrip items={attachments} onRemove={removeAttachment} />

      {/* 方案 A：文字独占整宽（不再与按钮同排），控件下沉为底部工具栏——左下低频 loop/附件、
          右下发送。消除多行时右侧被按钮列空出的死白。
          Loop 开启时在文字开头内联一枚 `/loop` 标签（items-start：多行时标签贴顶）。 */}
      <div className="flex items-start gap-1.5">
        {loopMode && (
          <LoopTag onRemove={() => conversationId && setLoopMode(conversationId, false)} />
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => onChangeText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={picker.onPaste}
          disabled={disabled || !conversationId}
          placeholder={placeholder ?? t('input.placeholder', { name: oruName })}
          className={cn(
            'oru-input-scroll min-h-[28px] flex-1 resize-none bg-transparent text-sm leading-relaxed text-text-primary placeholder:text-text-tertiary',
            'focus:outline-none disabled:cursor-not-allowed',
          )}
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
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
            label={loopMode ? t('input.loopOn') : t('input.loopOff')}
            disabled={disabled || !conversationId}
            onClick={toggleLoop}
            className={cn(
              loopMode ? 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent' : '',
            )}
          >
            <Repeat size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton
            size="sm"
            label={visionEnabled ? t('input.attach') : (visionDisabledHint ?? t('input.visionDisabledShort'))}
            // 忙时不禁（G02：插话带附件，队列/盘记/交还全程带引用——粘贴/拖拽路径本就通，按钮同权）；
            // 按 vision 能力与硬禁用决定。
            disabled={!visionEnabled || disabled}
            onClick={picker.openPicker}
          >
            <Paperclip size={14} strokeWidth={1.8} />
          </IconButton>
        </div>
        <IconButton
          size="sm"
          label={t('input.send')}
          onClick={submit}
          disabled={!canSend}
          // 圆形实心 accent 主操作；不可发时靠 IconButton 的 disabled:opacity-50 淡出（仍是实心圆）。
          // 前景读 --accent-fg（夜间 accent 提亮后深字才够对比），写死 text-white 只对日间成立
          className="rounded-full bg-accent text-[var(--accent-fg)] hover:bg-accent-deep hover:text-[var(--accent-fg)]"
        >
          <ArrowUp size={14} strokeWidth={1.8} />
        </IconButton>
      </div>
      </div>
    </div>
  );
}
