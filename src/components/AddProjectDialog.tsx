import { useEffect, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderPlus } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useProjectStore } from '@/stores/projectStore';
import { cn } from '@/lib/cn';

export interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

function getDroppedPath(file: File | undefined): string | null {
  if (!file) return null;
  const p = window.__ORU__?.getPathForFile?.(file);
  return p && p.length > 0 ? p : null;
}

export function AddProjectDialog({ open, onClose }: AddProjectDialogProps) {
  const { t } = useTranslation('app');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const addProject = useProjectStore((s) => s.addProject);

  useEffect(() => {
    if (open) return;
    setError(null);
    setSubmitting(false);
    setDragOver(false);
  }, [open]);

  // 选中即添加：拖拽与浏览共用此路径，避免两种入口行为分叉。
  const submit = async (target: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await addProject(target);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const browse = async () => {
    if (submitting) return;
    const picked = await window.__ORU__?.pickDirectory?.();
    if (picked) void submit(picked);
  };

  const handleDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (submitting) return;
    const dropped = getDroppedPath(e.dataTransfer.files[0]);
    if (!dropped) {
      setError(t('addProject.dropError'));
      return;
    }
    void submit(dropped);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('addProject.title')}
      description={t('addProject.description')}
      footer={
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
          {t('common:cancel')}
        </Button>
      }
    >
      <button
        type="button"
        onClick={() => void browse()}
        disabled={submitting}
        onDragOver={(e) => {
          e.preventDefault();
          if (!submitting && !dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-sunken/40 px-6 py-10 transition-colors',
          'hover:border-accent hover:bg-accent-soft disabled:cursor-default disabled:opacity-60',
          dragOver && 'border-accent bg-accent-soft',
        )}
      >
        <FolderPlus
          size={28}
          strokeWidth={1.5}
          className={cn('transition-colors', dragOver ? 'text-accent' : 'text-text-tertiary')}
        />
        <div className="text-center">
          <div className="text-sm text-text-primary">
            {submitting ? t('addProject.adding') : dragOver ? t('addProject.releaseToAdd') : t('addProject.dropHint')}
          </div>
          <div className="mt-1 text-xs text-text-tertiary">{t('addProject.fromFinder')}</div>
        </div>
      </button>

      {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
    </Dialog>
  );
}
