/**
 * TopBar 上的分身身份+状态+任务进度三合一 chip
 *
 * - 默认：分身头像 + 名称
 * - 工作中：头像保留 + 右上角 spinner 角标 + 任务标题
 * - 完成时：短暂闪绿动画
 * - 点击：弹出 AgentTaskPanel 看任务详情、stop
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/cn';
import { useAgentStore } from '@/stores/agentStore';
import { resolveOruName } from '@/lib/oruName';
import { useTaskStore } from '@/stores/taskStore';
import { useSystemSignalStore } from '@/stores/systemSignalStore';
import { useNotificationItems } from '@/lib/useNotifications';
import { AgentTaskPanel } from './AgentTaskPanel';

type Props = {
  /** 点通知项跳对话时把可见页面拨回 chat（面板可能停在非 chat 页，见 App.tsx 的 page state）。 */
  onGoChat?: () => void;
};

export function AgentChip({ onGoChat }: Props = {}) {
  const { t } = useTranslation('app');
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const active = agents.find((a) => a.id === activeId);
  // 角标 / 呼吸点与通知中心同一处判定（§4，不另算）：角标=需要你处理条数+系统信号条数——两族都是
  // 「要你管的事」，通知中心是唯一入口、这枚数字是唯一总闸（系统信号原有的顶栏独立全局指示
  // 2026-07-14 PM 拍板并入）。角标恒为实心琥珀圆：有待办→显待办数、无待办但有待验收→显待验收数、
  // 在跑→套动画晕圈（三者可叠：跑着+有待办 = 数字圆+晕圈）。
  const { needAction, running, done } = useNotificationItems(activeId);
  const systemSignals = useSystemSignalStore((s) => s.signals);
  const todoCount = needAction.length + systemSignals.length;
  const hasRunning = running.length > 0;
  // 角标里的数字：待办优先，其次「待验收」条数（都没有则纯实心圆 / 只靠晕圈表示在跑）
  const badgeCount = todoCount > 0 ? todoCount : done.length;
  const justFinishedTaskId = useTaskStore((s) => s.justFinishedTaskId);
  const clearJustFinished = useTaskStore((s) => s.clearJustFinished);

  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击 chip + 弹层之外即收起；只在开着时挂监听，关闭/卸载即摘（副作用成对清理）
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  useEffect(() => {
    if (justFinishedTaskId) {
      // CSS animation 只在 class 首次挂上时播放：连续两次完成（<1200ms）时先摘
      // class、下一帧再挂，保证第二次也能闪（framer 时代靠 animate 引用变化重播）
      setFlash(false);
      const raf = requestAnimationFrame(() => setFlash(true));
      const timer = setTimeout(() => {
        setFlash(false);
        clearJustFinished();
      }, 1200);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
  }, [justFinishedTaskId, clearJustFinished]);

  const isWorking = hasRunning;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        // 逐像素取自设计稿 主界面骨架.dc.html 第 50-51 行：无图标，纯名字胶囊——高 28px、
        // line2 边、全圆角、白底、hover 收紧到 line3。左恒 13；右侧有角标时留 34、无角标时收回对称 13，
        // padding 变化走 200ms 过渡让胶囊宽度丝滑伸缩。
        className={cn(
          'relative inline-flex h-7 items-center rounded-full border border-border-strong bg-elevated pl-[13px] transition-[padding,border-color] duration-200 ease-out hover:border-border-heavy',
          badgeCount > 0 || hasRunning ? 'pr-[34px]' : 'pr-[13px]',
          // 完成闪动走 CSS 动画取 var(--accent-ring)（framer 不插值 var()，写死 rgba 换主题不跟色）
          flash && 'oru-chip-flash',
        )}
        title={
          todoCount > 0
            ? t('chip.todoTooltip', { count: todoCount })
            : isWorking
              ? t('chip.working', { name: resolveOruName(active?.name) })
              : active
                ? t('chip.identity', { name: resolveOruName(active.name), home: active.homePath })
                : t('chip.fallback')
        }
      >
        <span className="max-w-24 truncate font-serif text-[15px] tracking-tight text-text-primary">
          {resolveOruName(active?.name)}
        </span>
        {/* 角标簇（设计稿第 52-54 行）：右上 15×15 定位框——恒为实心琥珀圆，在跑套动画晕圈、有数填数字。 */}
        {badgeCount > 0 || hasRunning ? (
          <span className="pointer-events-none absolute right-[5.5px] top-[5.5px] h-[15px] w-[15px]">
            {hasRunning ? (
              // halo：inset -5.5、warn 色 35% 晕圈、oruHalo 2.4s（几何取自设计稿 haloStyle）
              <span
                className="oru-halo absolute rounded-full"
                style={{
                  inset: '-5.5px',
                  background: 'color-mix(in srgb, var(--warn) 35%, transparent)',
                  animation: 'oruHalo 2.4s ease-in-out infinite',
                }}
              />
            ) : null}
            {/* 实心圆：--warn 底、满圆；有数则 warn-fg 字 10px/600（9+ 封顶），纯在跑时无数字（设计稿 badgeStyle） */}
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-warn text-[10px] font-semibold tabular-nums text-warn-fg">
              {badgeCount > 0 ? (badgeCount > 9 ? '9+' : badgeCount) : null}
            </span>
          </span>
        ) : null}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-9 z-30 w-[332px] rounded-lg border border-border-strong bg-elevated shadow-pop"
          >
            <AgentTaskPanel onClose={() => setOpen(false)} onGoChat={onGoChat} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
