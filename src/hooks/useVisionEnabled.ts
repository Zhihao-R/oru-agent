/**
 * 当前 twinMain 是否支持视觉 → 附件（📎）启停依据 + 停用提示。
 * 对话输入栏（ChatArea/ChatInput）与主页启动器输入栏共用同一口径，避免选择器重复。
 * 与 router.currentTwinSupportsVision 同口径：未分配模型 → 走后端 OAuth fallback（支持视觉）。
 */
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores/settingsStore';

export function useVisionEnabled(): { visionEnabled: boolean; visionDisabledHint: string } {
  const { t } = useTranslation('chat');
  const visionEnabled = useSettingsStore((s) => {
    const id = s.settings.modelAssignments.twinMain;
    if (!id) return true;
    return s.settings.models.find((m) => m.id === id)?.supportsVision === true;
  });
  const visionDisabledHint = useSettingsStore((s) => {
    const id = s.settings.modelAssignments.twinMain;
    if (!id) return '';
    const m = s.settings.models.find((m) => m.id === id);
    if (!m) return t('vision.modelNotFound');
    if (m.supportsVision == null) return t('vision.needVisionFlag');
    return t('vision.unsupported');
  });
  return { visionEnabled, visionDisabledHint };
}
