/**
 * mcp/* 模块内部共享类型。
 */
import type { ToolResultImage } from '@shared/agent/backend';
import type { McpServerStatus } from '@shared/types';

/** 单个 MCP server 暴露的工具元数据（从 listTools 拿到） */
export type McpToolMeta = {
  name: string;
  description: string;
  /** JSON Schema (Draft-07 兼容) —— 反射时直接传给 AgentTool.inputSchema */
  inputSchema: object;
};

/** Registry 对外暴露的 server 状态视图 */
export type McpServerRuntimeState = {
  serverId: string;
  status: McpServerStatus;
  /** server 真正暴露的工具数（探活通过后才有值）*/
  toolCount?: number;
  lastError?: string;
  /** 最近一次 spawn / handshake / runtime exit 失败时的 stderr 节选（最多 ~2KB） */
  lastStderr?: string;
  /**
   * 熔断冷却截止时间戳（ms）；> now 表示已暂停自动重连。0 / 缺省 = 未熔断。
   * 「是否熔断」不进 status 枚举（避免两个真相源），UI 据此时间戳派生展示（§4.5）。
   */
  circuitOpenUntil?: number;
};

/** Tool 调用结果（从 client.callTool 拿到的内容序列化成 text）*/
export type McpToolCallResult = {
  text: string;
  isError: boolean;
  /**
   * server 回的 image content，透传给模型"看"（截图类工具的正身）。
   * 缺省 = 本次没有图；非 PNG 的图不进这里，只在 text 侧留占位（见 client.callTool）。
   */
  images?: ToolResultImage[];
};
