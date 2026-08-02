/**
 * memoryStore op → cache key 显式 dispatch 表
 *
 * 用 Record<MemoryOpName, CacheKey[]> 强制类型穷尽——加新 op 时 TS 会报错提醒补这张表。
 * 不要用 substring 匹配 op 名字猜分类。
 */
import type { MemoryOpName } from '@shared/memory/operations';

/** 受 op 影响的缓存键 */
export type CacheKey = 'episodes' | 'predecessorByPath';

// MemoryOp 现在只剩 episode 结构化 op（档案类已退役、走文档模型）；前端 applyOps 仅可能带 episode op。
export const OP_CACHE_INVALIDATION: Record<MemoryOpName, CacheKey[]> = {
  'create-episode': ['episodes'],
  'supersede-episode': ['episodes', 'predecessorByPath'],
  'correct-episode': ['episodes'],
  'merge-episodes': ['episodes'],
  // retire 实际只由 dream 后台发（前端 applyOps 不会带它），列全为满足穷尽表
  'retire-episode': ['episodes'],
};
