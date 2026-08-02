/**
 * Prompt 查看器（右上主区，只读）
 *
 * 收到选中 id → `prompts.get` 拉单段全文；切 id 重新加载。
 * 本期只读：无保存按钮，body 用等宽只读区，可滚动、可选中复制。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { wsClient } from '@/lib/ws';
import type { PromptEntry } from '@shared/types';

export function PromptViewer({ promptId }: { promptId: string | null }) {
  const { t } = useTranslation('pages');
  const [prompt, setPrompt] = useState<PromptEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!promptId) {
      setPrompt(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await wsClient.request({ type: 'prompts.get', id: promptId });
        if (!cancelled && res.type === 'prompts.one') setPrompt(res.prompt);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [promptId]);

  if (!promptId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
        {t('bench.viewerEmpty')}
      </div>
    );
  }
  if (loading) {
    return <div className="p-6 text-sm text-text-tertiary">{t('app:loading')}</div>;
  }
  if (error) {
    return <div className="p-6 text-sm text-danger">{t('bench.loadFailed', { error })}</div>;
  }
  if (!prompt) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium text-text-primary">{prompt.title}</h2>
          <span className="rounded bg-elevated px-1.5 py-0.5 text-xs text-text-tertiary">
            {t(`bench.category.${prompt.category}`)}
          </span>
        </div>
        {prompt.summary ? (
          <p className="mt-1 text-xs text-text-tertiary">{prompt.summary}</p>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-text-secondary">
          {prompt.body}
        </pre>
      </div>
    </div>
  );
}
