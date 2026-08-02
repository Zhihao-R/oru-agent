/**
 * 渲染回看能力（render_html，S31·G47）——把此前手工对齐到 WEB 桶的 render_html 迁成声明式能力。
 *
 * 迁移即单源：render_html 已从 registerStaticAgentTools() 移除，改由本能力的 makeTools 注入。
 * 核心使用者是写 deck HTML 的 subagentCoder（它是独立 usage 桶、不走 twinSubagent 透明继承，只挂 twinMain
 * 会漏掉它）；twinSubagent 经透明继承自动覆盖。audience 一处声明覆盖三类受众，不再"凑桶、会漏"。
 */
import type { Capability } from '../types';
import { makeRenderHtmlTool } from '../../agentTools/renderHtml';

export const renderHtmlCapability: Capability = {
  id: 'render-html',
  audience: ['twinMain', 'twinBackground', 'subagentCoder'],
  makeTools: [makeRenderHtmlTool],
};
