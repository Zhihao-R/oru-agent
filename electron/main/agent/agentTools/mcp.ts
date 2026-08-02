/**
 * MCP 自装能力：6 个 agent tool（v0.6）。
 *
 * - 读类（永远无需审批）：mcp_list / mcp_inspect
 * - 写类（受审批挡位控制，挡位实时 getAgent）：mcp_install / mcp_update / mcp_delete
 *   走 proposeOrExecute：免审批直接跑、需审批则挂起等确认，**真实成败作为回执在原轮回给模型**。
 *   回执不预告——「MCP server 已启动」这个断言只有等 spawn + 握手跑完才成立。
 * - 诊断类（永远无需审批）：mcp_test_connection
 */
import type { AgentTool } from '@shared/agent/backend';
import type { McpServerPatch } from '@shared/types';
import { proposeOrExecuteEnvChange } from './emitProposal';
import { performMcpInstall, performMcpUpdate, performMcpDelete } from '../../mcp/perform';
import {
  buildDeleteProposal,
  buildInstallProposal,
  buildUpdateProposal,
} from '../../proposals/makeMcpProposal';

// ─── 读类 ───────────────────────────────────────────

export function makeMcpListTool(): AgentTool {
  return {
    name: 'mcp_list',
    mutatesEnvironment: false,
    description:
      '列出当前已装的所有 MCP server——名字、当前运行状态、暴露的工具数。' +
      '用户问"你能干什么 / 装了哪些工具"时先调这个看清楚。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const { getSettings } = await import('../../projects/store');
      const { getAllRuntimeStates } = await import('../../mcp/registry');
      const settings = await getSettings();
      const runtimes = new Map(getAllRuntimeStates().map((r) => [r.serverId, r]));
      const list = (settings.mcpServers ?? []).map((s) => {
        const rt = runtimes.get(s.id);
        return {
          id: s.id,
          label: s.label,
          description: s.description ?? '',
          enabled: s.enabled,
          status: rt?.status ?? (s.enabled ? 'idle' : 'idle'),
          toolCount: rt?.toolCount ?? 0,
          lastError: rt?.lastError,
        };
      });
      return { text: JSON.stringify(list, null, 2) };
    },
  };
}

export function makeMcpInspectTool(): AgentTool {
  return {
    name: 'mcp_inspect',
    mutatesEnvironment: false,
    description:
      '查某个 MCP server 的详细配置 + 暴露的工具列表。env 只返回 key 列表（不返回 value 避免泄漏）。' +
      'server 不存在时返回 found=false。',
    inputSchema: {
      type: 'object',
      properties: { serverId: { type: 'string' } },
      required: ['serverId'],
    },
    async execute(input) {
      const { serverId } = input as { serverId: string };
      const { getSettings } = await import('../../projects/store');
      const { getRuntimeState, listTools } = await import('../../mcp/registry');
      const settings = await getSettings();
      const cfg = (settings.mcpServers ?? []).find((s) => s.id === serverId);
      if (!cfg) {
        return { text: JSON.stringify({ found: false, hint: `server ${serverId} 不存在或已删除` }) };
      }
      const rt = getRuntimeState(serverId);
      // 给模型的工具清单用「它能调的名字」——反射名撞上接口约束会被改写，与 server 端原名
      // 不再机械可推导；喂原名会让模型去调一个不存在的名字，回执走未声明工具分支、绕开中央闸。
      const tools = listTools(serverId).map((t) => ({
        name: t.callableName,
        sourceName: t.name,
        description: t.description,
      }));
      const detail = {
        found: true,
        id: cfg.id,
        label: cfg.label,
        description: cfg.description ?? '',
        command: cfg.command,
        args: cfg.args,
        envKeys: Object.keys(cfg.env ?? {}),  // 只 key 不 value
        enabled: cfg.enabled,
        probeTool: cfg.probeTool,
        status: rt?.status ?? 'idle',
        toolCount: rt?.toolCount ?? 0,
        tools,
        lastError: rt?.lastError,
        lastStderr: rt?.lastStderr,
      };
      return { text: JSON.stringify(detail, null, 2) };
    },
  };
}

// ─── 诊断类 ──────────────────────────────────────────

export function makeMcpTestConnectionTool(): AgentTool {
  return {
    name: 'mcp_test_connection',
    mutatesEnvironment: false,
    description:
      '临时测试某个 MCP server 的连接状态——已就绪的不会重启，失败 / 未启用的会临时拉一次连接。' +
      '结果不影响 server 当前运行状态。',
    inputSchema: {
      type: 'object',
      properties: { serverId: { type: 'string' } },
      required: ['serverId'],
    },
    async execute(input) {
      const { serverId } = input as { serverId: string };
      const { testServerConnection } = await import('../../mcp/registry');
      const state = await testServerConnection(serverId);
      return { text: JSON.stringify(state, null, 2) };
    },
  };
}

// ─── 写类 ───────────────────────────────────────────

export function makeMcpInstallTool(): AgentTool {
  return {
    name: 'mcp_install',
    mutatesEnvironment: true,
    description:
      '装一个新 MCP server（spawn 起进程 + 握手 + 可选探活）。' +
      '装好前不会返回——回执里是真实成败，成了才说成了。整个过程可能要几十秒（首次 npx 下载在内）。' +
      'env 完整传入（含 API key value）——需要用户过目时会明文展示在卡片上。',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '用户可见名（slug 会从 label 自动生成）' },
        description: { type: 'string', description: '一行简介，列表上显示' },
        command: { type: 'string', description: '如 "npx"' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '如 ["-y", "@linear/mcp@latest"]',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '环境变量；含 API key / token 时明文传——卡片上展示给用户审',
        },
        probeTool: { type: 'string', description: '可选：探活用的工具名' },
        enabled: { type: 'boolean', description: '装好后是否立即启用，默认 true（不传等于立即启动）；想"先装不启用"必须显式传 false' },
      },
      required: ['label', 'command', 'args'],
    },
    async execute(input, ctx) {
      const args = input as {
        label: string;
        description?: string;
        command: string;
        args: string[];
        env?: Record<string, string>;
        probeTool?: string;
        enabled?: boolean;
      };
      try {
        const proposal = buildInstallProposal({
          conversationId: ctx.conversationId,
          title: `建议安装 ${args.label}`,
          description: args.description ?? `安装 MCP server: ${args.label}`,
          config: {
            label: args.label,
            description: args.description,
            command: args.command,
            args: args.args,
            env: args.env,
            probeTool: args.probeTool,
            enabled: args.enabled ?? true,  // 默认启用——用户心智"装了就要能用"
          },
        });
        return await proposeOrExecuteEnvChange(ctx, proposal, {
          approvalText: `当前环境没有可确认的界面，未安装 ${args.label}。`,
          perform: async () => {
            const { serverId } = await performMcpInstall(proposal);
            return { text: `MCP server ${args.label} 已装好并启动（id: ${serverId}），它的工具现在就能调。` };
          },
        });
      } catch (e) {
        return { isError: true, text: `安装 ${args.label} 失败：${(e as Error).message}` };
      }
    },
  };
}

export function makeMcpUpdateTool(): AgentTool {
  return {
    name: 'mcp_update',
    mutatesEnvironment: true,
    description:
      '修改现有 MCP server 的配置——含启停（patch.enabled）。改完起不来会如实回报（配置已写新值、不回滚）。' +
      '改 env 时要传完整 env（mcp_inspect 不返 value，所以要保留原 key 必须让用户重新提供 value）。' +
      'label / description 改动不重启 server；其他字段改动会触发 restart。',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'mcp_list / mcp_inspect 返回的 id' },
        patch: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            description: { type: 'string' },
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            env: { type: 'object', additionalProperties: { type: 'string' } },
            probeTool: { type: 'string' },
            enabled: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['serverId', 'patch'],
    },
    async execute(input, ctx) {
      const args = input as { serverId: string; patch: McpServerPatch };
      try {
        const { getSettings } = await import('../../projects/store');
        const settings = await getSettings();
        const before = (settings.mcpServers ?? []).find((s) => s.id === args.serverId);
        if (!before) {
          return { isError: true, text: `server ${args.serverId} 不存在` };
        }
        // 卡片标题：仅 enabled 改 → 启用/停用 卡；其他 → 修改配置 卡
        const onlyEnabled =
          Object.keys(args.patch).length === 1 && 'enabled' in args.patch;
        const title = onlyEnabled
          ? `建议${args.patch.enabled ? '启用' : '停用'} ${before.label}`
          : `建议修改 ${before.label} 的配置`;
        const description = onlyEnabled
          ? `${args.patch.enabled ? '启用' : '停用'} ${before.label}`
          : `修改 ${before.label} 的配置`;
        const proposal = buildUpdateProposal({
          conversationId: ctx.conversationId,
          title,
          description,
          serverId: args.serverId,
          patch: args.patch,
          before,
        });
        const verb = onlyEnabled ? (args.patch.enabled ? '启用' : '停用') : '修改配置';
        return await proposeOrExecuteEnvChange(ctx, proposal, {
          approvalText: `当前环境没有可确认的界面，未${verb} ${before.label}。`,
          perform: async () => {
            await performMcpUpdate(proposal);
            return { text: `${before.label} 已${verb}并生效。` };
          },
        });
      } catch (e) {
        return { isError: true, text: `修改 ${args.serverId} 失败：${(e as Error).message}` };
      }
    },
  };
}

export function makeMcpDeleteTool(): AgentTool {
  return {
    name: 'mcp_delete',
    mutatesEnvironment: true,
    description:
      '删除一个 MCP server——会停掉子进程 + 从配置移除。env 值丢失后无法自动恢复。',
    inputSchema: {
      type: 'object',
      properties: { serverId: { type: 'string' } },
      required: ['serverId'],
    },
    async execute(input, ctx) {
      const args = input as { serverId: string };
      try {
        const { getSettings } = await import('../../projects/store');
        const { getRuntimeState } = await import('../../mcp/registry');
        const settings = await getSettings();
        const target = (settings.mcpServers ?? []).find((s) => s.id === args.serverId);
        if (!target) {
          return { isError: true, text: `server ${args.serverId} 不存在` };
        }
        const rt = getRuntimeState(args.serverId);
        const proposal = buildDeleteProposal({
          conversationId: ctx.conversationId,
          title: `建议删除 ${target.label}`,
          description: `删除 MCP server: ${target.label}`,
          serverId: args.serverId,
          target: {
            label: target.label,
            description: target.description,
            runtimeStatus: rt?.status,
            toolCount: rt?.toolCount,
          },
        });
        return await proposeOrExecuteEnvChange(ctx, proposal, {
          approvalText: `当前环境没有可确认的界面，未删除 ${target.label}。`,
          perform: async () => {
            await performMcpDelete(proposal);
            return { text: `MCP server ${target.label} 已删除，子进程已停、配置已移除。` };
          },
        });
      } catch (e) {
        return { isError: true, text: `删除 ${args.serverId} 失败：${(e as Error).message}` };
      }
    },
  };
}
