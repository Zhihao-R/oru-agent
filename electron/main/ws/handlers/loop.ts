/**
 * Loop 模式命令处理器（v3）。
 * loop.stop：叫停进行中的 Loop。loop.editChecklist：中途改标准（下一轮生效）。
 * 未命中运行中的 Loop（已结束/不存在）时静默 ack（幂等、防抖）。v3 砍掉 loop.confirm（开工前确认门）
 * 与 loop.vetoStandard（通病否决）；loop.resumeDecision（跨重启续跑/作罢）随恢复路径退役
 * （2026-07-28 去特殊化 T3：断了想续 = 再发一条，中断卡纯陈列）。
 */
import type { RegistrySlice } from './types';
import { stopLoop, editLoopChecklist } from '../../loop/registry';

export const loopHandlers = {
  'loop.stop': async (req, { reply }) => {
    stopLoop(req.loopId); // 未命中运行中 Loop → 静默（已结束/不存在）
    reply(req.reqId, { type: 'ack' });
  },

  'loop.editChecklist': async (req, { reply }) => {
    editLoopChecklist(req.loopId, req.edit);
    reply(req.reqId, { type: 'ack' });
  },
} satisfies RegistrySlice;
