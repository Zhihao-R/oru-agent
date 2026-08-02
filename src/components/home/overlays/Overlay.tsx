/**
 * 浮层统一外壳（A5 统一版式）——遮罩 rgba(24,32,35,0.45)、居中、圆角 10px、右上安静 ×。
 * 覆盖宿主的内容区（挂在宿主的相对定位根内，absolute inset-0），点遮罩关闭、点卡片不冒泡。
 * 宿主：手账页（HomeLanding）与对话消息区（ChatArea 的记忆卡「查看」）。
 * topRight 供额外动作（如笔记详情的垃圾桶）插在 × 左侧。
 * radius：卡片圆角像素，默认 10（保持旧行为）。
 * editing：true 时卡片边框切换为 accent 高亮（accent 边 + 淡 accent-soft 环，见档案 demo）。
 * hideClose：true 时不渲染自带右上 ×（档案浮层把 × 并进内部圆形工具条，避免两个 × 并存）。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

type Props = {
  width: number;
  maxHeight?: number;
  onClose: () => void;
  topRight?: ReactNode;
  children: ReactNode;
  /** 卡片圆角像素，默认 10（rounded-lg） */
  radius?: number;
  /** 编辑态：accent 边框高亮 */
  editing?: boolean;
  /** 隐藏自带右上 ×（档案浮层把 × 并进内部工具条时用） */
  hideClose?: boolean;
};

// 浮层在暗半透明遮罩上——demo 的浅底投影值在暗遮罩上不可见（暗投影融进暗底），故用 app 的
// shadow-pop（为暗遮罩校准，卡片真正浮起、与其它浮层一致）承担漂浮感；编辑态在其上叠 accent-soft
// 淡环 + accent-line 细边作「编辑仪式」（demo 语义：accent 边为主）。
const REST_SHADOW = '0 18px 50px -18px rgba(20,40,48,0.32), 0 4px 12px -4px rgba(20,40,48,0.10)';
const EDIT_SHADOW =
  '0 18px 50px -18px rgba(20,40,48,0.32), 0 4px 12px -4px rgba(20,40,48,0.10), 0 0 0 3px var(--accent-soft)';

export function Overlay({
  width,
  maxHeight = 680,
  onClose,
  topRight,
  children,
  radius = 10,
  editing = false,
  hideClose = false,
}: Props) {
  const { t } = useTranslation('common');
  return (
    <div
      onClick={onClose}
      className="absolute inset-0 z-[60] flex items-center justify-center"
      style={{ background: 'rgba(24,32,35,0.45)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative overflow-y-auto bg-elevated"
        style={{
          width,
          maxHeight,
          borderRadius: radius,
          border: editing ? '1px solid var(--accent-line)' : '1px solid transparent',
          boxShadow: editing ? EDIT_SHADOW : REST_SHADOW,
          transition: 'border-color .2s, box-shadow .2s',
        }}
      >
        {!hideClose && (
          <span className="absolute right-5 top-5 z-10 flex items-center gap-3.5 leading-none">
            {topRight}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className="text-text-quaternary transition-colors hover:text-text-secondary"
            >
              <X size={13} strokeWidth={1.3} />
            </button>
          </span>
        )}
        {children}
      </div>
    </div>
  );
}
