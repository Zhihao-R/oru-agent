/**
 * 手账线 / 对话线的「当前线」状态与顶栏、着陆面的联动。
 *
 * `line` = 你此刻在哪条线（手账线 memory / 对话线 chat），点击驱动、始终有效——由点顶栏入口、
 * 打开/新建对话（conversationStore.setActive 收口）决定，不再跟随着陆面滚动派生。屏幕显示由
 * `(line, activeConvId)` 唯一决定，顶栏「对话 / 手账」高亮直接读 `line`。初始 `memory`：冷启动
 * 落手账页（家）。设计见 docs/plans/2026-07-23-手账与对话解耦-设计.md。
 *
 * `scrollRequest`：顶栏点「手账」时请求着陆面滚到手账区（≈ 昨夜），HomeLanding 消费即清。冷启动
 * 无此请求 → 着陆面停在顶部启动器；点手账进来才落昨夜。
 */
import { create } from 'zustand';

export type LandingLine = 'chat' | 'memory';

interface LandingNavState {
  line: LandingLine;
  setLine: (line: LandingLine) => void;
  scrollRequest: LandingLine | null;
  requestScroll: (r: LandingLine) => void;
  consumeScroll: () => void;
}

export const useLandingNavStore = create<LandingNavState>((set) => ({
  line: 'memory',
  setLine: (line) => set((s) => (s.line === line ? s : { line })),
  scrollRequest: null,
  requestScroll: (scrollRequest) => set({ scrollRequest }),
  consumeScroll: () => set({ scrollRequest: null }),
}));
