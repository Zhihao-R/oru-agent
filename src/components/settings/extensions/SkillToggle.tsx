/**
 * Skill 启停开关 —— 列表行末端和详情面板状态条都用同一个组件。
 *
 * 跟 McpToggle 同款乐观更新：先翻 store，失败回滚。
 *
 * plugin 内 skill：disabled + tooltip"由 plugin 控制"。
 * 理由不是"plugin 升级会让 enabled 指向被删 skill"——那是实现层问题（GC 可解），
 * 真正理由是 **plugin 是一组 skill 的整体封装单元**：用户的精细控制粒度是 plugin，
 * 想关单条 skill 应该 fork plugin 或独立装。把 plugin 内 skill 也开放单切违反封装。
 */
import { useTranslation } from 'react-i18next';
import { wsClient } from '@/lib/ws';
import { toastError } from '@/lib/toast';
import { useSkillModuleStore } from '@/stores/skillModuleStore';
import { Switch } from '@/components/ui/Switch';

/** 在 store 里把指定 skill 的 enabled 翻成 next（乐观/回滚共用一行） */
function flipEnabled(skillId: string, next: boolean) {
  const cur = useSkillModuleStore.getState().skills;
  useSkillModuleStore.setState({
    skills: cur.map((s) => (s.id === skillId ? { ...s, enabled: next } : s)),
  });
}

export function SkillToggle({
  skillId,
  enabled,
  source,
}: {
  skillId: string;
  enabled: boolean;
  source: 'standalone' | 'builtin' | 'plugin';
}) {
  const { t } = useTranslation('settings');
  const isPluginInternal = source === 'plugin';

  const onChange = async (next: boolean) => {
    if (isPluginInternal) return;
    flipEnabled(skillId, next);
    try {
      const res = await wsClient.request({
        type: 'skill.setEnabled',
        skillId,
        enabled: next,
      });
      if (res.type === 'skill.setEnabled.result' && !res.ok) {
        flipEnabled(skillId, !next);
        console.warn('[skill] toggle 失败', res.message);
        toastError(t('toast.skillToggleFailed'));
      }
    } catch (err) {
      flipEnabled(skillId, !next);
      console.warn('[skill] toggle 异常', err);
      toastError(t('toast.skillToggleFailed'));
    }
  };

  // plugin 内 skill：外层 span 套 title，按钮自身 disabled。
  // title 放外层而不是 button——某些 OS 上 disabled button 不响应 hover tooltip。
  if (isPluginInternal) {
    return (
      <span title={t('extensions.skillToggleByPluginTitle')} className="inline-flex">
        <Switch
          checked={enabled}
          onChange={() => {}}
          disabled
          ariaLabel={t('extensions.skillToggleByPluginAria')}
        />
      </span>
    );
  }

  return (
    <Switch
      checked={enabled}
      onChange={(next) => void onChange(next)}
      ariaLabel={t('extensions.skillToggleAria')}
    />
  );
}
