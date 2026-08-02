/**
 * 调试面板主页 —— 两栏 + 浮层抽屉
 *
 *   ┌──────────────┬──────────────────────────┐
 *   │  round 列表   │   纵向时间线            │  ← 详情抽屉浮在中栏右侧
 *   │  (左栏)      │   (中栏，永远全宽)       │
 *   └──────────────┴──────────────────────────┘
 *
 * 详情抽屉是 absolute 浮层（不挤占时间线宽度）；selected = null 时整体 hidden。
 *
 * 关闭态（debugLogging=false）顶部条幅提示：「调试日志已关闭，以下为历史记录，新对话不会记录。」
 * 仍允许查看 / 清空。
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Eraser, RefreshCw } from 'lucide-react';

import { useDebugStore } from '@/stores/debugStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { RoundList } from '@/components/debug/RoundList';
import { Timeline } from '@/components/debug/Timeline';
import { DebugDrawer } from '@/components/debug/DebugDrawer';

export default function DebugPanelPage() {
  const { t } = useTranslation('pages');
  const rounds = useDebugStore((s) => s.rounds);
  const loading = useDebugStore((s) => s.loading);
  const selectedKey = useDebugStore((s) => s.selectedKey);
  const timeline = useDebugStore((s) => s.timeline);
  const selectedEvent = useDebugStore((s) => s.selectedEvent);
  const loadRounds = useDebugStore((s) => s.loadRounds);
  const selectRound = useDebugStore((s) => s.selectRound);
  const selectEvent = useDebugStore((s) => s.selectEvent);
  const clearAll = useDebugStore((s) => s.clearAll);

  const debugLogging = useSettingsStore((s) => s.settings.developer?.debugLogging === true);

  useEffect(() => {
    void loadRounds();
  }, [loadRounds]);

  const onClearAll = async () => {
    if (!confirm(t('debug.clearAllConfirm'))) return;
    await clearAll();
  };

  const onOpenDir = async () => {
    try {
      await window.oruDebug.openDir();
    } catch (e) {
      console.warn('[debug] openDir failed', e);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {!debugLogging ? (
        <div className="border-b border-warn bg-warn-soft px-4 py-2 text-xs text-warn">
          {t('debug.loggingOff')}
        </div>
      ) : null}
      <div className="flex flex-1 overflow-hidden">
        {/* 左栏 */}
        <aside className="flex w-[380px] shrink-0 flex-col border-r border-border bg-elevated">
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="font-medium text-text-primary">{t('debug.title')}</h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void loadRounds()}
                className="rounded p-1 text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary"
                aria-label={t('debug.refresh')}
              >
                <RefreshCw size={14} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                onClick={onOpenDir}
                className="rounded p-1 text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary"
                aria-label={t('debug.openDir')}
              >
                <FolderOpen size={14} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                onClick={onClearAll}
                className="rounded p-1 text-text-tertiary transition-colors hover:bg-hover hover:text-danger"
                aria-label={t('debug.clearAll')}
              >
                <Eraser size={14} strokeWidth={1.5} />
              </button>
            </div>
          </header>
          <p className="border-b border-border px-3 py-1.5 text-xs text-text-tertiary">
            {t('debug.retentionHint')}
          </p>
          <div className="flex-1 overflow-y-auto">
            <RoundList
              rounds={rounds}
              loading={loading}
              selectedKey={selectedKey}
              onSelect={(key) => void selectRound(key)}
            />
          </div>
        </aside>

        {/* 中栏 + 浮层抽屉 —— position: relative 让 absolute 抽屉以中栏为容器 */}
        <main className="relative flex flex-1 flex-col bg-canvas">
          {selectedKey ? (
            timeline ? (
              <Timeline
                model={timeline}
                selectedEventId={selectedEvent?.id ?? null}
                onSelectEvent={selectEvent}
              />
            ) : (
              <div className="p-6 text-sm text-text-tertiary">{t('debug.loadingTimeline')}</div>
            )
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
              {t('debug.selectPrompt')}
            </div>
          )}

          {/* 浮层抽屉常驻 mount——避免反复 mount 导致状态丢失 */}
          <DebugDrawer selected={selectedEvent} onClose={() => selectEvent(null)} />
        </main>
      </div>
    </div>
  );
}
