/**
 * auth/system/desktopPresence 三个相邻小域命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内对应各 case 字节级一致——纯搬运。
 */
import { ErrorCodes } from '@shared/types';
import type { RegistrySlice } from './types';
import { mainChatStatus } from '../../agent/backends/readiness';
import { errMsg } from '../errors';

export const systemHandlers = {
  // 口径：主对话是否有可用模型后端（不再单看 Claude 鉴权），见 readiness.mainChatStatus
  'auth.status': async (req, { reply }) => {
    const status = await mainChatStatus();
    reply(req.reqId, { type: 'auth.status', status });
  },
  'system.openPath': async (req, { reply }) => {
    try {
      // 动态 import：smoke 测试不在 Electron 进程下，会缺 electron 模块
      const { shell } = await import('electron');
      await shell.openPath(req.path);
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'desktopPresence.permissions': async (req, { reply }) => {
    // 动态 import：desktop 模块顶层拉 uiohook 等 native 依赖，非 Electron 进程会缺
    const { screenRecordingStatus } = await import('../../desktop/permissions');
    reply(req.reqId, {
      type: 'desktopPresence.permissions.result',
      screenRecording: screenRecordingStatus(),
    });
  },
  'desktopPresence.openPermission': async (req, { reply }) => {
    try {
      const { openScreenRecordingSettings, openInputMonitoringSettings } = await import(
        '../../desktop/permissions'
      );
      if (req.target === 'screen') openScreenRecordingSettings();
      else openInputMonitoringSettings();
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
} satisfies RegistrySlice;
