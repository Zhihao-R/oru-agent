import { useTranslation } from 'react-i18next';
import { useArtifactStore } from '@/stores/artifactStore';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';

/**
 * 图片版导出（PDF/PPT）全局进度弹窗：背景蒙尘、阻断其余操作，让用户专心等导出（导出是主进程重活、
 * 会卡 UI——蒙尘下用户不与卡顿界面较劲）。可点「取消」中断。
 *
 * 状态全取自 store.exportProgress（非组件局部）：切到别的页面再切回来进度照样在、不丢；导出起止
 * 由 exportDeck 单点管（置 0/0 → 广播更新 → finally 清 null）。关闭弹窗 = 取消导出（单一收口）。
 * 挂在 App 根，与具体 deck 视图解耦。
 */
export function ExportProgressModal() {
  const { t } = useTranslation('deck');
  const progress = useArtifactStore((s) => s.exportProgress);
  const cancelExport = useArtifactStore((s) => s.cancelExport);

  const open = progress !== null;
  const artifactId = progress?.artifactId;
  const cancel = () => {
    if (artifactId) void cancelExport(artifactId);
  };

  const fmt = progress?.format === 'pptx' ? 'PPT' : 'PDF';
  const { done = 0, total = 0 } = progress ?? {};
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Dialog
      open={open}
      onClose={cancel} // 背景点击 / X / Esc 一律视为取消导出
      title={t('exportProgress.title', { format: fmt })}
      description={t('exportProgress.description')}
      footer={
        <Button onClick={cancel}>{t('exportProgress.cancel')}</Button>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between text-xs text-text-secondary">
          <span>{total > 0 ? t('exportProgress.rendering') : t('exportProgress.preparing')}</span>
          {total > 0 ? <span className="tabular-nums text-text-tertiary">{t('exportProgress.pageCount', { done, total })}</span> : null}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
          {total > 0 ? (
            // 已知总页数：按已渲染页数（done/total）实算，不用占位魔法数
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          ) : (
            // 总数未知（准备中）：不假造百分比，用脉冲的窄段诚实表达"不定量进行中"（accent 底，静止一瞬也可见）
            <div className="oru-pulse h-full w-2/5 rounded-full bg-accent" />
          )}
        </div>
      </div>
    </Dialog>
  );
}
