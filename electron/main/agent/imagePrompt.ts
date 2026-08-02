/**
 * 配图使用规范——拼进 stableSystemContext，仅当 webSearch.enabled=true 时返回非空
 * （搜图复用联网引擎，故与联网同一个 enabled 闸门；联网没开，配图一起不引导）。
 */
import { getSettings } from '../projects/store';
import { IMAGE_PROMPT } from '../prompts/image';

export { IMAGE_PROMPT };

/** webSearch.enabled=true 时返回 IMAGE_PROMPT；否则空串（不注入，配图随联网一起静默）。 */
export async function loadImagePromptIfEnabled(): Promise<string> {
  const settings = await getSettings();
  return settings.webSearch?.enabled ? IMAGE_PROMPT : '';
}
