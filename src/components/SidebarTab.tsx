/**
 * 左栏"小耳朵"——像实体文件夹露出的标签
 * - 紧贴 TopBar 下沿（top-0），共用 TopBar 的 border-b 作为顶边
 * - 自动隐藏模式：onMouseEnter 唤起 overlay
 * - 手动收起模式：onClick 切回常驻
 */
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';

type Props = {
  mode: 'autoHide' | 'manual';
  onClick?: () => void;
  onMouseEnter?: () => void;
};

export function SidebarTab({ mode, onClick, onMouseEnter }: Props): JSX.Element {
  const { t } = useTranslation('app');
  const label = mode === 'autoHide' ? t('expandSidebarHover') : t('expandSidebar');
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="group absolute left-0 top-0 z-20 flex h-14 w-5 items-center justify-end rounded-br-lg border-b border-r border-border bg-elevated pr-1 text-text-secondary transition-all duration-150 hover:w-6 hover:bg-hover hover:text-text-primary"
    >
      <ChevronRight
        size={14}
        strokeWidth={2}
        className="transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
