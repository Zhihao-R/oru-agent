/**
 * 拒绝附言的共享披露控件（G02）——审批卡拒绝时可选填「为什么不批」，随 proposal.reject 落进
 * 系统记让 Oru 下轮看到。默认折叠为一枚「附言」轻链（克制、不给每张卡加常驻输入框），点开是
 * 一块两行文本域。note 状态由各卡持有（拒绝请求带上 note.trim() || undefined），本控件只管收字。
 *
 * 系统性：五类审批卡（bash / web.fetch / scheduled-task / mcp / skill）的拒绝路径共用同一控件，
 * 不各自发明。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export function RejectNoteDisclosure({
  note,
  setNote,
  disabled,
}: {
  note: string;
  setNote: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('proposal');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="text-xs text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline disabled:opacity-40"
      >
        {t('addNote')}
      </button>
    );
  }
  return (
    <textarea
      value={note}
      onChange={(e) => setNote(e.target.value)}
      placeholder={t('notePlaceholder')}
      rows={2}
      autoFocus
      disabled={disabled}
      className="w-full resize-none rounded-md border border-border bg-sunken px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-accent-ring focus:outline-none disabled:opacity-40"
    />
  );
}
