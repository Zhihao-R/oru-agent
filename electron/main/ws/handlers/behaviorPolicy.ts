/**
 * behaviorPolicy.* 命令处理器（2026-07-31 策略表双向开关）——「收紧覆盖」的读取与写入。
 * 语义镜像 grants.*：list 拉全量；setAsk 写后回最新全量清单（省一次 round-trip）；
 * persisted:false（写盘失败 / 非法行 id）如实回执。有意不校验当前挡位（同 grants：置灰是
 * 呈现语义而非安全边界——收紧覆盖只在工作挡消费，哪挡写入都不改变另两挡行为）。
 */
import type { RegistrySlice } from './types';
import { listAskOverrides, setAskOverridden } from '../../proposals/behaviorPolicy/store';

export const behaviorPolicyHandlers = {
  'behaviorPolicy.list': async (req, { reply }) => {
    reply(req.reqId, { type: 'behaviorPolicy.list.result', askRows: await listAskOverrides() });
  },
  'behaviorPolicy.setAsk': async (req, { reply }) => {
    const r = await setAskOverridden(req.rowId, req.ask);
    reply(req.reqId, {
      type: 'behaviorPolicy.list.result',
      askRows: await listAskOverrides(),
      ...(r.persisted ? {} : { persistFailed: true }),
    });
  },
} satisfies RegistrySlice;
