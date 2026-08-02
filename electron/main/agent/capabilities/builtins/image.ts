/**
 * 配图能力 —— 声明式能力机制的第二个原生落地（任务 3）。
 *
 * 搜图复用联网那套配置/配额/可见性外壳：
 *  - 受众含 subagentCoder（写 deck 的核心使用者）——与联网同款受众，搭任务 2 趟平的注入路。
 *  - 配置闸门复用 webSearch.enabled：联网没开/没配引擎，buildPrompt 返回空、工具调用走
 *    loadConfigs 被 not_enabled 挡——配图自然一起不可用，不新增独立开关。
 *  - 预算复用 searchBudgetId：image_search/download_image 与 web_* 共用同一搜索桶。
 *
 * 不实现 initRuntime（即不 reset 预算）：image 与 web 共用同一桶，这里 reset 会清掉 web_search
 * 本轮已累计的计数。桶由 webSearchCapability.initRuntime 统一 reset（同受众、必然同在，因配图依赖联网）。
 * image_search/download_image 不叫 web_*、不在 ClaudeCodeBackend.ignoredToolNames 里，
 * 故无需 claudeCodeTools.allow（比联网还省一步）。
 */
import type { Capability } from '../types';
import { makeImageSearchTool } from '../../agentTools/imageSearch';
import { makeDownloadImageTool } from '../../agentTools/downloadImage';
import { loadImagePromptIfEnabled } from '../../imagePrompt';

export const imageCapability: Capability = {
  id: 'image',
  audience: ['twinMain', 'scheduledRun', 'twinBackground', 'twinSubagent', 'subagentCoder'],
  makeTools: [makeImageSearchTool, makeDownloadImageTool],
  buildPrompt: () => loadImagePromptIfEnabled(),
};
