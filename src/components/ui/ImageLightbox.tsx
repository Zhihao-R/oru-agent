/**
 * 应用内看大图弹窗：点缩略图放大，点遮罩 / Esc 关闭。
 * 替代此前的 window.open 新标签页——描述图 / 评论图 / 聊天气泡三处经 AttachmentGallery 共用，
 * 「不用管理额外标签页」的收益一处兑现三处。
 *
 * z-[60] 高于 Dialog（z-50）：新建任务对话框里的描述图也能盖在对话框之上看大图。
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  /** 非空即打开；null 关闭 */
  src: string | null;
  alt?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 阻止冒泡：关灯箱不应连带触发外层 Esc（如关详情面板 / 对话框）
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, onClose]);

  return createPortal(
    <AnimatePresence>
      {src ? (
        <motion.div
          // 看图遮罩固定深色（不跟 text-primary——暗色主题下它是近白，会把环境刷亮而非压暗）
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-8 backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
        >
          <motion.img
            src={src}
            alt={alt ?? ''}
            draggable={false}
            className="max-h-full max-w-full rounded-lg object-contain shadow-pop"
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.96 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            // 点图片本体不关（只有点图外的遮罩关）
            onClick={(e) => e.stopPropagation()}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
