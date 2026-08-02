/**
 * 浏览器操控能力（S33 · G49）——六件 browser_* 工具的声明式注册。
 *
 * audience 对齐 webSearchCapability（同为联网族）：定时任务的「订票比价」、对话期 subagent 的
 * 联网操作都是高频场景，回退旧式 WEB 桶会漏掉 scheduledRun/twinSubagent（实施方案 §8）。
 * 受众管工具可见性；会话隔离（每 conversationId 各开各的无痕窗口）在 browser/session.ts，两事不混。
 *
 * 不带 buildPrompt：会话模型、uid 心智、无痕边界已写在各工具 description 里（模型每轮都看），
 * 无需再注入一份系统提示重复它（克制）。SDK 无同名内置浏览器工具，也无需 claudeCodeTools 协调。
 */
import type { Capability } from '../types';
import {
  makeBrowserNavigateTool,
  makeBrowserSnapshotTool,
  makeBrowserClickTool,
  makeBrowserTypeTool,
  makeBrowserScrollTool,
  makeBrowserBackTool,
} from '../../agentTools/browserControl';

export const browserControlCapability: Capability = {
  id: 'browser-control',
  audience: ['twinMain', 'scheduledRun', 'twinBackground', 'twinSubagent', 'subagentCoder'],
  // 顺序即注册顺序 = system prompt 里的工具顺序，对齐 capabilities.html 内建工具表
  makeTools: [
    makeBrowserNavigateTool,
    makeBrowserSnapshotTool,
    makeBrowserClickTool,
    makeBrowserTypeTool,
    makeBrowserScrollTool,
    makeBrowserBackTool,
  ],
};
