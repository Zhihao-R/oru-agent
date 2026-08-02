/**
 * 内置召回流水线 —— MemoryRecaller 的默认实现（recall PRD §5 / §6.4）
 *
 * 收集候选（按规模分档）→ 廉价挑选器判断 → 按 id 取全文 + 算线索。一条管子，随规模加窄：
 * - tier 1（候选 ≤ DIRECT_INJECT_MAX）：跳过判断、全带（退化为「全量注入」即现状）。
 * - tier 2（更多）：跑廉价挑选器读简介挑相关，selected 上限内、常为 0。
 * （结构粗筛 tier 3 在 A8 加挂，gate 在数据后。）
 *
 * 拼接与围栏不在这里——recaller 只「选 + 给线索」，返回交编排层（runner）打围栏。本期不做外部 provider，
 * 内置实现即第一个实现；超时/降级由编排层包（对任何 recaller 一视同仁）。
 */
import { promises as fs } from 'node:fs';
import type { AgentBackend } from '@shared/agent/backend';
import type { MemoryRecaller, RecallQuery, RecallResult, RecalledMemory } from '@shared/memory/recall';
import { ensureWithinRoot, readMarkdownFile } from '../../fs/frontmatter';
import { resolveToFullRelPath } from '../compressedPath';
import { memoryRoot } from '../paths';
import { buildEpisodeBriefs, type EpisodeBrief } from './briefs';
import { runRecallPicker } from './picker';
import { BRIEF_BUDGET_CHARS, filterBriefsByProject, prefilterBriefsByBudget } from './prefilter';

/** 候选少到这个数以内 → 跳过挑选直接全带（PRD §5.3 tier 1，退化为全量注入即现状） */
export const DIRECT_INJECT_MAX = 50;

export type BuiltinRecallerOpts = {
  directInjectMax?: number;
  /** 简介块字符预算——超过才结构粗筛（PRD §5.3 第三档）；缺省 BRIEF_BUDGET_CHARS（正常规模不触发） */
  briefBudgetChars?: number;
  /** 挑选器后端（测试注入；缺省走 getBackendFor('memoryRecall')） */
  pickerBackend?: Pick<AgentBackend, 'runOneShot' | 'backendType' | 'modelId' | 'providerId'>;
};

/**
 * 按 id（compressedPath / 全 relPath）取记忆正文。沙箱(ensureWithinRoot)挡掉伪造/越界 id；
 * 文件不存在（已删）→ 跳过，这是「删了即不召回」的落点。返回的 body 是去 frontmatter 的正文。
 */
export async function fetchMemoryBodies(ownerId: string, ids: string[]): Promise<RecalledMemory[]> {
  const root = memoryRoot(ownerId);
  const out: RecalledMemory[] = [];
  for (const id of ids) {
    const rel = (await resolveToFullRelPath(ownerId, id)) ?? id;
    let abs: string;
    try {
      abs = ensureWithinRoot(root, rel);
    } catch {
      continue; // 越界 id 一律挡掉，不信任
    }
    const f = await readMarkdownFile(abs).catch(() => null);
    if (!f) continue; // 已删 / 读不到 → 跳过
    out.push({ relPath: rel, body: f.content.trim() });
  }
  return out;
}

function titlesFor(briefs: EpisodeBrief[], ids: string[]): string[] {
  const byId = new Map(briefs.map((b) => [b.id, b.title]));
  return ids.map((id) => byId.get(id) ?? id);
}

export class BuiltinRecaller implements MemoryRecaller {
  constructor(private readonly opts: BuiltinRecallerOpts = {}) {}

  async recall(query: RecallQuery, signal?: AbortSignal): Promise<RecallResult> {
    const all = await buildEpisodeBriefs(query.ownerId);
    // 项目维粗筛先行（G20）：按归属圈定——全局条目 + 当前项目条目，排除明确属于其他项目的。
    // 在 tier 分档之前砍，让 tier1「全带」阈值与挑选器候选都只面对当前项目相关的候选。
    const briefs = filterBriefsByProject(all, query.activeProjectId);
    if (briefs.length === 0) return { selected: [] };

    const max = this.opts.directInjectMax ?? DIRECT_INJECT_MAX;
    let selectedIds: string[];
    let hintIds: string[];
    if (briefs.length <= max) {
      selectedIds = briefs.map((b) => b.id); // tier 1：全带
      hintIds = [];
    } else {
      // tier 3：简介块超预算才结构粗筛（按近期硬维度砍）；否则全部 active 喂挑选器（tier 2）
      const candidates = prefilterBriefsByBudget(
        briefs,
        this.opts.briefBudgetChars ?? BRIEF_BUDGET_CHARS,
      );
      const out = await runRecallPicker(candidates, query.conversationWindow, {
        backend: this.opts.pickerBackend,
        ownerId: query.ownerId,
        signal,
      });
      selectedIds = out.selected;
      hintIds = out.hints;
    }

    const selected = await fetchMemoryBodies(query.ownerId, selectedIds);
    const hint = hintIds.length > 0 ? { neighbors: titlesFor(briefs, hintIds) } : undefined;
    return { selected, hint };
  }
}
