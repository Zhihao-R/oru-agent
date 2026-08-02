/**
 * desktop.* 命令处理器（S30·G51 找人阶梯第二级）。
 * 渲染端把当前「需要你处理」集合推来，交给 desktopAttention 内核据前台态弹系统通知 / 设程序坞角标。
 */
import type { RegistrySlice } from './types';
import { updateDesktopAttention } from '../../notifications/desktopAttention';

export const desktopHandlers = {
  'desktop.attention': async (req, { reply }) => {
    updateDesktopAttention(req.items);
    reply(req.reqId, { type: 'ack' });
  },
} satisfies RegistrySlice;
