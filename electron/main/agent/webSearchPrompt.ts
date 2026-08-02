/**
 * 上网搜索使用规范——拼进 stableSystemContext，仅当 webSearch.enabled=true 时返回非空。
 *
 * 这一段决定 Twin 的可观察行为；未来 PM 想调"更主动 / 更克制"直接改这段文本。
 */
import { getSettings } from '../projects/store';
import { isConfiguredEngine, makeEngine } from '../search/selector';
import { WEB_SEARCH_PROMPT } from '../prompts/webSearch';

export { WEB_SEARCH_PROMPT };

/**
 * 当 webSearch.enabled=true 时返回 WEB_SEARCH_PROMPT；否则返回空串（表示不注入）。
 *
 * 注意：仅依赖 enabled 开关，不依赖 engines.length——
 * 用户可能填了 key 但全部 lastTestStatus = failed，此时 prompt 不该诱导 Twin 去搜；
 * 但只要 enabled=true，Twin 看到工具调用错误自然会引导用户去 Settings。
 *
 * 配置了两家以上引擎时追加「当前可用引擎与擅长」清单，供模型用 web_search 的 engine
 * 参数按查询类型自选；只配一家没得选，不拼清单，模型也就不会传这个参数。会话中途改
 * 配置的滞后由工具层降级说明兜住（selector 的 preferredUnavailable，名单永远实时）。
 */
export async function loadWebSearchPromptIfEnabled(): Promise<string> {
  const settings = await getSettings();
  const ws = settings.webSearch;
  if (!ws?.enabled) return '';
  // 与 selector.loadConfigs 同一谓词——「清单列谁」和「搜索试谁」不许各写各的
  const configured = ws.engines.filter(isConfiguredEngine);
  if (configured.length < 2) return WEB_SEARCH_PROMPT;
  const lines = configured.map((c) => `- ${c.type}：${makeEngine(c).strengths}`);
  return (
    `${WEB_SEARCH_PROMPT}\n\n` +
    `**当前可用搜索引擎与擅长**（web_search 的 engine 参数可指定用哪家，按查询类型选，不确定就不传）：\n` +
    lines.join('\n')
  );
}
