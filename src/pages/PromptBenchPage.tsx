/**
 * Prompt 工作台 —— 独立全屏页（与 DebugPanel 同构）
 *
 *   ┌──────────────┬──────────────────────────┐
 *   │  prompt 清单  │   只读查看（上半）        │
 *   │  (左窄栏)    ├──────────────────────────┤
 *   │              │   调试台 Playground（下半）│
 *   └──────────────┴──────────────────────────┘
 *
 * 右下调试台：A/B 两栏并排裸跑，对比「旧 prompt vs 新 prompt」「模型甲 vs 乙」。
 * 两栏 systemContext 默认都填当前选中段 body；模型列表全页拉一次共享。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PromptList } from '@/components/promptBench/PromptList';
import { PromptViewer } from '@/components/promptBench/PromptViewer';
import { Playground } from '@/components/promptBench/Playground';
import { wsClient } from '@/lib/ws';
import type { RegisteredModel } from '@shared/types';

export default function PromptBenchPage() {
  const { t } = useTranslation('pages');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [models, setModels] = useState<RegisteredModel[]>([]);
  const [baseBody, setBaseBody] = useState('');

  // 模型列表全页拉一次，两栏共享
  useEffect(() => {
    void (async () => {
      try {
        const res = await wsClient.request({ type: 'models.list' });
        if (res.type === 'models.state') setModels(res.models);
      } catch {
        // 忽略 WS 未连接
      }
    })();
  }, []);

  // 选中段变化时拉一次 body，作为两栏 systemContext 默认值
  useEffect(() => {
    if (!selectedId) {
      setBaseBody('');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await wsClient.request({ type: 'prompts.get', id: selectedId });
        if (!cancelled && res.type === 'prompts.one') setBaseBody(res.prompt.body);
      } catch {
        if (!cancelled) setBaseBody('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* 左窄栏：分组清单 */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-elevated">
        <header className="flex items-center border-b border-border px-3 py-2">
          <h2 className="font-medium text-text-primary">{t('bench.title')}</h2>
        </header>
        <div className="flex-1 overflow-y-auto">
          <PromptList selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      </aside>

      {/* 右主区：上半查看 + 下半调试台 */}
      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        <div className="min-h-0 flex-1 overflow-hidden">
          <PromptViewer promptId={selectedId} />
        </div>

        {/* 调试台 Playground —— A/B 两栏并排裸跑对比 */}
        <div className="flex h-[420px] shrink-0 flex-col border-t border-border">
          <p className="shrink-0 px-3 pt-2 text-xs text-text-tertiary">
            {t('bench.hint')}
          </p>
          <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border overflow-hidden">
            <div className="min-h-0 overflow-auto">
              <Playground models={models} baseBody={baseBody} />
            </div>
            <div className="min-h-0 overflow-auto">
              <Playground models={models} baseBody={baseBody} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
