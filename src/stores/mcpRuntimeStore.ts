/**
 * MCP server 的运行时状态 store（v0.6）。
 *
 * `McpServerConfig.lastStatus` 是持久化字段（向后兼容），但当前真实状态来自 main process
 * 内存里的 client.status。这个 store 承载 main 推过来的运行时态：
 * - SettingsPage mount 时拉一次 mcp.runtime.list 填满
 * - 每次 mcp.create/update/delete/restart RPC 的 result 都更新本 store
 */
import { create } from 'zustand';
import type { McpServerStatus } from '@shared/types';

export type McpRuntime = {
  serverId: string;
  status: McpServerStatus;
  toolCount?: number;
  lastError?: string;
  lastStderr?: string;
  /** 熔断冷却截止时间戳（ms）；> now 表示已暂停自动重连。UI 据此派生「已暂停自动重连」展示。 */
  circuitOpenUntil?: number;
};

type Store = {
  byId: Record<string, McpRuntime>;
  loaded: boolean;
  setAll: (states: McpRuntime[]) => void;
  upsert: (state: McpRuntime) => void;
  /** spawning 中间态——本地立即设置，等 broadcast 落定 */
  markSpawning: (serverId: string) => void;
  /** 手动重连乐观态——点「重连」时即置 reconnecting，等 RPC 落定覆盖（§4.5） */
  markReconnecting: (serverId: string) => void;
  /** 删除时清掉 */
  remove: (serverId: string) => void;
};

export const useMcpRuntimeStore = create<Store>((set) => ({
  byId: {},
  loaded: false,
  setAll: (states) =>
    set(() => ({
      byId: Object.fromEntries(states.map((s) => [s.serverId, s])),
      loaded: true,
    })),
  upsert: (state) =>
    set((cur) => ({
      byId: { ...cur.byId, [state.serverId]: state },
    })),
  markSpawning: (serverId) =>
    set((cur) => ({
      byId: {
        ...cur.byId,
        [serverId]: {
          ...(cur.byId[serverId] ?? { serverId }),
          status: 'starting',
          lastError: undefined,
          lastStderr: undefined,
        },
      },
    })),
  markReconnecting: (serverId) =>
    set((cur) => ({
      byId: {
        ...cur.byId,
        [serverId]: {
          ...(cur.byId[serverId] ?? { serverId }),
          status: 'reconnecting',
          lastError: undefined,
          // 乐观清掉熔断展示——重连成功会真清，失败 RPC 落定会带回新的 circuitOpenUntil
          circuitOpenUntil: undefined,
        },
      },
    })),
  remove: (serverId) =>
    set((cur) => {
      const next = { ...cur.byId };
      delete next[serverId];
      return { byId: next };
    }),
}));
