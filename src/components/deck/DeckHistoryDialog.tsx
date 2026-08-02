import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { History, Loader2 } from 'lucide-react';
import type { HistoryVersion } from '@shared/types';
import { useArtifactStore } from '@/stores/artifactStore';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';

/**
 * deck 幻灯片「找回旧版」窗口 —— 与 md/csv 的 FileHistoryDialog 同骨架（标题/说明/左时间轴/底栏恢复），
 * 只把右侧预览换成**该版本的幻灯片缩略图网格**（contact sheet），别的逐像素对齐（技术设计 §7）。
 *
 * 走 deck 自己的版本后端（artifact.listHistory / historyPreview / checkoutHistory），不复用 FileHistory——
 * deck 是带「当前版本指针 + checkout」的有状态模型，恢复=checkout 整套幻灯片（缺图时复用 missingImages 确认）。
 * 不放「清空历史」：deck 版本是用户的成型 commit、不是 md 那种逐键中间态，无清空诉求也无后端。
 */

/** 版本类型 → 展示 label，t 由调用方按 deck ns 绑定传入。 */
function kindLabel(kind: HistoryVersion['kind'], t: TFunction): string {
  return t(`history.kind.${kind}`);
}

function formatTime(ts: number, t: TFunction): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay
    ? t('history.today', { hm })
    : t('history.date', { month: d.getMonth() + 1, day: d.getDate(), hm });
}

function changedSummary(v: HistoryVersion, t: TFunction): string {
  if (v.kind === 'initial') return t('history.firstGen');
  if (v.changedPages.length === 0) return '';
  return t('history.changedPages', { pages: v.changedPages.map((p) => p + 1).join(t('common:listSeparator')) });
}

type Props = {
  open: boolean;
  onClose: () => void;
  artifactId: string;
};

export function DeckHistoryDialog({ open, onClose, artifactId }: Props): JSX.Element {
  const { t } = useTranslation('deck');
  const versions = useArtifactStore((s) => s.versionsByArtifact[artifactId]);
  const currentVersion = useArtifactStore((s) => s.currentVersionByArtifact[artifactId]);
  const refreshVersions = useArtifactStore((s) => s.refreshVersions);
  const historyPreview = useArtifactStore((s) => s.historyPreview);
  const checkoutHistory = useArtifactStore((s) => s.checkoutHistory);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheets, setSheets] = useState<string[] | null>(null);
  const [rendering, setRendering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null); // 缺图确认（非空=待确认）

  // 最新在上；当前版本不可恢复（已经是它）
  const ordered = useMemo(() => [...(versions ?? [])].sort((a, b) => b.createdAt - a.createdAt), [versions]);
  const selected = ordered.find((v) => v.id === selectedId) ?? null;

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setSheets(null);
      setMissing(null);
      return;
    }
    void refreshVersions(artifactId);
  }, [open, artifactId, refreshVersions]);

  // 选中某版本 → 渲染它的缩略图网格
  useEffect(() => {
    if (!open || selectedId === null) {
      setSheets(null);
      return;
    }
    let cancelled = false;
    setRendering(true);
    setSheets(null);
    void historyPreview(artifactId, selectedId)
      .then((imgs) => {
        if (!cancelled) setSheets(imgs);
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, artifactId, selectedId, historyPreview]);

  const doCheckout = useCallback(
    async (force: boolean) => {
      if (selectedId === null) return;
      setBusy(true);
      try {
        const r = await checkoutHistory(artifactId, selectedId, force);
        if (!r.ok && r.missingImages && r.missingImages.length > 0) {
          setMissing(r.missingImages); // 缺图 → 弹内联确认，等用户拍板再 force
          return;
        }
        if (r.ok) onClose(); // 恢复成功（预览经 indexChanged 自动 reload）
      } finally {
        setBusy(false);
      }
    },
    [artifactId, selectedId, checkoutHistory, onClose],
  );

  const isCurrent = selected?.id === currentVersion;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('history.title')}
      description={t('history.description')}
      className="w-[min(960px,calc(100vw-32px))]"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common:close')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void doCheckout(false)}
            disabled={busy || selectedId === null || isCurrent}
          >
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" strokeWidth={1.5} /> : null}
            {isCurrent ? t('history.alreadyThis') : t('history.restore')}
          </Button>
        </div>
      }
    >
      <div className="flex h-[56vh] gap-3">
        {/* 左：时间轴 */}
        <div className="w-56 shrink-0 overflow-y-auto rounded-lg border border-border bg-sunken">
          {ordered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-text-tertiary">
              <History className="h-5 w-5" strokeWidth={1.5} />
              <span>{t('history.empty')}</span>
            </div>
          ) : (
            <ul className="py-1">
              {ordered.map((v) => {
                const cur = v.id === currentVersion;
                const sum = changedSummary(v, t);
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(v.id)}
                      className={
                        'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors ' +
                        (selectedId === v.id ? 'bg-hover' : 'hover:bg-hover/60')
                      }
                    >
                      <span className="flex items-center gap-1.5 text-xs text-text-primary">
                        {formatTime(v.createdAt, t)}
                        {cur ? (
                          <span className="rounded-full bg-success-soft px-1.5 text-2xs leading-snug text-success">
                            {t('history.current')}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-text-tertiary">
                        {kindLabel(v.kind, t)}
                        {sum ? ` · ${sum}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 右：该版本缩略图网格 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
          {selected === null ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-text-tertiary">
              {t('history.pickPrompt')}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border bg-sunken px-3 py-1.5 text-xs text-text-tertiary">
                <span>{t('history.thisOldVersion', { time: formatTime(selected.createdAt, t) })}</span>
                <span>{changedSummary(selected, t) || kindLabel(selected.kind, t)}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-canvas p-3">
                {rendering ? (
                  <div className="flex h-full items-center justify-center gap-2 text-xs text-text-tertiary">
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                    {t('history.rendering')}
                  </div>
                ) : sheets && sheets.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {sheets.map((b64, i) => (
                      // sheetImages 是原始 base64（composeGrid 已剥 data: 前缀），这里补回
                      <img
                        key={i}
                        src={`data:image/png;base64,${b64}`}
                        alt={t('history.thumbAlt', { n: i + 1 })}
                        className="w-full rounded border border-border"
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-text-tertiary">{t('history.noPages')}</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 缺图确认（恢复时旧版引用的图已删）——内联覆盖，复用 checkoutVersion 的 missingImages */}
      {missing ? (
        <div className="mt-3 rounded-lg border border-warn bg-warn-soft p-3 text-xs text-warn">
          <div className="mb-2">
            {t('history.missingImages')}
            <span className="text-warn"> {missing.join(t('common:listSeparator'))}</span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setMissing(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setMissing(null);
                void doCheckout(true);
              }}
            >
              {t('history.restoreAnyway')}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
