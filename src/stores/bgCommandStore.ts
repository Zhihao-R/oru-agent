import { create } from 'zustand';
import type { BgCommandView } from '@shared/protocol';
import { wsClient } from '@/lib/ws';

/**
 * 后台命令状态（S19 登记表的渲染层投影）——对话内后台命令行「运行中脉冲 + 时长」的数据源。
 * 挂载时全量拉一次（useBgCommandSync），之后靠 bgCommand.changed 增量维护。
 */
type BgCommandState = {
  byId: Record<string, BgCommandView>;
  refresh: () => Promise<void>;
  applyChange: (cmd: BgCommandView) => void;
};

export const useBgCommandStore = create<BgCommandState>((set) => ({
  byId: {},
  async refresh() {
    const res = await wsClient.request({ type: 'bgCommand.list' }).catch(() => null);
    if (res?.type !== 'bgCommand.state') return;
    set({ byId: Object.fromEntries(res.commands.map((c) => [c.id, c])) });
  },
  applyChange(cmd) {
    set((s) => ({ byId: { ...s.byId, [cmd.id]: cmd } }));
  },
}));
