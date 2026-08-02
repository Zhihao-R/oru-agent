/**
 * 装一个新 plugin（Skill 模块 v1）—— 拓展页 ▸ Plugin 章节顶部按钮。
 *
 * 点击 → inline 输入 GitHub URL → wsClient.request('plugin.install') →
 * 主进程触发 plugin.install proposal → 用户在对话流审批通过 → 装入。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { wsClient } from '@/lib/ws';
import { Button } from '@/components/ui/Button';

export function PluginInstallButton() {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await wsClient.request({ type: 'plugin.install', githubUrl: url.trim() });
      if (res.type === 'plugin.action.result' && !res.ok) {
        setError(res.message);
        return;
      }
      setUrl('');
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        leftIcon={<Plus size={12} strokeWidth={1.5} />}
        className="text-text-secondary"
      >
        {t('extensions.pluginInstall')}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        type="text"
        value={url}
        placeholder="https://github.com/owner/repo"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
          if (e.key === 'Enter') void onSubmit();
          else if (e.key === 'Escape') {
            setOpen(false);
            setUrl('');
            setError(null);
          }
        }}
        disabled={busy}
        className="w-[280px] rounded border border-border bg-canvas px-2 py-1 font-mono text-[11.5px] text-text-primary"
      />
      <button
        type="button"
        onClick={() => void onSubmit()}
        disabled={busy || !url.trim()}
        className="rounded bg-accent px-2 py-1 text-[11px] text-accent-fg disabled:opacity-50"
      >
        {busy ? t('extensions.pluginInstalling') : t('extensions.pluginInstallSubmit')}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setUrl('');
          setError(null);
        }}
        disabled={busy}
        className="rounded px-2 py-1 text-[11px] text-text-secondary hover:bg-hover disabled:opacity-50"
      >
        {t('common:cancel')}
      </button>
      {error ? (
        <span className="text-[11px] text-danger" title={error}>
          {error.slice(0, 40)}
        </span>
      ) : null}
    </div>
  );
}
