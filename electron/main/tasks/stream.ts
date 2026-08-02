/**
 * subagent 任务的引擎事件流 → task.* 事件
 * 区别于 agent/stream.ts：不写主对话；progress 事件携带 taskId
 */
import type { ServerEventPayload } from '@shared/protocol';
import { appendTaskEvent } from './store';
import type { EngineEvent } from '../engine';
import { toolObject, shorten } from '@shared/agent/toolActivity';
import { normalizeToolName } from '@shared/agent/toolName';

type Emit = (ev: ServerEventPayload) => void;

type Ctx = {
  taskId: string;
  emit: Emit;
};

export async function pipeSdkToEventsForTask(
  events: AsyncIterable<EngineEvent>,
  ctx: Ctx,
): Promise<{ summary: string }> {
  let assembled = '';
  let resultText = '';
  let isError = false;

  try {
    for await (const ev of events) {
      // 落盘所有事件，便于事后回看
      void appendTaskEvent(ctx.taskId, { ts: Date.now(), event: ev }).catch(() => undefined);

      switch (ev.type) {
        case 'assistant_text': {
          assembled += ev.text;
          // 进度事件：把它说的话推到 UI（speech 优先；截短）
          ctx.emit({
            type: 'task.progress',
            progress: {
              taskId: ctx.taskId,
              text: shorten(ev.text),
              source: 'speech',
            },
          });
          break;
        }
        case 'tool_use': {
          // 工具名 + 宾语（前端翻成"改 X / 搜 Y"，不露代号）；text 仅作兜底
          ctx.emit({
            type: 'task.progress',
            progress: {
              taskId: ctx.taskId,
              text: `调用工具：${normalizeToolName(ev.name)}`,
              toolName: ev.name,
              toolObject: toolObject(ev.name, ev.input),
              source: 'tool',
            },
          });
          break;
        }
        case 'result': {
          if (ev.resultText) resultText = ev.resultText;
          if (ev.isError) isError = true;
          break;
        }
      }
    }
  } catch (e) {
    // 流在中途抛错——claude-code 后端最典型：子进程退出抛 "exited with code 1"。
    // 退出前若 SDK 已吐过一条带文本的 isError result（如上游 529），那才是真因、退出码只是后果，
    // 拿它盖过退出码喂给 runTask 的 catch。没有明确错误文本时退回原始异常（enrichProcessExitError
    // 已把子进程 stderr 末尾补进去）——模型的过程性独白不是错误原因，不拿它冒充真因。
    if (isError && resultText.trim()) throw new Error(resultText.trim());
    throw e;
  }

  // 子进程正常退出（没抛异常）但 result 报了错：同样是失败，不能当 done 收工，否则失败任务被标
  // 成功、播报也不触发。此路径没有原始异常可退回，错误文本缺失就给兜底语，绝不喂空串/独白给 twin。
  if (isError) throw new Error(resultText.trim() || '子 agent 报告失败但未给出原因');
  return { summary: (resultText || assembled).trim() };
}
