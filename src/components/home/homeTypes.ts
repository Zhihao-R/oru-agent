/**
 * 主页浮层与筛选的共享类型。overlay 只带 id（relPath / projectId），浮层内自行从 store 重读，
 * 避免把可能陈旧的对象快照塞进 state。
 */
import type { EpisodeType } from '@shared/types';

export type HomeOverlay =
  | { kind: 'editProfile' }
  | { kind: 'note'; relPath: string }
  | { kind: 'aboutYou' }
  | { kind: 'aboutSelf' }
  | { kind: 'project'; projectId: string }
  | { kind: 'nights' }
  | { kind: 'filter' };

export type NoteFilter = { type: EpisodeType | null; tags: Set<string> };

export const EMPTY_FILTER: NoteFilter = { type: null, tags: new Set() };
