/**
 * 跨 provider 中性消息类型——backend ↔ historyAdapter 的契约。
 *
 * v0.5：从 electron/main/agent/backends/historyAdapter.ts 挪到 shared，
 * 让调试系统的 inference_view 事件（wireHistory 字段）也能共用同一份定义，
 * 避免"两份并存 + 字段漂移"。
 *
 * image block 的 load 由必需改可选：
 * - adapter 输出的运行时实例：一定带 load（adapter 内部 attachmentLoaderFor 注入）——
 *   backend 调用方按 invariant 使用 `b.load!()` + try/catch
 * - 落盘 / 跨进程后：不带（JSON.stringify 默认忽略函数值，行为天然正确）
 *
 * 表达约定（adapter 输出严格遵守）：
 * - user message blocks：text / image / tool_result
 * - assistant message blocks：text / tool_use
 *
 * UI 渲染时按 role 分组处理 block 类型，不要平铺。
 */
import type { ChatAttachment } from '@shared/types';

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export type UserBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      mediaType: ChatAttachment['mediaType'];
      filename: string;
      /**
       * backend 运行时按需读盘的闭包；落盘 / 跨进程时不存在。
       * adapter 输出的实例由 attachmentLoaderFor 注入——backend 用 `b.load!()` 即可。
       */
      load?: () => Promise<string>;
    }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export type NormalizedMessage =
  | { role: 'user'; blocks: UserBlock[] }
  | { role: 'assistant'; blocks: AssistantBlock[] };
