/**
 * 当前 twinMain 分配的模型是否支持视觉（图片输入）。
 * - OAuth 默认（未分配）→ true（走 fallback OAUTH_FALLBACK_MODEL，支持视觉）
 * - 已分配但 model.supportsVision !== true → false
 * - 已分配且 supportsVision === true → true
 *
 * 服务端兜底校验的单一实现，两处消费：桌面 chat.send（前端 visionEnabled disabled 是第一道，
 * 这是第二道）、平台入站图（gatewayWiring——远程无前端可灰按钮，这是唯一一道）。
 */
import { getSettings } from '../../projects/store';
import { OAUTH_FALLBACK_SUPPORTS_VISION } from './factory';

export async function currentTwinSupportsVision(): Promise<boolean> {
  const settings = await getSettings();
  const twinMainId = settings.modelAssignments.twinMain;
  // 未分配 → 走 factory 的 OAuth fallback；是否支持视觉与 fallback 模型同源（单一事实源）。
  if (!twinMainId) return OAUTH_FALLBACK_SUPPORTS_VISION;
  const model = settings.models.find((m) => m.id === twinMainId);
  return model?.supportsVision === true;
}
