import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';

/**
 * 「更新演示设计」前的轻量确认：deck 上还有 N 处未处理标注时弹出。
 *
 * 更新会按文稿改页面，可能让这些标注错位或失效，故先问要不要一并改：
 * - 仅按文稿改 → updateFromNarrative(false)
 * - 连批注一并改 → updateFromNarrative(true)
 * 复用通用 Dialog（背景模糊、无阴影叠层走 token）。
 */
type Props = {
  open: boolean;
  pendingCount: number;
  onClose: () => void;
  onNarrativeOnly: () => void;
  onWithAnnotations: () => void;
};

export function UpdateAnnotationsDialog({
  open,
  pendingCount,
  onClose,
  onNarrativeOnly,
  onWithAnnotations,
}: Props) {
  const { t } = useTranslation('deck');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('updateAnnots.title', { count: pendingCount })}
      description={t('updateAnnots.description')}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          {/* 一个真实选项，给 border 与无边框的「取消」拉开层级（Button 无 secondary 变体） */}
          <Button variant="ghost" size="sm" className="border-border" onClick={onNarrativeOnly}>
            {t('updateAnnots.narrativeOnly')}
          </Button>
          <Button variant="primary" size="sm" onClick={onWithAnnotations}>
            {t('updateAnnots.withAnnots')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-text-secondary">
        {t('updateAnnots.body')}
      </p>
    </Dialog>
  );
}
