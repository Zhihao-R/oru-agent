import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Moon,
  Settings as SettingsIcon,
  Sun,
  SunMoon,
  ShieldQuestion,
  BookOpen,
  MessageSquare,
  ListChecks,
  Clock,
  Bug,
  FlaskConical,
} from 'lucide-react';
import type { WsStatus } from '@/lib/ws';
import { useSettingsStore } from '@/stores/settingsStore';
import { useLandingNavStore } from '@/stores/landingNavStore';
import { nextThemeMode } from '@/lib/theme';
import { useWs } from '@/hooks/useWs';
import { cn } from '@/lib/cn';
import { IconButton } from './ui/IconButton';
import { AgentChip } from './AgentChip';

/** WS 连接态的指示色——color 不随语言变；label 经 app ns 翻译。 */
const WS_BADGE_COLOR: Record<WsStatus, string> = {
  open: 'bg-success',
  connecting: 'bg-accent',
  closed: 'bg-danger',
};

type Page =
  | 'chat'
  | 'taskboard'
  | 'scheduledTask'
  | 'debug'
  | 'promptbench'
  | 'settings';

type TopBarProps = {
  currentPage?: Page;
  onNavigate?: (p: Page) => void;
};

export default function TopBar({ currentPage = 'chat', onNavigate }: TopBarProps = {}) {
  const { t } = useTranslation('app');
  const auth = useSettingsStore((s) => s.authStatus);
  const devModeUnlocked = useSettingsStore((s) => s.devModeUnlocked);
  const debugLogging = useSettingsStore((s) => s.settings.developer?.debugLogging === true);
  const mode = useSettingsStore((s) => s.settings.theme);
  const updateSettings = useSettingsStore((s) => s.update);
  const cycleTheme = () => void updateSettings({ theme: nextThemeMode(mode) });
  const { status: wsStatus } = useWs();

  // 「对话 / 手账」入口的 active 态直接读当前线（点击驱动，不跟滚动）：对话线高亮「对话」、
  // 手账线高亮「手账」。line 由点入口 / 打开对话（conversationStore.setActive 收口）驱动。
  const line = useLandingNavStore((s) => s.line);
  const setLine = useLandingNavStore((s) => s.setLine);
  const requestLandingScroll = useLandingNavStore((s) => s.requestScroll);
  const chatActive = currentPage === 'chat' && line === 'chat';
  const journalActive = currentPage === 'chat' && line === 'memory';
  // 手账 = 去手账页看手账，不碰当前对话：切手账线 + 确保 chat 页 + 请求滚到手账区（≈ 昨夜）。
  const goJournal = () => {
    setLine('memory');
    onNavigate?.('chat');
    requestLandingScroll('memory');
  };
  // 对话 = 去对话线：有活跃对话看消息流；无则纯净新建页——从手账线过来时 HomeLanding 被复用
  // 不重挂，必须显式请求滚回顶部启动器（有活跃对话时该请求闲置，待下次新建页挂载时消费，语义一致）。
  const goChat = () => {
    setLine('chat');
    onNavigate?.('chat');
    requestLandingScroll('chat');
  };

  // 全屏时红绿灯隐藏，给它留位的 64px 左边距同步收回（坞左对齐到内容边）；
  // 初始态由主进程在 did-finish-load 推送，浏览器环境（无 oruWindow）恒为窗口态。
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => window.oruWindow?.onFullScreenChanged(setFullScreen), []);

  const ThemeIcon = mode === 'dark' ? Moon : mode === 'light' ? Sun : SunMoon;
  const themeLabel = mode === 'dark' ? t('theme.dark') : mode === 'light' ? t('theme.light') : t('theme.system');

  return (
    <header className="drag-region flex h-11 shrink-0 items-center justify-between border-b border-border bg-elevated px-4">
      <div
        className={cn(
          'flex min-w-0 items-center gap-2 transition-[margin] duration-200 ease-out',
          fullScreen ? 'ml-0' : 'ml-16',
        )}
      >
        {onNavigate ? (
          <nav className="no-drag flex items-center gap-[3px] rounded-full bg-sunken p-[3px]">
            <NavButton
              active={journalActive}
              onClick={goJournal}
              icon={<BookOpen size={15} strokeWidth={1.5} />}
              label={t('nav.journal')}
            />
            <NavButton
              active={chatActive}
              onClick={goChat}
              icon={<MessageSquare size={15} strokeWidth={1.5} />}
              label={t('nav.chat')}
            />
            <NavButton
              active={currentPage === 'taskboard'}
              onClick={() => onNavigate('taskboard')}
              icon={<ListChecks size={15} strokeWidth={1.5} />}
              label={t('nav.taskboard')}
            />
            <NavButton
              active={currentPage === 'scheduledTask'}
              onClick={() => onNavigate('scheduledTask')}
              icon={<Clock size={15} strokeWidth={1.5} />}
              label={t('nav.scheduled')}
            />
            {devModeUnlocked ? (
              <NavButton
                active={currentPage === 'debug'}
                onClick={() => onNavigate('debug')}
                icon={
                  <Bug
                    size={15}
                    strokeWidth={1.5}
                    className={debugLogging ? '' : 'opacity-40'}
                  />
                }
                label={debugLogging ? t('nav.debug') : t('nav.debugOff')}
              />
            ) : null}
            {devModeUnlocked ? (
              <NavButton
                active={currentPage === 'promptbench'}
                onClick={() => onNavigate('promptbench')}
                icon={<FlaskConical size={15} strokeWidth={1.5} />}
                label={t('nav.promptbench')}
              />
            ) : null}
          </nav>
        ) : null}
      </div>

      {/* 右簇无分隔线，只用间隔（设计稿 4a）；系统状态正常态隐形、异常才现（骨-4） */}
      <div className="no-drag flex items-center gap-1.5">
        <AgentChip onGoChat={() => onNavigate?.('chat')} />
        {!auth.ready ? <AuthBadge hint={auth.hint} t={t} /> : null}
        {wsStatus !== 'open' ? <WsBadge status={wsStatus} t={t} /> : null}
        <IconButton label={t('themeTooltip', { label: themeLabel })} onClick={cycleTheme}>
          <ThemeIcon size={16} strokeWidth={1.5} />
        </IconButton>
        {onNavigate ? (
          <IconButton
            label={t('settings')}
            onClick={() => onNavigate('settings')}
            className={currentPage === 'settings' ? 'bg-hover text-text-primary' : ''}
          >
            <SettingsIcon size={16} strokeWidth={1.5} />
          </IconButton>
        ) : null}
      </div>
    </header>
  );
}

function NavButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  // 胶囊坞内钮（2026-07-28 拍板 B2「圆窗」）：Ø26 正圆，active 白底从 sunken 坞里浮起
  // （亮色 1px 投影、暗色投影不可见改内描边），未激活只染色不加底。
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-[26px] w-[26px] items-center justify-center rounded-full',
        active
          ? 'bg-elevated text-accent-deep shadow-[0_1px_2px_rgba(20,40,48,0.10)] dark:shadow-none dark:ring-1 dark:ring-inset dark:ring-border-strong'
          : 'text-text-tertiary hover:text-text-primary',
      )}
    >
      {icon}
    </button>
  );
}

/** 只在「没有可用模型后端」时渲染（auth.ready=false 才挂载）——正常态隐形（骨-4）。 */
function AuthBadge({ hint, t }: { hint: string; t: TFunction }) {
  return (
    <span
      title={hint}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text-tertiary"
    >
      <ShieldQuestion size={14} strokeWidth={1.5} />
      <span className="hidden md:inline">{t('auth.notReady')}</span>
    </span>
  );
}

function WsBadge({ status, t }: { status: WsStatus; t: TFunction }) {
  return (
    <span
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text-tertiary"
      title={`WebSocket ${status}`}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', WS_BADGE_COLOR[status])} />
      <span className="hidden md:inline">{t(`ws.${status}`)}</span>
    </span>
  );
}
