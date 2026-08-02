/**
 * 导入冲突与通知（App 级单例，订阅 table.* 广播）。
 *
 * 冲突（PRD 场景一）：再次拖入同名 xlsx 且现有 CSV 内容不一致——谁的劳动都不该被
 * 冲掉，弹「覆盖 / 另存 / 取消」，按文件粒度排队一事一弹；目标文件有未保存草稿时
 * 附加提示（免得用户连吃两记冲突弹窗）。
 * 通知（失败 / sheet 改名提示）走右下角轻提示，几秒自散，不阻塞任何动作。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TableConflictResolvedEvent } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { useTableStore } from '@/stores/tableStore';
import { useProjectStore } from '@/stores/projectStore';
import { basename } from '@/lib/paths';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';

type Conflict = { conflictId: string; projectId: string; xlsxPath: string; targetPath: string };
type Notice = { id: number; message: string; kind: 'error' | 'info' };

const NOTICE_TTL_MS = 6000;
let noticeSeq = 0;

export function ImportConflictDialog(): JSX.Element | null {
  const { t } = useTranslation('table');
  const [queue, setQueue] = useState<Conflict[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const pushNotice = (message: string, kind: Notice['kind']): void => {
      const id = ++noticeSeq;
      setNotices((prev) => [...prev, { id, message, kind }]);
      setTimeout(() => setNotices((prev) => prev.filter((n) => n.id !== id)), NOTICE_TTL_MS);
    };
    return wsClient.subscribe((ev) => {
      if (ev.type === 'table.importConflict') {
        setQueue((prev) =>
          prev.some((c) => c.conflictId === ev.conflictId)
            ? prev
            : [...prev, { conflictId: ev.conflictId, projectId: ev.projectId, xlsxPath: ev.xlsxPath, targetPath: ev.targetPath }],
        );
      } else if (ev.type === 'table.importFailed') {
        pushNotice(ev.message, 'error');
      } else if (ev.type === 'table.importNotice') {
        pushNotice(ev.message, 'info');
      }
    });
  }, []);

  // 切项目收掉旧项目的冲突队列（与 FileTree 收口 html/表格同一模式）；main 侧
  // 残留的 pendingConflicts 无人应答即永久挂起，无副作用
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  useEffect(() => {
    setQueue((prev) => prev.filter((c) => c.projectId === activeProjectId));
  }, [activeProjectId]);

  const head = queue[0] ?? null;

  // 目标文件有未保存改动 → 弹窗内附加提示（仅表格仍有未落盘态；md 已实时落盘无草稿）
  const targetHasDraft =
    head !== null && (useTableStore.getState().tables[head.targetPath]?.dirty ?? false);

  async function resolve(choice: 'overwrite' | 'saveAs' | 'cancel'): Promise<void> {
    if (!head || busy) return;
    setBusy(true);
    try {
      const r = await wsClient.request<TableConflictResolvedEvent>({
        type: 'table.resolveImportConflict',
        conflictId: head.conflictId,
        choice,
      });
      if (r.outcome === 'savedAs' && r.savedAsPath) {
        setNotices((prev) => [...prev, { id: ++noticeSeq, message: t('import.savedAs', { name: basename(r.savedAsPath!) }), kind: 'info' }]);
      }
      // reconflict：main 已按新快照重发一条 importConflict 事件，订阅里会排进队尾
    } catch {
      // 失败让用户重试（弹窗保留）
      setBusy(false);
      return;
    }
    setQueue((prev) => prev.slice(1));
    setBusy(false);
  }

  return (
    <>
      <Dialog
        open={head !== null}
        onClose={() => void resolve('cancel')}
        title={t('import.title')}
        description={
          head
            ? t('import.desc', { source: basename(head.xlsxPath), target: basename(head.targetPath) })
            : undefined
        }
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button disabled={busy} onClick={() => void resolve('cancel')}>
              {t('common:cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void resolve('saveAs')}>
              {t('import.saveAs')}
            </Button>
            <Button disabled={busy} variant="danger" onClick={() => void resolve('overwrite')}>
              {t('import.overwrite')}
            </Button>
          </div>
        }
      >
        <div className="space-y-2 text-sm text-text-secondary">
          <div>{head ? basename(head.targetPath) : ''}</div>
          {targetHasDraft && (
            <div className="rounded-md bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
              {t('import.draftWarn')}
            </div>
          )}
          {queue.length > 1 && <div className="text-xs text-text-tertiary">{t('import.queueMore', { count: queue.length - 1 })}</div>}
        </div>
      </Dialog>

      {notices.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
          {notices.map((n) => (
            <div
              key={n.id}
              className={
                n.kind === 'error'
                  ? 'rounded-lg border border-danger bg-elevated px-3 py-2 text-xs text-danger shadow-pop'
                  : 'rounded-lg border border-border bg-elevated px-3 py-2 text-xs text-text-secondary shadow-pop'
              }
            >
              {n.message}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
