/**
 * 档案「修改历史」小气泡（demo `.hist`）——贴 ProfileDocView 卡片右上，288px 去噪清单。
 *
 * 刻意不复用 FileHistoryDialog（那是带 diff 的大模态、供项目/csv/deck）：档案历史要轻、
 * 贴卡片、一眼可读「谁改了什么、几时、能不能恢复」。数据同走 memory 历史 WS
 * （memory.history.list / restore），仅换一套克制的呈现。
 *
 * 定位：绝对定位于工具条行（调用方把工具条 div 设 relative），从 ⏱ 下方弹出（top-full）、
 * 右对齐工具条右缘——锚在工具条而非卡片根，避免被流式 padding 偏移算错、盖住图标。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { FileSnapshotKind, FileSnapshotRef } from '@shared/types';
import type { MemoryHistoryListResultEvent } from '@shared/protocol';
import { wsClient } from '@/lib/ws';

function formatTime(ts: number, t: TFunction): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return t('aboutFull.hist.today', { hm });
  return t('aboutFull.hist.date', { month: d.getMonth() + 1, day: d.getDate(), hm });
}

// kind → 一句人话 + 左侧 who 点的色。manual=你、ai=Oru，其余兜底。
function describe(kind: FileSnapshotKind, t: TFunction): { text: string; who: 'you' | 'oru' } {
  if (kind === 'manual') return { text: t('aboutFull.hist.byYou'), who: 'you' };
  if (kind === 'ai') return { text: t('aboutFull.hist.byOru'), who: 'oru' };
  return { text: t('aboutFull.hist.byOther'), who: 'you' };
}

type Props = {
  relPath: string;
  /** 点「恢复」把某快照写回工作文件（由 store 实现）；完成后气泡自关 */
  onRestore: (snapshotId: string) => Promise<void>;
  onClose: () => void;
};

export function ProfileHistoryPopover({ relPath, onRestore, onClose }: Props) {
  const { t } = useTranslation('home');
  const [snapshots, setSnapshots] = useState<FileSnapshotRef[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await wsClient.request<MemoryHistoryListResultEvent>({
        type: 'memory.history.list',
        relPath,
      });
      if (cancelled || res.type !== 'memory.history.list.result') return;
      setSnapshots([...res.snapshots].sort((a, b) => b.createdAt - a.createdAt));
    })();
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  async function restore(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onRestore(id);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="absolute right-0 top-full mt-1.5 z-10 w-72 rounded-[10px] border border-border-strong bg-elevated p-2.5"
      style={{ boxShadow: '0 18px 44px -16px rgba(16,28,34,.34)' }}
    >
      <h4 className="mx-2 mb-2 mt-1.5 text-[11px] font-semibold tracking-[0.04em] text-text-tertiary">
        {t('aboutFull.hist.title')}
      </h4>
      {snapshots.length === 0 ? (
        <p className="px-2 pb-2 text-[11.5px] leading-relaxed text-text-quaternary">
          {t('aboutFull.hist.empty')}
        </p>
      ) : (
        <div className="max-h-[min(50vh,420px)] overflow-y-auto overscroll-contain">
          {snapshots.map((s) => {
            const { text, who } = describe(s.kind, t);
            return (
              <div key={s.id} className="flex items-start gap-[9px] rounded-[7px] p-2 hover:bg-sunken">
                <span
                  className={
                    'mt-1.5 h-[5px] w-[5px] shrink-0 rounded-full ' +
                    (who === 'oru' ? 'bg-accent' : 'bg-text-tertiary')
                  }
                />
                <div className="flex-1">
                  <div className="text-[12.5px] text-text-primary">{text}</div>
                  <div className="mt-px text-[11px] text-text-quaternary">{formatTime(s.createdAt, t)}</div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void restore(s.id)}
                  className="pt-0.5 text-[11.5px] text-accent-deep disabled:opacity-50"
                >
                  {t('aboutFull.hist.restore')}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
