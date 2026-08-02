/**
 * 调试面板的渲染端 store —— 管理 round 列表、选中轮、时间线模型、选中事件。
 *
 * 列表粒度：一行 = 一次行为（round）。同一 conversation 多轮会出现多条独立 RoundSummary。
 * 切换轮：读整个文件后按 roundId 过滤再喂 buildTimelineModel。
 */
import { create } from 'zustand';

import type { DebugRecord, RoundSummary } from '@shared/debug/types';
import { parseNdjson } from '@/lib/parseNdjson';
import { buildTimelineModel, type TimelineModel, type ToolMeta } from '@/lib/buildTimelineModel';

export interface SelectedEvent {
  id: string;
  /** 该事件对应的源 record，详情面板按 type 选子组件渲染 */
  record: DebugRecord;
  /** 工具调用专用：扁平的 name + input（来自 buildTimelineModel 合并 start record） */
  toolMeta?: ToolMeta;
}

export interface SelectedRoundKey {
  dateKey: string;
  conversationId: string;
  roundId: string;
}

type DebugState = {
  rounds: RoundSummary[];
  loading: boolean;
  selectedKey: SelectedRoundKey | null;
  timeline: TimelineModel | null;
  /** 选中事件——浮层抽屉的 trigger */
  selectedEvent: SelectedEvent | null;

  loadRounds: () => Promise<void>;
  selectRound: (key: SelectedRoundKey) => Promise<void>;
  selectEvent: (e: SelectedEvent | null) => void;
  clearAll: () => Promise<void>;
};

export const useDebugStore = create<DebugState>((set, get) => ({
  rounds: [],
  loading: false,
  selectedKey: null,
  timeline: null,
  selectedEvent: null,

  async loadRounds() {
    set({ loading: true });
    try {
      const rounds = await window.oruDebug.list();
      set({ rounds, loading: false });
    } catch (e) {
      console.warn('[debugStore] loadRounds failed', e);
      set({ loading: false });
    }
  },

  async selectRound(key) {
    set({
      selectedKey: key,
      timeline: null,
      selectedEvent: null,
    });
    try {
      const text = await window.oruDebug.read(key.dateKey, key.conversationId);
      const records = parseNdjson(text).filter((r) => r.roundId === key.roundId);
      const timeline = buildTimelineModel(records);
      // 竞态守卫：用户在 await 期间切到别的 round，丢弃这次结果
      const cur = get().selectedKey;
      if (
        cur?.dateKey !== key.dateKey ||
        cur?.conversationId !== key.conversationId ||
        cur?.roundId !== key.roundId
      ) {
        return;
      }
      set({ timeline });
    } catch (e) {
      console.warn('[debugStore] selectRound failed', e);
      // 解除"载入中…"假象——失败时让 UI 显示空态，由用户重新选择
      set({ timeline: null });
    }
  },

  selectEvent(e) {
    set({ selectedEvent: e });
  },

  async clearAll() {
    try {
      await window.oruDebug.clearAll();
      set({ rounds: [], selectedKey: null, timeline: null, selectedEvent: null });
    } catch (e) {
      console.warn('[debugStore] clearAll failed', e);
    }
  },
}));
