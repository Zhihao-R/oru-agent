/**
 * Deck 看图能力 —— 兑现任务 6 §7 预告：把 render_contact_sheet / view_slide 从手工对齐
 * SUB_AGENT 桶迁成声明式能力（任务 9 决策 3）。一处声明覆盖两类受众。
 *
 * audience：
 *  - subagentCoder：写 deck HTML 的子 agent（行为不变，仍拿到这两个工具）。
 *  - twinMain：主对话 AI 改标注时也能睁眼看改后的页（twinSubagent 透明继承 twinMain，自动可见）。
 *
 * 无 prompt / ctx：deckPath 由 runner 按"当前焦点提交组"注入 ToolContext（runner.ts / subagentRunner.ts），
 * 不在能力里拼——能力只声明"谁有这两个工具"，路径锚定是运行时上下文的事。
 */
import type { Capability } from '../types';
import { makeRenderContactSheetTool } from '../../agentTools/renderContactSheet';
import { makeViewSlideTool } from '../../agentTools/viewSlide';

export const deckReviewCapability: Capability = {
  id: 'deck-review',
  audience: ['twinMain', 'scheduledRun', 'subagentCoder'],
  makeTools: [makeRenderContactSheetTool, makeViewSlideTool],
};
