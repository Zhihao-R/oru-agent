/**
 * 斜杠命令面板（斜杠命令补全 plan §4）——输入框上方浮层，三种内容共用：
 * 命令清单（/help）、模型编号清单（无参 /model）、执行反馈（一行文案）。
 * 打下一条消息即收（ChatArea.onSend 清状态）；切对话即收（ChatArea 按 activeConvId 清）。
 * 容器 token 与输入区上方条家族（LoopBar/TodoPanel）一致：rounded-sm + bg-elevated 浮起一层。
 */
import { useTranslation } from 'react-i18next';
import type { SlashPanelState } from './slashCommands';

const COMMAND_ROWS = [
  { cmd: '/new', hintKey: 'slash.helpNew' },
  { cmd: '/stop', hintKey: 'slash.helpStop' },
  { cmd: '/mode', hintKey: 'slash.helpMode' },
  { cmd: '/model', hintKey: 'slash.helpModel' },
  { cmd: '/compress', hintKey: 'slash.helpCompress' },
  { cmd: '/status', hintKey: 'slash.helpStatus' },
  { cmd: '/help', hintKey: 'slash.helpHelp' },
] as const;

const PANEL_CLASS = 'rounded-sm border border-border bg-elevated px-3.5 py-2.5';

export function SlashCommandPanel({ panel }: { panel: SlashPanelState }) {
  const { t } = useTranslation('chat');

  if (panel.kind === 'message') {
    return <div className={`${PANEL_CLASS} text-sm text-text-secondary`}>{panel.text}</div>;
  }

  if (panel.kind === 'models') {
    return (
      <div className={PANEL_CLASS}>
        <div className="mb-1.5 text-xs text-text-tertiary">{t('slash.modelTitle')}</div>
        <ol className="flex flex-col gap-0.5">
          {panel.models.map((m, i) => (
            <li key={i} className="flex items-baseline gap-2 text-sm">
              <span className="w-4 shrink-0 text-right text-text-quaternary">{i + 1}</span>
              <span className="text-text-primary">{m.label}</span>
              {m.current ? (
                <span className="text-xs text-text-tertiary">{t('slash.currentMark')}</span>
              ) : null}
            </li>
          ))}
        </ol>
        <div className="mt-1.5 text-xs text-text-tertiary">{t('slash.modelSwitchHint')}</div>
      </div>
    );
  }

  return (
    <div className={PANEL_CLASS}>
      <div className="flex flex-col gap-0.5">
        {COMMAND_ROWS.map((r) => (
          <div key={r.cmd} className="flex items-baseline gap-2.5 text-sm">
            <span className="shrink-0 font-mono text-text-primary">{r.cmd}</span>
            <span className="text-text-tertiary">{t(r.hintKey)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
