/**
 * Prompt 清单（左窄栏）
 *
 * 挂载时 `prompts.list` 拉一次 meta，按 category 分组渲染。
 * 分组顺序跟随 CATEGORY_LABELS 的键序——单一真相，不另排序。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { wsClient } from '@/lib/ws';
import { CATEGORY_LABELS, type PromptCategory, type PromptMeta } from '@shared/types';

/** 按 category 分组；顺序跟随 CATEGORY_LABELS 键序，空组省略。纯函数，便于单测。 */
export function groupByCategory(
  prompts: PromptMeta[],
): Array<{ category: PromptCategory; items: PromptMeta[] }> {
  const buckets = new Map<PromptCategory, PromptMeta[]>();
  for (const p of prompts) {
    const arr = buckets.get(p.category) ?? [];
    arr.push(p);
    buckets.set(p.category, arr);
  }
  return (Object.keys(CATEGORY_LABELS) as PromptCategory[])
    .filter((c) => buckets.has(c))
    .map((category) => ({ category, items: buckets.get(category)! }));
}

export function PromptList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation('pages');
  const [prompts, setPrompts] = useState<PromptMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await wsClient.request({ type: 'prompts.list' });
        if (res.type === 'prompts.listed') setPrompts(res.prompts);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return <div className="p-3 text-xs text-text-tertiary">{t('app:loading')}</div>;
  }
  if (error) {
    return <div className="p-3 text-xs text-danger">{t('bench.loadFailed', { error })}</div>;
  }
  if (prompts.length === 0) {
    return <div className="p-3 text-xs text-text-tertiary">{t('bench.empty')}</div>;
  }

  const groups = groupByCategory(prompts);

  return (
    <div className="flex flex-col gap-4 p-2">
      {groups.map(({ category, items }) => (
        <div key={category}>
          <div className="px-2 pb-1 text-xs font-medium text-text-tertiary">
            {t(`bench.category.${category}`)}
          </div>
          <div className="flex flex-col">
            {items.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                className={
                  'truncate rounded px-2 py-1.5 text-left text-sm transition-colors ' +
                  (p.id === selectedId
                    ? 'bg-accent-soft text-accent'
                    : 'text-text-secondary hover:bg-hover hover:text-text-primary')
                }
                title={p.summary ?? p.title}
              >
                {p.title}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
