/**
 * 注入快照拼装 — Twin 每次对话开始时塞进 system prompt
 *
 * 结构（常驻认知，每轮完整带上、不参与召回挑选）：
 *   ## Twin 自己（agents/twin/self.md）          —— self.md
 *   ## 关于你（user/profile.md）                  —— 自由分章档案（印象 + 各 ## 小节，ProfileDoc）
 *   ## 项目列表（projects/*\/list-entry.md）       —— 聚合
 *   ## 当前项目 <id>（projects/<id>/profile.md）  —— 仅当前项目
 *
 * **不再常驻全量事件索引**（PRD §5.2）：老的「## Memory Index」（按比例 + 保底选 ≤200 行）已删——
 * 实测 0 次自发翻、又不随规模 scale、还和召回器职责重复。相关往事改由召回器按需注入全文，
 * 「还有哪些可挖」由召回器附的轻量线索（hint）给；主模型保留 grep_memory / read_memory 自己深挖。
 *
 * 标题里附 v2 相对路径，让 LLM 用 read_memory 直接拿全文。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readMarkdownFile } from '../fs/frontmatter';
import { compressPath } from './compressedPath';
import {
  agentArchivedEpisodesDir,
  agentEpisodesDir,
  agentSelfPath,
  memoryRoot,
  projectArchivedEpisodesDir,
  projectEpisodesDir,
  projectProfilePath,
  userProfilePath,
} from './paths';
import { parseProfileDoc, type ProfileDoc } from '@shared/memory/profileDoc';
import { readAllProjectListEntries } from './projectList';

/** 每段预算（汉字） */
export const SNAPSHOT_BUDGET = {
  agentProfile: 1500,
  userProfile: 2500,
  projectProfile: 1500,
  projectList: 500,
} as const;

/**
 * 档案篇幅硬上限 = 软预算（注入预算）× 此倍数（S35·G35）。
 * 软预算是「每轮朝它精简」的目标（dream 整篇重写的靶子），硬上限是「宽松的最终兜底」——
 * 超软预算不是错误态、是下次整理的输入信号；超硬上限才拦写，防单次巨量写入撑爆。
 */
export const PROFILE_HARD_LIMIT_MULTIPLIER = 2;

/**
 * 某档案路径的写入侧篇幅预算（汉字）：soft=注入/精简目标，hard=拦写硬上限。
 * 非档案路径（episode 等，不带篇幅预算）返回 null。写读同一套数值、单源在此。
 */
export function profileBudgetForPath(relPath: string): { soft: number; hard: number } | null {
  const norm = relPath.replace(/\\/g, '/');
  if (norm.includes('/episodes/')) return null;
  let soft: number | null = null;
  if (norm.endsWith('/self.md')) soft = SNAPSHOT_BUDGET.agentProfile;
  else if (norm === 'user/profile.md') soft = SNAPSHOT_BUDGET.userProfile;
  else if (norm.startsWith('projects/') && norm.endsWith('/profile.md')) soft = SNAPSHOT_BUDGET.projectProfile;
  if (soft === null) return null;
  return { soft, hard: soft * PROFILE_HARD_LIMIT_MULTIPLIER };
}

/**
 * Episode type 枚举（跟 frontmatter.type 字段值一致）。
 * 导出供 applyOps 写入校验复用——`shared/types.ts` 的 `EpisodeType` 只是编译期类型，
 * 运行时校验拿不到值，所以运行时唯一真相源在这里。
 */
export const EPISODE_TYPES = ['user', 'feedback', 'project', 'reference', 'agent'] as const;
type EpisodeType = typeof EPISODE_TYPES[number];

/**
 * 坏数据的确定性规则修正表（决策 2 第 3 层）——已知错法 → 正确分类，不动用模型。
 * 只覆盖"概念明确对应"的错：种类词 / 拼写 / 同义。新错法落到 normalizeEpisodeType 的 null 兜底。
 */
const TYPE_ALIAS: Record<string, EpisodeType> = {
  persona: 'agent', // record_memory 的"记忆种类"词，被误填进五分类
  self: 'agent',
  fact: 'user', // fact 种类词 ≈ 关于用户
  preference: 'user',
  pref: 'user',
  ref: 'reference',
  references: 'reference',
};

/**
 * 把 frontmatter.type 的原始值归一到合法 EpisodeType。
 * - 已是合法值（含大小写差异）→ 返回它
 * - 种类词 `episode` 串进来 → 按 scope 缩小：project scope→'project'，否则 'agent'
 * - 命中别名表 → 修正
 * - 都不行 → type=null（调用方决定拒绝 / 兜底保留）
 *
 * @param scope 'agent' | 'project'（仅 'episode' 误填时用来缩小范围）
 */
export function normalizeEpisodeType(
  raw: unknown,
  scope?: 'agent' | 'project',
): { type: EpisodeType | null; corrected: boolean } {
  if (typeof raw !== 'string') return { type: null, corrected: false };
  const lower = raw.trim().toLowerCase();
  if ((EPISODE_TYPES as readonly string[]).includes(lower)) {
    return { type: lower as EpisodeType, corrected: lower !== raw };
  }
  if (lower === 'episode') {
    return { type: scope === 'project' ? 'project' : 'agent', corrected: true };
  }
  if (TYPE_ALIAS[lower]) return { type: TYPE_ALIAS[lower], corrected: true };
  return { type: null, corrected: false };
}

export type EpisodeFile = {
  compressedPath: string;
  title: string;
  description: string;
  type: EpisodeType;
  tags: string[];
  updated: string; // ISO date
  status: string;
};

// ─── 主入口 ────────────────────────────────────────────────

export async function buildSnapshot(
  ownerId: string,
  currentProjectId: string | null = null,
): Promise<string> {
  const [agentProfile, userProfileText, projectProfileText, projectListText] =
    await Promise.all([
      readAgentProfileSection(ownerId),
      readUserProfileSection(ownerId),
      currentProjectId ? readProjectProfileSection(ownerId, currentProjectId) : '',
      readProjectListSection(ownerId),
    ]);

  const parts: string[] = [];
  if (agentProfile) {
    parts.push(section('Twin 自己（agents/twin/self.md）', agentProfile, SNAPSHOT_BUDGET.agentProfile));
  }
  if (userProfileText) {
    parts.push(section('关于你（user/profile.md）', userProfileText, SNAPSHOT_BUDGET.userProfile));
  }
  if (projectListText) {
    parts.push(section('项目列表（projects/*/list-entry.md）', projectListText, SNAPSHOT_BUDGET.projectList));
  }
  if (projectProfileText && currentProjectId) {
    parts.push(section(
      `当前项目 ${currentProjectId}（projects/${currentProjectId}/profile.md）`,
      projectProfileText,
      SNAPSHOT_BUDGET.projectProfile,
    ));
  }
  // 不再常驻全量事件索引（PRD §5.2）：相关往事由召回器按需注入全文、「还有哪些可挖」由召回器
  // 附的轻量线索给（hint）；主模型保留 grep_memory / read_memory 自己深挖。
  if (parts.length === 0) return '';
  // 顶层 ## 与第一层各节同级：内部子节早已压到 ###，顶层不越级
  return ['## 记忆系统注入', '', ...parts].join('\n').trim();
}

/** 总预算（用于测试） */
export const SNAPSHOT_TOTAL_BUDGET = Object.values(SNAPSHOT_BUDGET).reduce((a, b) => a + b, 0);

// ─── 各段读取 ──────────────────────────────────────────────

async function readAgentProfileSection(ownerId: string): Promise<string> {
  // self.md 与 user/项目同构走文档模型（§6）：parseProfileDoc → 印象 + ### 小节。直接塞 raw 会让 self 里的
  // `## 小节`（新 dream 守则鼓励的）与快照自身的 `## Twin 自己` 同级、打散 system prompt 标题层级。
  const f = await readMarkdownFile(agentSelfPath(ownerId));
  if (!f) return '';
  return renderProfileDocForInjection(parseProfileDoc(f.content));
}

async function readUserProfileSection(ownerId: string): Promise<string> {
  const f = await readMarkdownFile(userProfilePath(ownerId));
  if (!f) return '';
  return renderProfileDocForInjection(parseProfileDoc(f.content));
}

/**
 * 把自由分章档案渲染成注入文本：印象置顶，其后逐章节 `### {title}\n{body}`。
 * 任何小节都原样带上——这是从根上堵住「整理一次就抹掉用户手写小节」（PRD §5.5 / 文档模型 §5）。
 */
function renderProfileDocForInjection(doc: ProfileDoc): string {
  const out: string[] = [];
  if (doc.impression.trim()) out.push(doc.impression.trim());
  for (const s of doc.sections) {
    if (out.length > 0) out.push('');
    out.push(`### ${s.title}`);
    if (s.body.trim()) {
      out.push('');
      out.push(s.body.trim());
    }
  }
  return out.join('\n');
}

async function readProjectProfileSection(ownerId: string, projectId: string): Promise<string> {
  // 项目档案与 user/self 同构：读 raw → parseProfileDoc → 印象 + 各 ## 小节（基本信息/约定/进度
  // 都只是普通小节）。任何小节原样带上、不丢——和用户档案同一防压扁纪律。
  const f = await readMarkdownFile(projectProfilePath(ownerId, projectId));
  if (!f) return '';
  return renderProfileDocForInjection(parseProfileDoc(f.content));
}

async function readProjectListSection(ownerId: string): Promise<string> {
  const entries = await readAllProjectListEntries(ownerId);
  if (entries.length === 0) return '';
  return entries.map((e) => `- ${e.projectId} — ${e.intro.replace(/\n+/g, ' ').trim()}`).join('\n');
}

// ─── Episode 扫描 ─────────────────────────────────────────

export async function scanAllActiveEpisodes(ownerId: string): Promise<EpisodeFile[]> {
  const out: EpisodeFile[] = [];
  await forEachEpisodeFile(ownerId, async (abs) => {
    const ep = await loadEpisodeMeta(ownerId, abs);
    if (ep && ep.status === 'active') out.push(ep);
  });
  return out;
}

/**
 * 遍历所有 active 目录下的 episode 文件（不含 archived），对每个 .md 绝对路径调 visit。
 * scanAllActiveEpisodes / listInvalidEpisodes 共用同一套目录遍历——同问题同模式。
 */
async function forEachEpisodeFile(
  ownerId: string,
  visit: (absPath: string) => Promise<void>,
): Promise<void> {
  await walkScope(join(memoryRoot(ownerId), 'agents'), ownerId, false, visit);
  await walkScope(join(memoryRoot(ownerId), 'projects'), ownerId, true, visit);
}

async function walkScope(
  rootDir: string,
  ownerId: string,
  underProjects: boolean,
  visit: (absPath: string) => Promise<void>,
): Promise<void> {
  let scopeDirs: import('node:fs').Dirent[];
  try {
    scopeDirs = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const scope of scopeDirs) {
    if (!scope.isDirectory()) continue;
    const epDir = underProjects
      ? projectEpisodesDir(ownerId, scope.name)
      : agentEpisodesDir(ownerId, scope.name);
    let files: string[];
    try {
      files = await fs.readdir(epDir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.md')) continue;
      await visit(join(epDir, name));
    }
    // archived 不进默认 index
    void (underProjects
      ? projectArchivedEpisodesDir(ownerId, scope.name)
      : agentArchivedEpisodesDir(ownerId, scope.name));
  }
}

/** 一条分类非法、规则也修不了的 episode（"体检"清单项——可被发现、不静默丢） */
export type InvalidEpisode = { relPath: string; rawType: string; status: string };

/**
 * 列出分类非法且 normalizeEpisodeType 修不了的 episode（决策 2 兜底配套）。
 * loadEpisodeMeta 对这些 return null（不进 index、不污染召回）；这里让它们"可被发现"，
 * 留待下次 dream 或人工收拾——满足"不静默消失"。
 */
export async function listInvalidEpisodes(ownerId: string): Promise<InvalidEpisode[]> {
  const out: InvalidEpisode[] = [];
  const root = memoryRoot(ownerId);
  await forEachEpisodeFile(ownerId, async (abs) => {
    const f = await readMarkdownFile(abs);
    if (!f) return;
    const rawType = f.data.type;
    if (!rawType) return; // 缺 type / 空串 = v1 未迁移，不算"非法"（与 loadEpisodeMeta 的 !fmType 判断一致）
    const scope = scopeOfEpisode(f.data, abs, root);
    if (normalizeEpisodeType(rawType, scope).type === null) {
      out.push({
        relPath: abs.slice(root.length + 1),
        rawType: String(rawType),
        status: (f.data.status as string) ?? 'active',
      });
    }
  });
  return out;
}

/** 从 frontmatter.scope 或路径推断 episode 属于 agent 还是 project（给 normalize 缩小 'episode' 范围用） */
function scopeOfEpisode(
  data: Record<string, unknown>,
  absPath: string,
  root: string,
): 'agent' | 'project' {
  const fmScope = typeof data.scope === 'string' ? data.scope : '';
  if (fmScope.startsWith('project')) return 'project';
  if (fmScope === 'agent') return 'agent';
  return absPath.slice(root.length + 1).startsWith('projects/') ? 'project' : 'agent';
}

async function loadEpisodeMeta(ownerId: string, absPath: string): Promise<EpisodeFile | null> {
  const f = await readMarkdownFile(absPath);
  if (!f) return null;
  const data = f.data;
  // v2 frontmatter 有 type / description / updated；v1 缺这些
  const fmType = data.type as string | undefined;
  if (!fmType) return null; // v1 episode 未迁移，跳过
  // 决策 2 读取侧：能用别名表修就修（进 index、分类正确）；修不了不塞进真实类污染召回，
  // return null + warn，由 listInvalidEpisodes 让它"可被发现"。
  const root = memoryRoot(ownerId);
  const scope = scopeOfEpisode(data, absPath, root);
  const norm = normalizeEpisodeType(fmType, scope);
  if (!norm.type) {
    console.warn(`[oru.memory] episode 分类非法，跳过召回（listInvalidEpisodes 可查）：type="${fmType}" @ ${absPath.slice(root.length + 1)}`);
    return null;
  }
  const status = (data.status as string) ?? 'active';
  const rel = absPath.slice(root.length + 1);
  let compressed: string;
  try {
    compressed = compressPath(rel);
  } catch {
    return null;
  }
  return {
    compressedPath: compressed,
    title: (data.title as string) ?? '',
    description: (data.description as string) ?? '',
    type: norm.type,
    tags: (data.tags as string[]) ?? [],
    updated: (data.updated as string) ?? (data.created as string) ?? '',
    status,
  };
}

// ─── Helpers ──────────────────────────────────────────────

function section(title: string, body: string, budget: number): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return `## ${title}\n\n${truncate(trimmed, budget)}\n`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

// 测试导出
export {
  scanAllActiveEpisodes as __scanAllActiveEpisodes,
  loadEpisodeMeta as __loadEpisodeMeta,
};
