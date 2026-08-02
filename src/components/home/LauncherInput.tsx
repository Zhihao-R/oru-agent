/**
 * 主页启动器输入栏（设计稿 P8）——624px / 圆角与对话输入栏统一（rounded-sm 4px），默认一行占位；
 * 点击/聚焦展开 38px 工具行（loop 连续模式 + 附件，仅向下展开），右下圆形发送钮；
 * 点击输入框外（焦点离开整个框）才收回——不随鼠标移出即收。
 * 聚焦态与对话输入栏统一（oru-lamp 灯光 + focus-within 边线/光晕，日夜同款）。
 *
 * 复用对话输入栏的底层：草稿文本 / 附件按 per-agent 草稿桶（composerKey(agentId, null)）缓存，
 * loop 走 `/loop ` 命令前缀（与 ChatInput 同一路径），附件走 addAttachments + useImagePicker。
 * 提交交给上层：新建对话 → 带文本/附件切对话页。展开态经 onExpandedChange 上报父级做向下位移补偿。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Paperclip, Repeat } from 'lucide-react';
import { LOOP_TYPED_PREFIX } from '@shared/loop/parseLoopCommand';
import { useChatStore, composerKey, EMPTY_REFS } from '@/stores/chatStore';
import { useImagePicker } from '@/components/ui/useImagePicker';
import { AttachmentStrip } from '@/components/ui/AttachmentStrip';
import { LoopTag } from '@/components/ui/LoopTag';
import { RefChip } from '@/components/ui/RefChip';
import { EMPTY_ATTACHMENTS, IMAGE_ACCEPT, type PendingAttachment } from '@/lib/imageAttachments';
import { useVisionEnabled } from '@/hooks/useVisionEnabled';
import { cn } from '@/lib/cn';

type Props = {
  agentId: string | null;
  oruName: string;
  disabled: boolean;
  /** 提交：text 已含 loop 前缀（若开）；attachments 为草稿桶内附件。 */
  onSubmit: (text: string, attachments?: PendingAttachment[]) => void;
  /** 工具行展开态上报父级——父级据此把「反向占位」收在整列最底部（见 Launcher 注释）。 */
  onExpandedChange?: (expanded: boolean) => void;
};

export const TOOLROW_H = 38;

export function LauncherInput({ agentId, oruName, disabled, onSubmit, onExpandedChange }: Props) {
  const { t } = useTranslation('home');
  const { visionEnabled, visionDisabledHint } = useVisionEnabled();
  const draftKey = composerKey(agentId, null);
  const text = useChatStore((s) => (draftKey ? s.draftTextByConv[draftKey] ?? '' : ''));
  const attachments = useChatStore((s) =>
    draftKey ? s.attachmentsByConv[draftKey] ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS,
  );
  const setDraftText = useChatStore((s) => s.setDraftText);
  const addAttachments = useChatStore((s) => s.addAttachments);
  const setAttachments = useChatStore((s) => s.setAttachments);
  const removeAttachmentInStore = useChatStore((s) => s.removeAttachment);
  // 引用 chip（文件树右键 / 拖拽、编辑器与文稿选段「加入对话」）同样落 draftKey 桶——
  // 新对话没有 convId，引用先寄存在草稿桶，提交时由 HomeLanding 的 migrateComposerRefs 随会话搬走。
  const refs = useChatStore((s) => (draftKey ? s.composerRefsByConv[draftKey] ?? EMPTY_REFS : EMPTY_REFS));
  const removeComposerRef = useChatStore((s) => s.removeComposerRef);
  const addFileRef = useChatStore((s) => s.addFileRef);
  // Loop 意图与草稿同源分桶（draftKey）：切分身自动读对应桶、不跨分身串味，与 draft/附件持久性一致。
  const loopOn = useChatStore((s) => (draftKey ? s.loopModeByConv[draftKey] ?? false : false));
  const setLoopMode = useChatStore((s) => s.setLoopMode);

  const [open, setOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const onAddFiles = (files: File[]): string | null => {
    if (!visionEnabled) return visionDisabledHint || t('launcher.attachTooltip');
    if (!draftKey) return null;
    return addAttachments(draftKey, files);
  };
  // 文件树拖进来的条目一律变成 file 引用（含图片，与对话输入栏同一决策）——不走视觉附件那条
  const onDropFileRef = (data: { path: string; name: string }): void => {
    if (!draftKey) return;
    addFileRef(draftKey, data);
  };
  const picker = useImagePicker(onAddFiles, onDropFileRef);

  // 用户在开头手打 `/loop ` → 摘成标签并点亮开关（与 ChatInput 同规则，边界引用共享单源）
  const onChangeText = (value: string) => {
    if (!draftKey) return;
    const m = LOOP_TYPED_PREFIX.exec(value);
    if (m && !loopOn) {
      setLoopMode(draftKey, true);
      setDraftText(draftKey, value.slice(m[0].length));
      return;
    }
    setDraftText(draftKey, value);
  };

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [text]);

  const hasContent = text.trim().length > 0 || attachments.length > 0 || refs.length > 0;
  // 工具行展开：点击 / 聚焦即开、有内容常驻；焦点离开整个输入框才收回
  const toolRowOpen = open || hasContent;

  // 展开态上报父级：反向占位由 Launcher 收在整列最底部，让「最近对话」恒贴输入框底、随其一起下移。
  // 必须 useLayoutEffect（paint 前）——用 useEffect 会晚一帧：工具行已长、占位还没缩，整列瞬间变高、
  // justify-center 把上半部往上顶一帧再弹回，就是「上方组件抖动」的来源。
  useLayoutEffect(() => onExpandedChange?.(toolRowOpen), [toolRowOpen, onExpandedChange]);

  const submit = () => {
    if (disabled || !draftKey) return;
    const trimmed = text.trim();
    // 仅引用 / 仅图 / 仅文都可发（与对话输入栏同口径）
    if (!trimmed && attachments.length === 0 && refs.length === 0) return;
    const finalText = loopOn && trimmed ? `/loop ${trimmed}` : trimmed;
    onSubmit(finalText, attachments.length > 0 ? attachments : undefined);
    setDraftText(draftKey, '');
    setAttachments(draftKey, []);
    setLoopMode(draftKey, false);
    // 引用桶此处不清：新会话还没建，清了 migrateComposerRefs 就没得搬。
    // 搬到新 conv 后由 chatStore.send 拼进消息并清空——引用的生命周期收在那一条链上。
  };

  return (
    <div
      {...picker.dragHandlers}
      onClick={() => {
        setOpen(true);
        textareaRef.current?.focus();
      }}
      onBlur={(e) => {
        // 焦点移出整个输入框（点击框外 / tab 走）才收回；框内切换（textarea↔工具按钮）保持展开
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      className={cn(
        // oru-lamp：与对话输入栏同款聚焦灯光（日间边线 + 夜间呼吸光晕），focus-within 触发
        'oru-lamp relative mt-[30px] w-full max-w-[624px] cursor-text rounded-sm border bg-elevated pl-[18px] pr-[52px] py-2 shadow-night transition-colors duration-150',
        picker.isDragOver
          ? 'border-accent ring-2 ring-accent-ring'
          : 'border-border focus-within:border-lamp-line focus-within:shadow-focus',
      )}
    >
      {refs.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1.5">
          {refs.map((ref) => (
            <RefChip
              key={ref.id}
              chatRef={ref}
              onRemove={() => draftKey && removeComposerRef(draftKey, ref.id)}
            />
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="pt-1.5">
          <AttachmentStrip
            items={attachments}
            onRemove={(id) => draftKey && removeAttachmentInStore(draftKey, id)}
          />
        </div>
      )}
      <div className="flex items-start gap-1.5 pt-[6px]">
        {loopOn && <LoopTag onRemove={() => draftKey && setLoopMode(draftKey, false)} />}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => onChangeText(e.target.value)}
          onFocus={() => setOpen(true)}
          onPaste={picker.onPaste}
          onKeyDown={(e) => {
            // 光标压在最开头再按退格＝删掉 `/loop` 标签
            if (e.key === 'Backspace' && loopOn && draftKey) {
              const ta = textareaRef.current;
              if (ta && ta.selectionStart === 0 && ta.selectionEnd === 0) {
                e.preventDefault();
                setLoopMode(draftKey, false);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('launcher.inputPlaceholder', { name: oruName })}
          className="oru-input-scroll block max-h-[140px] min-h-[32px] flex-1 resize-none bg-transparent text-[13.5px] leading-relaxed text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:cursor-not-allowed"
        />
      </div>
      <div
        className="overflow-hidden"
        // 与下方反向占位用逐字节相同的 height 过渡，保证每帧高度和严格 = 38（零抖动）；opacity 单列不影响布局
        style={{
          height: toolRowOpen ? TOOLROW_H : 0,
          opacity: toolRowOpen ? 1 : 0,
          transition: 'height 250ms ease-out, opacity 200ms ease-out',
        }}
      >
        <div className="flex items-center gap-1.5 pt-2.5">
          <input
            ref={picker.fileInputRef}
            type="file"
            multiple
            accept={IMAGE_ACCEPT}
            hidden
            onChange={(e) => {
              picker.onPickFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            title={t('launcher.loopTooltip')}
            aria-pressed={loopOn}
            onClick={(e) => {
              e.stopPropagation();
              if (draftKey) setLoopMode(draftKey, !loopOn);
            }}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded',
              loopOn
                ? 'bg-accent-soft text-accent-deep'
                : 'text-text-tertiary hover:bg-sunken-2 hover:text-text-primary',
            )}
          >
            <Repeat size={14} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            title={visionEnabled ? t('launcher.attachTooltip') : visionDisabledHint}
            disabled={!visionEnabled}
            onClick={(e) => {
              e.stopPropagation();
              picker.fileInputRef.current?.click();
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-sunken-2 hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Paperclip size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <button
        type="button"
        aria-label={t('launcher.sendAria')}
        onClick={(e) => {
          e.stopPropagation();
          submit();
        }}
        // 设计稿：发送钮恒为 accent 实心圆；空内容点击 submit 内部自会 no-op（不额外做 disabled 态）
        className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-accent text-[var(--accent-fg)] disabled:opacity-40"
        disabled={disabled}
      >
        <ArrowUp size={13} strokeWidth={1.8} />
      </button>
    </div>
  );
}
