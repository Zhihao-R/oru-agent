import { useTranslation } from 'react-i18next';
import { ArrowDown } from 'lucide-react';
import { motion } from 'framer-motion';

/** 流式期间用户向上滚后底部居中浮的按钮：点击平滑滚回最新。 */
export function ScrollToLatestButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('chat');
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={t('scrollToLatest')}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="absolute bottom-4 left-1/2 -ml-4 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-elevated/85 text-text-secondary backdrop-blur-sm transition-all duration-150 hover:bg-elevated hover:text-text-primary hover:shadow-md"
    >
      <ArrowDown size={14} strokeWidth={1.8} />
    </motion.button>
  );
}
