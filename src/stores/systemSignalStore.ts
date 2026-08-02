/**
 * 系统信号前端 store（S14 · G106/G127）——持有当前在场的系统信号（不归任何对话）。
 * 主进程单一裁决：连上取初值、之后以 system.signals 广播的全量为准（不做乐观更新）。
 */
import { create } from 'zustand';
import type { SystemSignal } from '@shared/protocol';
import { wsClient } from '@/lib/ws';

type SystemSignalState = {
  signals: SystemSignal[];
  sync: (signals: SystemSignal[]) => void;
  dismiss: (id: string) => Promise<void>;
};

export const useSystemSignalStore = create<SystemSignalState>((set) => ({
  signals: [],
  sync: (signals) => set({ signals }),
  dismiss: async (id) => {
    const res = await wsClient.request({ type: 'system.signals.dismiss', id });
    if (res.type === 'system.signals') set({ signals: res.signals });
  },
}));
