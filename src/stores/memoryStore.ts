/**
 * memoryStore — 渲染端缓存 v2 记忆数据
 *
 * 写入统一走 applyOps（op 代数）；读按资源拆分（用户 / 项目 / 笔记各一条 IPC）。
 * 读细 / 写粗的不对称是有意为之——读各资源缓存策略不同，写共用一套语义。
 */
import { create } from 'zustand';
import { wsClient } from '@/lib/ws';
import type {
  MemoryApplyOpsResultEvent,
  MemoryAgentSelfResultEvent,
  MemoryChangelogResultEvent,
  MemoryDreamRunNowResultEvent,
  MemoryDocResultEvent,
  MemoryEpisodeContentResultEvent,
  MemoryEpisodePredecessorResultEvent,
  MemoryEpisodesResultEvent,
  MemoryProjectListResultEvent,
  MemoryProjectProfileResultEvent,
  ServerEvent,
} from '@shared/protocol';
import type { MemoryOp } from '@shared/memory/operations';
import type { ProfileDoc } from '@shared/memory/profileDoc';
import type {
  EpisodeWithBody,
  MemoryProjectProfile,
  ProjectListEntry,
} from '@shared/types';
import { OP_CACHE_INVALIDATION } from './memoryStoreOpCache';

export type EpisodeEntry = MemoryEpisodesResultEvent['episodes'][number];

type State = {
  // ─── v2 数据 ────────────────────────────────────────
  docs: Record<string, ProfileDoc>;
  /** 各档案 frontmatter 的 last-updated（YYYY-MM-DD）；手账「修订 MM·DD」用（C5） */
  docLastUpdatedByPath: Record<string, string>;
  agentSelf: string;
  projects: ProjectListEntry[];
  projectProfileByPid: Record<string, MemoryProjectProfile>;
  predecessorByPath: Record<string, EpisodeWithBody | null>;

  // ─── episode 列表 / 内容 / 删除 ────────────────────────
  episodes: EpisodeEntry[];
  episodeContent: Record<string, string>;

  // ─── dream 纠错与淘汰的展示数据 ─────────────────────
  /** status=retired 的条目（手账「已整理掉」展开）；null = 尚未拉取 */
  retiredEpisodes: EpisodeEntry[] | null;
  /** memory/changelog.md 全文（「整理记录」节）；null = 尚未拉取 */
  changelog: string | null;

  error: string | null;

  // ─── v2 读 ─────────────────────────────────────────
  /** 读/写自由分章档案（write 整篇覆盖，前端改完 ProfileDoc 结构回传，永不丢小节） */
  fetchDoc(relPath: string): Promise<void>;
  writeDoc(relPath: string, doc: ProfileDoc): Promise<void>;
  fetchAgentSelf(): Promise<void>;
  fetchProjects(): Promise<void>;
  fetchProjectProfile(projectId: string): Promise<void>;
  fetchEpisodes(): Promise<void>;                          // 固定 includeSuperseded=false
  fetchRetiredEpisodes(): Promise<void>;                   // includeSuperseded=true 后筛 retired
  fetchChangelog(): Promise<void>;
  fetchEpisodeContent(relPath: string): Promise<string>;
  fetchPredecessor(relPath: string): Promise<EpisodeWithBody | null>;

  // ─── v2 写 ─────────────────────────────────────────
  applyOps(ops: MemoryOp[]): Promise<void>;
  deleteEpisode(relPath: string): Promise<void>;
  /** 手动跑一次 dream 整理（memory.dream.runNow）；返回是否非失败（ok/skipped 均 true） */
  runDream(): Promise<boolean>;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useMemoryStore = create<State>((set, get) => ({
  docs: {},
  docLastUpdatedByPath: {},
  agentSelf: '',
  projects: [],
  projectProfileByPid: {},
  predecessorByPath: {},

  episodes: [],
  episodeContent: {},

  retiredEpisodes: null,
  changelog: null,

  error: null,

  // ─── v2 读 ───────────────────────────────────────────
  async fetchDoc(relPath) {
    try {
      const res = await wsClient.request<MemoryDocResultEvent>({ type: 'memory.doc.read', relPath });
      if (res.type === 'memory.doc.result') {
        set((s) => ({
          docs: { ...s.docs, [res.relPath]: res.doc },
          docLastUpdatedByPath: res.lastUpdated
            ? { ...s.docLastUpdatedByPath, [res.relPath]: res.lastUpdated }
            : s.docLastUpdatedByPath,
        }));
      }
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
  async writeDoc(relPath, doc) {
    try {
      const res = await wsClient.request<MemoryDocResultEvent>({
        type: 'memory.doc.write',
        relPath,
        doc,
      });
      if (res.type === 'memory.doc.result') {
        set((s) => ({
          docs: { ...s.docs, [res.relPath]: res.doc },
          docLastUpdatedByPath: res.lastUpdated
            ? { ...s.docLastUpdatedByPath, [res.relPath]: res.lastUpdated }
            : s.docLastUpdatedByPath,
        }));
      }
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
  async fetchAgentSelf() {
    try {
      const res = await wsClient.request<MemoryAgentSelfResultEvent>({
        type: 'memory.agentSelf.read',
      });
      if (res.type === 'memory.agentSelf.result') set({ agentSelf: res.content });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
  async fetchProjects() {
    try {
      const res = await wsClient.request<MemoryProjectListResultEvent>({
        type: 'memory.projectList.readAll',
      });
      if (res.type === 'memory.projectList.result') set({ projects: res.projects });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
  async fetchProjectProfile(projectId) {
    try {
      const res = await wsClient.request<MemoryProjectProfileResultEvent>({
        type: 'memory.projectProfile.read',
        projectId,
      });
      if (res.type === 'memory.projectProfile.result') {
        set((s) => ({
          projectProfileByPid: { ...s.projectProfileByPid, [projectId]: res.profile },
        }));
      }
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
  async fetchEpisodes() {
    try {
      const res = await wsClient.request<MemoryEpisodesResultEvent>({
        type: 'memory.listEpisodes',
        includeSuperseded: false,
      });
      if (res.type === 'memory.episodes.result') {
        set({ episodes: [...res.episodes].sort((a, b) => b.mtime - a.mtime) });
      }
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
  async fetchRetiredEpisodes() {
    try {
      const res = await wsClient.request<MemoryEpisodesResultEvent>({
        type: 'memory.listEpisodes',
        includeSuperseded: true,
      });
      if (res.type === 'memory.episodes.result') {
        set({
          retiredEpisodes: res.episodes
            .filter((e) => e.status === 'retired')
            .sort((a, b) => b.mtime - a.mtime),
        });
      }
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
  async fetchChangelog() {
    try {
      const res = await wsClient.request<MemoryChangelogResultEvent>({
        type: 'memory.readChangelog',
      });
      if (res.type === 'memory.changelog.result') set({ changelog: res.content });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
  async fetchEpisodeContent(relPath) {
    const cached = get().episodeContent[relPath];
    if (cached) return cached;
    try {
      const res = await wsClient.request<MemoryEpisodeContentResultEvent>({
        type: 'memory.readEpisode',
        relPath,
      });
      if (res.type === 'memory.episode.content.result') {
        set((s) => ({ episodeContent: { ...s.episodeContent, [relPath]: res.content } }));
        return res.content;
      }
      return '';
    } catch (e) {
      set({ error: errMsg(e) });
      return '';
    }
  },
  async fetchPredecessor(relPath) {
    const cached = get().predecessorByPath[relPath];
    if (cached !== undefined) return cached;
    try {
      const res = await wsClient.request<MemoryEpisodePredecessorResultEvent>({
        type: 'memory.episode.readPredecessor',
        relPath,
      });
      if (res.type === 'memory.episode.predecessor.result') {
        set((s) => ({
          predecessorByPath: { ...s.predecessorByPath, [relPath]: res.predecessor },
        }));
        return res.predecessor;
      }
      return null;
    } catch (e) {
      set({ error: errMsg(e) });
      return null;
    }
  },

  // ─── v2 写 ───────────────────────────────────────────
  async applyOps(ops) {
    set({ error: null });
    try {
      const res = await wsClient.request<MemoryApplyOpsResultEvent>({
        type: 'memory.applyOps',
        ops,
        origin: 'ui',
      });
      if (res.type !== 'memory.applyOps.result') return;

      // 按 op → cache key 显式失效。只对成功 op 触发——失败的 op onDisk 没变，refetch 没意义。
      const successOps = res.result.results
        .map((r, i) => (r.ok ? ops[i] : null))
        .filter((op): op is MemoryOp => op !== null);
      // MemoryOp 现在只剩 episode 结构化 op（档案走文档模型），失效面仅 episodes / predecessorByPath
      const affected = new Set<string>();
      for (const op of successOps) {
        for (const k of OP_CACHE_INVALIDATION[op.op]) affected.add(k);
      }
      if (affected.has('episodes')) void get().fetchEpisodes();
      if (affected.has('predecessorByPath')) set({ predecessorByPath: {} });

      // 失败 op 的错误信息 toast
      const errs = res.result.results.filter((r) => !r.ok);
      if (errs.length > 0) {
        const msg = errs.map((r) => (r.ok ? '' : `${r.op}: ${r.error}`)).join('；');
        set({ error: msg });
      }
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
  async deleteEpisode(relPath) {
    try {
      await wsClient.request({ type: 'memory.deleteEpisode', relPath });
      set((s) => ({
        episodes: s.episodes.filter((ep) => ep.relPath !== relPath),
        episodeContent: Object.fromEntries(
          Object.entries(s.episodeContent).filter(([k]) => k !== relPath),
        ),
      }));
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  async runDream() {
    try {
      const res = await wsClient.request<MemoryDreamRunNowResultEvent>({ type: 'memory.dream.runNow' });
      return res.type === 'memory.dream.runNow.result' && res.summary.kind !== 'failed';
    } catch (e) {
      set({ error: errMsg(e) });
      return false;
    }
  },
}));

/**
 * 订阅 memory.doc.changed 广播（nit 12，仿 bindEditorAutoSync 模式）：档案的任何写入路径
 * （编辑器落盘 / AI 写档 / 历史恢复）主进程都广播此事件——命中时对 relPath 重新 fetchDoc，
 * docLastUpdatedByPath 即时刷新，overlay footer「最后修订于」、手账「关于你」徽标、正文预览
 * 三处显示同步愈。一处订阅覆盖全部写入路径，比「给 writeLive 响应加字段」系统性。
 * 新建档案的「—」同样在首次编辑落盘后自愈（写入时主进程刷新 frontmatter last-updated）。
 */
let docChangedUnsub: (() => void) | null = null;
export function bindMemoryDocSync(): void {
  if (docChangedUnsub) return;
  docChangedUnsub = wsClient.subscribe((ev: ServerEvent) => {
    if (ev.type !== 'memory.doc.changed') return;
    void useMemoryStore.getState().fetchDoc(ev.relPath);
  });
}

/** 测试用：解订阅 + 清模块级 guard，让下个用例能重新 bind（与 __resetEditorAutoSyncForTest 同范式）。 */
export function __resetMemoryDocSyncForTest(): void {
  docChangedUnsub?.();
  docChangedUnsub = null;
}
