/**
 * 调试台实验栏（一栏 = 一次裸跑实验）
 *
 * 设计成可复用：A/B 两栏各渲染一个 <Playground>，各自独立选模型 + 改 systemContext，
 * 便于对比「旧 prompt vs 新 prompt」「模型甲 vs 乙」。
 *
 * 裸跑语义：只喂这段 system + 用户输入，不含工具 / 记忆 / 上下文拼装。
 * systemContext 默认填当前选中段 body，临时改、不落盘——这就是"改着试"的唯一入口。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RotateCcw } from 'lucide-react';
import { wsClient } from '@/lib/ws';
import { Button } from '@/components/ui/Button';
import type { RegisteredModel } from '@shared/types';

export function Playground({
  models,
  baseBody,
}: {
  /** 可选模型列表，由父组件拉一次共享 */
  models: RegisteredModel[];
  /** 当前选中段原文，作为 systemContext 默认值 + 「重置」目标 */
  baseBody: string;
}) {
  const { t } = useTranslation('pages');
  const [modelId, setModelId] = useState('');
  const [systemContext, setSystemContext] = useState(baseBody);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 换段（baseBody 变）即重置 systemContext 为新原文——换段=换实验对象，临时编辑随之清掉
  useEffect(() => {
    setSystemContext(baseBody);
  }, [baseBody]);

  // 没显式选模型时默认第一个，避免空 modelId 跑出「未知模型」
  useEffect(() => {
    if (!modelId && models.length > 0) setModelId(models[0].id);
  }, [models, modelId]);

  const onRun = async () => {
    if (!modelId || running) return;
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const res = await wsClient.request(
        { type: 'promptbench.run', modelId, systemContext, input },
        120_000,
      );
      if (res.type === 'promptbench.result') setResult(res.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-2 p-3">
      {/* 模型下拉 */}
      <select
        value={modelId}
        onChange={(e) => setModelId(e.target.value)}
        disabled={models.length === 0}
        className="rounded-md border border-border bg-elevated px-2 py-1 text-xs text-text-primary disabled:opacity-50"
      >
        {models.length === 0 ? (
          <option value="">{t('bench.noModels')}</option>
        ) : (
          models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))
        )}
      </select>

      {/* systemContext 可编辑 */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-tertiary">{t('bench.systemContextLabel')}</span>
          <button
            type="button"
            onClick={() => setSystemContext(baseBody)}
            disabled={systemContext === baseBody}
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary disabled:opacity-40"
            title={t('bench.resetTitle')}
          >
            <RotateCcw size={11} strokeWidth={1.5} />
            {t('bench.reset')}
          </button>
        </div>
        <textarea
          value={systemContext}
          onChange={(e) => setSystemContext(e.target.value)}
          rows={6}
          className="resize-y rounded-md border border-border bg-canvas px-2 py-1.5 font-mono text-xs leading-relaxed text-text-secondary"
        />
      </div>

      {/* 输入 */}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-tertiary">{t('bench.yourInput')}</span>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder={t('bench.inputPlaceholder')}
          className="resize-y rounded-md border border-border bg-canvas px-2 py-1.5 text-xs leading-relaxed text-text-primary"
        />
      </div>

      {/* 运行 */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={onRun}
          disabled={!modelId || running}
          leftIcon={running ? <Loader2 size={12} className="animate-spin" /> : undefined}
        >
          {running ? t('bench.running') : t('bench.run')}
        </Button>
      </div>

      {/* 结果 / 错误 */}
      {error ? (
        <div className="rounded-md border border-border bg-warn-soft px-2 py-1.5 text-xs text-warn">
          {t('bench.runFailed', { error })}
        </div>
      ) : null}
      {result != null ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-sunken px-2 py-1.5 text-xs leading-relaxed text-text-secondary">
          {result}
        </pre>
      ) : null}
    </div>
  );
}
