/**
 * Task 工具——主 agent 调它派出一个独立上下文的 subagent 完成局部任务。
 *
 * 委派工具收敛（2026-08-02）：propose_action 退役，`Task` 是全仓唯一的委派工具，
 * `mode: sync | async` 表达父回合等不等：
 *   - sync  父回合阻塞等结果回填（原 Task 行为，走对话期 subagent 运行时）
 *   - async 立即返回任务编号，父回合继续甚至结束；subagent 后台跑，完成后触发进队（原 propose_action 行为）
 * mode 不填默认 async——改代码/跑测试/装依赖/调研这类长活的主流路径不该阻塞父回合。
 *
 * 工具名 'Task' 跟 Anthropic Claude Code 对齐——社区 skill 的 SKILL.md 里写的就是
 * Task 工具调用，对齐这个名字让 skill prompt 零改动可用。
 *
 * 注册：仅 'twinMain' 桶（不注册到 'twinSubagent'），这是嵌套保护的实施点。
 * subagent 的 ToolContext 也不挂 runSubagent callback，双层保护——分身不能再分身（P1 定案）。
 *
 * execute 的 sync 分支调 ctx.runSubagent（callback 由主 runner 在拼 ToolContext 时挂上，
 * 闭包捕获主对话的 onProposal / stableSystemContext / abortController 等 deps）；
 * async 分支调 dispatchAsyncSubagent 复用后台任务运行时（proposal + subagentRunner）。
 */
import type { AgentTool } from '@shared/agent/backend';
import { dispatchAsyncSubagent } from './dispatchAsyncSubagent';

export function makeTaskTool(): AgentTool {
  return {
    name: 'Task',
    mutatesEnvironment: false,
    description:
      '派一个独立上下文的 subagent 完成局部任务。用 `mode` 表达父回合等不等：' +
      '长活（改代码 / 跑测试 / 装依赖 / 调研）用 `mode: "async"`（默认）——立即返回任务编号、' +
      '父回合继续甚至结束，subagent 后台跑，完成后我会主动汇报；' +
      '要当场拿结果的短推理（扮演角色 / 并行头脑风暴 / 隔离上下文子推理）用 `mode: "sync"`——' +
      '父回合阻塞等它完成把返回值给你。' +
      '派活本身不需用户批准，subagent 执行时每个操作按当前审批挡位逐闸自动判定。' +
      'subagent 看不到主对话历史，prompt 字段必须给齐它需要的全部上下文（受众、约束、目标）。' +
      'subagent 不能再派 subagent。subagent 拿不准时会在返回值里说明，你自行决定下一步。',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '简短意图（chip / 任务标题上显示，< 60 字）',
        },
        prompt: {
          type: 'string',
          description: '派给 subagent 的完整任务说明，必须自包含',
        },
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description: 'sync = 父回合阻塞等结果回填；async = 立即返回、后台跑、完成后再汇报。默认 async。',
        },
      },
      required: ['description', 'prompt'],
    },
    // 'always'：subagent 输出不可重现（重跑是另一次 LLM 输出，不是原文），与 bash/web_fetch
    // 同类。'auto' 下 150B~2k token 区间的返回会被折叠成「取不回、重新调用」桩，逐字原文
    // 对模型永久丢失——落盘让折叠桩始终带 read_file 取回路径。
    persistPolicy: 'always',
    async execute(input, ctx) {
      const args = input as { description?: unknown; prompt?: unknown; mode?: unknown };
      if (typeof args.description !== 'string' || typeof args.prompt !== 'string') {
        return { isError: true, text: 'Task 入参非法：description / prompt 必须是字符串' };
      }
      const mode = args.mode === 'sync' ? 'sync' : 'async';
      if (mode === 'async') {
        return dispatchAsyncSubagent(ctx, {
          description: args.description,
          prompt: args.prompt,
        });
      }
      // sync：父回合阻塞等结果回填
      if (!ctx.runSubagent) {
        return {
          isError: true,
          text: 'Task 工具在当前上下文不可用（subagent 不能再派 subagent）',
        };
      }
      return ctx.runSubagent({ description: args.description, prompt: args.prompt });
    },
  };
}
