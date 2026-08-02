/**
 * 召回找回率评估 harness（PRD §7）—— 在 2026-06-01 检索评估基础上扩展到「召回流水线」
 *
 * 找回率口径：一条查询的 golden 记忆是否被带进**最终上下文**（常驻认知 snapshot ∪ 召回块）——机器可判定
 * （每条 golden 埋一个唯一 token，查上下文是否含它）。按四桶分别给率：近期 / 久远 / 跨项目 / 用户标记必记。
 *
 * - 必记桶：用户标记必记 → 写进 user/profile.md（常驻全程在场），其 token 由 snapshot 携带、不依赖召回挑选
 *   → 找回率应恒 1.0（验收 §7.2「说记必记」的「始终在场」半边）。
 * - 其余三桶：episode → 由召回器选中后注入召回块才算找回。
 *
 * recaller 可注入：CI 自检用 stub（验 harness 计量本身），手动真评用 BuiltinRecaller（真 picker 模型）。
 */
import { promises as fs } from 'node:fs';
import type { ChatMessage } from '@shared/types';
import type { MemoryRecaller } from '@shared/memory/recall';
import { buildSnapshot } from '../../../electron/main/memory/snapshot';
import { buildRecallInjection } from '../../../electron/main/memory/recall/inject';
import { writeMemoryDocument } from '../../../electron/main/memory/documentIo';
import type { EpisodeFixture } from '../retrieval/corpus';
import { writeCorpusToDisk } from '../retrieval/retrieval';

export type Bucket = 'recent' | 'distant' | 'cross-project' | 'must-remember';

export type BucketQuery = {
  q: string; // 用户怎么问——问法故意和记忆里的措辞错开
  token: string; // golden 记忆体里埋的唯一标记，用于机器判定找回
  bucket: Bucket;
};

export type RecallCorpus = {
  episodes: EpisodeFixture[];
  profileBody: string; // user/profile.md 正文（含必记桶 token）
  queries: BucketQuery[];
  crossProjectId?: string; // 跨项目桶所属项目 id（G20 粗筛：非该项目回合应排除它）
};

/** 一个上屏问句包成单条 user history（projectConversationWindow 会投影它） */
function asHistory(q: string): ChatMessage[] {
  return [{ id: 'q', conversationId: 'c', role: 'user', text: q, toolCalls: [], createdAt: 1, done: true }];
}

/**
 * 组装一条查询的最终上下文：常驻 snapshot + 召回块。
 * activeProjectId：当前项目（G20 粗筛按归属圈定；缺省 null = 无当前项目，只圈全局条目）——
 * snapshot 与召回块同取一个当前项目，口径一致。
 */
export async function assembleContext(
  ownerId: string,
  q: string,
  recaller: MemoryRecaller,
  activeProjectId: string | null = null,
): Promise<string> {
  const snap = await buildSnapshot(ownerId, activeProjectId);
  const recall = await buildRecallInjection({
    ownerId,
    history: asHistory(q),
    recaller,
    activeProjectId,
  });
  return `${snap}\n\n${recall}`;
}

export type FindRate = Record<Bucket, { found: number; total: number; rate: number }>;

export async function measureFindRate(
  ownerId: string,
  corpus: RecallCorpus,
  recaller: MemoryRecaller,
  activeProjectId: string | null = null,
): Promise<FindRate> {
  const acc: FindRate = {
    recent: { found: 0, total: 0, rate: 0 },
    distant: { found: 0, total: 0, rate: 0 },
    'cross-project': { found: 0, total: 0, rate: 0 },
    'must-remember': { found: 0, total: 0, rate: 0 },
  };
  for (const query of corpus.queries) {
    const ctx = await assembleContext(ownerId, query.q, recaller, activeProjectId);
    acc[query.bucket].total += 1;
    if (ctx.includes(query.token)) acc[query.bucket].found += 1;
  }
  for (const b of Object.keys(acc) as Bucket[]) {
    acc[b].rate = acc[b].total > 0 ? acc[b].found / acc[b].total : 0;
  }
  return acc;
}

/** 把语料落盘：episodes 走 episode 路径，必记走 user/profile.md 常驻档案 */
export async function writeRecallCorpus(ownerId: string, corpus: RecallCorpus): Promise<void> {
  await writeCorpusToDisk(ownerId, corpus.episodes);
  await writeMemoryDocument(ownerId, 'user/profile.md', corpus.profileBody);
}

/** 删除一条 episode 文件（验「删了即忘」用） */
export async function deleteEpisode(ownerId: string, ep: EpisodeFixture): Promise<void> {
  const { memoryRoot } = await import('../../../electron/main/memory/paths');
  const { join } = await import('node:path');
  const dir = ep.scope === 'project' ? `projects/${ep.projectId}/episodes` : 'agents/twin/episodes';
  await fs.rm(join(memoryRoot(ownerId), dir, `${ep.date}-${ep.slug}.md`), { force: true });
}
