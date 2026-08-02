/**
 * 断路器跳闸卡（G01/G04）——工具调用失控（连续失败 / 异常频繁）时弹出，像电闸过载跳闸。
 * 两个操作：「继续放行」（清零接着跑）/「停止」（刹停本回合）。本轮被停止 / 报错则置灰失效。
 *
 * 颜色走告警 token（--warn / --warn-soft），与普通提问卡的 accent 区分——这是系统安全暂停，不是一次提问。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useChatStore, type CircuitBreakPending } from '@/stores/chatStore';

export function CircuitBreakerCard({ brk }: { brk: CircuitBreakPending }) {
  const { t } = useTranslation('chat');
  const decide = useChatStore((s) => s.circuitBreakDecision);
  const [submitting, setSubmitting] = useState(false);
  const locked = brk.disabled || submitting;

  const act = async (decision: 'resume' | 'stop') => {
    if (locked) return;
    setSubmitting(true);
    try {
      await decide(brk.breakerId, decision);
    } catch {
      setSubmitting(false); // WS 失败：卡片保留可重试
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={cn(
        'rounded-lg border border-warn bg-warn-soft px-4 py-3',
        brk.disabled && 'pointer-events-none opacity-50',
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-0.5 flex-none text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-md font-medium text-text-primary">{t('circuitBreak.title')}</div>
          <div className="mt-0.5 text-sm leading-relaxed text-text-secondary">
            {t(`circuitBreak.reason.${brk.reason}`)}
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={locked}
          onClick={() => void act('stop')}
          className="rounded-md border border-border-strong px-4 py-1.5 text-base font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-50"
        >
          {t('circuitBreak.stop')}
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={() => void act('resume')}
          className="rounded-md px-4 py-1.5 text-base font-medium text-[var(--accent-fg)] transition-[filter] hover:brightness-95 disabled:opacity-50"
          style={{ background: 'var(--warn)' }}
        >
          {t('circuitBreak.resume')}
        </button>
      </div>
    </motion.div>
  );
}
