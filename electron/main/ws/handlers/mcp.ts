/**
 * mcp.* 命令处理器（D2(a) 迁移域）——外部 MCP server 管理（v0.5）。
 * 行为与原 router.ts switch 内 mcp.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对动态 import 路径相应多一层 `../`。
 */
import type { RegistrySlice } from './types';
import { getSettings } from '../../projects/store';

export const mcpHandlers = {
  // v0.5：外部 MCP server 管理
  'mcp.testConnection': async (req, { reply }) => {
    const { testServerConnection } = await import('../../mcp/registry');
    const state = await testServerConnection(req.serverId);
    reply(req.reqId, {
      type: 'mcp.test.result',
      serverId: req.serverId,
      status: state.status,
      toolCount: state.toolCount,
      message: state.lastError,
    });
  },
  'mcp.listTools': async (req, { reply }) => {
    const { listTools } = await import('../../mcp/registry');
    reply(req.reqId, {
      type: 'mcp.tools.list',
      serverId: req.serverId,
      tools: listTools(req.serverId),
    });
  },
  'mcp.restart': async (req, { reply }) => {
    const { restartServer, getRuntimeState } = await import('../../mcp/registry');
    await restartServer(req.serverId, req.takeOver ?? false);
    const state = getRuntimeState(req.serverId);
    reply(req.reqId, {
      type: 'mcp.restart.result',
      serverId: req.serverId,
      status: state?.status ?? 'idle',
      toolCount: state?.toolCount,
      message: state?.lastError,
      circuitOpenUntil: state?.circuitOpenUntil,
    });
  },
  'mcp.create': async (req, { reply, broadcast }) => {
    const { createServer } = await import('../../mcp/registry');
    try {
      const c = req.config;
      // 新建态草稿允许 label / command 为空（PRD 决策 1：空白表单）；
      // 后端只校验类型 + args 元素必须是字符串。
      // 真正启动 server 需要 enabled=true，那时如果 command 仍空 startServer 会抛错。
      if (typeof c.label !== 'string') {
        reply(req.reqId, { type: 'mcp.create.result', ok: false, message: 'label 必须是字符串' });
        return;
      }
      if (typeof c.command !== 'string') {
        reply(req.reqId, { type: 'mcp.create.result', ok: false, message: 'command 必须是字符串' });
        return;
      }
      if (!Array.isArray(c.args) || !c.args.every((a) => typeof a === 'string')) {
        reply(req.reqId, { type: 'mcp.create.result', ok: false, message: 'args 必须是字符串数组' });
        return;
      }
      const cfg = await createServer(c);
      reply(req.reqId, { type: 'mcp.create.result', ok: true, serverId: cfg.id });
      // 关键：广播 settings 让前端 store 同步新列表
      const settings = await getSettings();
      broadcast({ type: 'settings.state', settings });
    } catch (e) {
      reply(req.reqId, {
        type: 'mcp.create.result',
        ok: false,
        message: (e as Error).message,
      });
    }
  },
  'mcp.update': async (req, { reply, broadcast }) => {
    const { updateServer, getRuntimeState } = await import('../../mcp/registry');
    try {
      // 校验 patch.args（若给）元素类型
      if (
        req.patch.args !== undefined &&
        (!Array.isArray(req.patch.args) ||
          !req.patch.args.every((a) => typeof a === 'string'))
      ) {
        reply(req.reqId, {
          type: 'mcp.update.result',
          serverId: req.serverId,
          ok: false,
          message: 'args 必须是字符串数组',
        });
        return;
      }
      const next = await updateServer(req.serverId, req.patch);
      if (!next) {
        reply(req.reqId, {
          type: 'mcp.update.result',
          serverId: req.serverId,
          ok: false,
          message: 'server not found',
        });
        return;
      }
      const state = getRuntimeState(req.serverId);
      reply(req.reqId, {
        type: 'mcp.update.result',
        serverId: req.serverId,
        ok: true,
        status: state?.status,
        toolCount: state?.toolCount,
        message: state?.lastError,
        circuitOpenUntil: state?.circuitOpenUntil,
      });
      // 广播 settings 让前端 store 同步
      const settings = await getSettings();
      broadcast({ type: 'settings.state', settings });
    } catch (e) {
      reply(req.reqId, {
        type: 'mcp.update.result',
        serverId: req.serverId,
        ok: false,
        message: (e as Error).message,
      });
    }
  },
  'mcp.runtime.list': async (req, { reply }) => {
    const { getAllRuntimeStates, listUnmanagedMcpServerNames } = await import('../../mcp/registry');
    reply(req.reqId, {
      type: 'mcp.runtime.list.result',
      states: getAllRuntimeStates(),
      unmanaged: await listUnmanagedMcpServerNames(),
    });
  },
  'mcp.delete': async (req, { reply, broadcast }) => {
    const { deleteServer } = await import('../../mcp/registry');
    try {
      const ok = await deleteServer(req.serverId);
      reply(req.reqId, {
        type: 'mcp.delete.result',
        serverId: req.serverId,
        ok,
        message: ok ? undefined : 'server not found',
      });
      if (ok) {
        const settings = await getSettings();
        broadcast({ type: 'settings.state', settings });
      }
    } catch (e) {
      reply(req.reqId, {
        type: 'mcp.delete.result',
        serverId: req.serverId,
        ok: false,
        message: (e as Error).message,
      });
    }
  },
} satisfies RegistrySlice;
