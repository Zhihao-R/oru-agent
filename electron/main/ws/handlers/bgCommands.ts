/**
 * bgCommand.* 命令处理器——对话内后台命令行的活状态数据源（S19 登记表的只读投影）。
 * list 连上/重连取全量；output 读累积输出尾部（与 read_background_output 同一读取内核）。
 */
import type { BgCommandView } from '@shared/protocol';
import type { RegistrySlice } from './types';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';
import type { BackgroundCommandRecord } from '../../proposals/backgroundCommandStore';

/** 登记表记录 → 渲染层视图（裁掉 pid / outputPath 等纯主进程字段） */
export function toBgCommandView(rec: BackgroundCommandRecord): BgCommandView {
  return {
    id: rec.id,
    conversationId: rec.conversationId,
    status: rec.status,
    exitCode: rec.exitCode,
    timedOut: rec.timedOut,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  };
}

export const bgCommandHandlers = {
  'bgCommand.list': async (req, { reply }) => {
    const { listBackgroundCommands } = await import('../../proposals/backgroundCommandStore');
    const all = await listBackgroundCommands(getCurrentOwnerId());
    reply(req.reqId, { type: 'bgCommand.state', commands: all.map(toBgCommandView) });
  },
  'bgCommand.output': async (req, { reply }) => {
    const { readBackgroundOutputTail } = await import('../../proposals/backgroundCommandStore');
    const text = await readBackgroundOutputTail(getCurrentOwnerId(), req.id);
    reply(req.reqId, { type: 'bgCommand.output.result', id: req.id, text });
  },
} satisfies RegistrySlice;
