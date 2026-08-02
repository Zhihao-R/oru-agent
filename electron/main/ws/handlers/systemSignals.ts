/**
 * 系统信号读取与忽略（S14 · G106）——list 取初值，dismiss 忽略一条；升起 / 消解由各源驱动、
 * 经 system.signals 广播增量（见 notifications/systemSignals）。
 */
import type { RegistrySlice } from './types';
import { listSystemSignals, dismissSystemSignal } from '../../notifications/systemSignals';

export const systemSignalHandlers = {
  'system.signals.list': async (req, { reply }) => {
    reply(req.reqId, { type: 'system.signals', signals: listSystemSignals() });
  },
  'system.signals.dismiss': async (req, { reply }) => {
    dismissSystemSignal(req.id);
    reply(req.reqId, { type: 'system.signals', signals: listSystemSignals() });
  },
} satisfies RegistrySlice;
