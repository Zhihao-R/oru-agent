/**
 * 用量账本读取（S13 · G110）——拉全量日桶，渲染层按选定时间范围本地聚合。
 */
import type { RegistrySlice } from './types';
import { getUsageDays } from '../../usage/ledger';

export const usageHandlers = {
  'usage.get': async (req, { reply }) => {
    reply(req.reqId, { type: 'usage.state', days: await getUsageDays() });
  },
} satisfies RegistrySlice;
