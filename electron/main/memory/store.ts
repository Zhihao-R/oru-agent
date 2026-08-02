/**
 * 记忆系统数据层 — long-form / events / 索引 的统一 CRUD
 *
 * 设计原则：
 * - 所有写入必须经过这一层，**绝对不让其它模块直接 fs.writeFile** 记忆文件
 * - 写 MEMORY.md 索引时加文件锁（防止 A/B 路径同步写 + dream 异步写并发踩踏）
 * - 单条事件的 frontmatter 字段定义见本文件的 EpisodeFrontmatter 类型
 * - long-form 文件 frontmatter 极简（last-updated / last-updated-by-dream），
 *   正文是用户/dream 维护的 markdown
 */
import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { withFileLock } from '../fs/withFileLock';
import { safeWrite } from '../fs/safeWrite';
import { activeEpisodeRel, archivedEpisodeRel } from './compressedPath';
import type { EpisodeStatus } from '@shared/types';
import {
  type Frontmatter,
  ensureWithinRoot,
  readMarkdownFile,
  writeMarkdownFile,
} from '../fs/frontmatter';
import {
  agentEpisodesDir,
  agentSelfPath,
  memoryIndexPath,
  memoryRoot,
  personalFactsPath,
  personalPreferencesPath,
  projectEpisodesDir,
  DEFAULT_AGENT_NAME,
} from './paths';

// ─── 类型 ─────────────────────────────────────────────────

/** 事件 frontmatter（一条事件 = 一份文件） */
export type EpisodeFrontmatter = {
  scope: string; // 'agent' | `project:${id}`
  type: 'episode';
  tags?: string[];
  status: EpisodeStatus;
  created: string; // ISO date
  source: 'user-direct' | 'twin-auto' | string; // dream-<date> 等
  sources?: string[]; // 来源对话 id 列表（capture 落 sources:[convId]）
  'superseded-by'?: string; // 相对 memoryRoot 的路径
  'superseded-at'?: string;
  'retired-at'?: string;
  'retired-reason'?: string;
  'corrected-at'?: string;
};

/** 一条事件 */
export type Episode = {
  /** 相对 memoryRoot 的路径，如 'agents/twin/episodes/2026-04-30-foo.md' */
  relPath: string;
  frontmatter: EpisodeFrontmatter;
  body: string;
};

/** 一条索引条目（写到 MEMORY.md） */
export type IndexEntry = {
  relPath: string;
  title: string;
  scope: string;
  tags: string[];
};

// ─── long-form 读写 ────────────────────────────────────────

/**
 * 读 long-form 文件。文件不存在返回 null。
 */
export async function readLongForm(absPath: string): Promise<string | null> {
  const f = await readMarkdownFile(absPath);
  return f ? f.content : null;
}

/** 读 personal/facts.md */
export async function readPersonalFacts(ownerId: string): Promise<string> {
  return (await readLongForm(personalFactsPath(ownerId))) ?? '';
}

/** 读 personal/preferences.md */
export async function readPersonalPreferences(ownerId: string): Promise<string> {
  return (await readLongForm(personalPreferencesPath(ownerId))) ?? '';
}

/** 读 agents/<name>/self.md */
export async function readAgentSelf(
  ownerId: string,
  agentName: string = DEFAULT_AGENT_NAME,
): Promise<string> {
  return (await readLongForm(agentSelfPath(ownerId, agentName))) ?? '';
}

// ─── 事件（episodes） ───────────────────────────────────────

/**
 * 写一条事件。slug 用作文件名（前面加日期前缀）。
 *
 * v2 调用方（applyCreateEpisode）会在 frontmatter 里传五类 type
 * （user/feedback/project/reference/agent）+ description + title + updated。
 * v1 调用方不传 type 时，写 'episode' 当兜底——后续会被当作 v1 episode 跳过 v2 index。
 *
 * @returns 该事件的相对路径（用于索引）
 */
export async function writeEpisode(args: {
  ownerId: string;
  scopeName: 'agent' | 'project';
  scopeId: string;
  slug: string;
  /**
   * frontmatter 任意键值，会被写到 markdown 文件头部。
   * type 字段如果传，会保留传入值（v2 五类）；不传则兜底 'episode'。
   */
  frontmatter: Frontmatter;
  body: string;
}): Promise<string> {
  const { ownerId, scopeName, scopeId, slug, frontmatter, body } = args;
  const createdRaw = (frontmatter as { created?: string }).created;
  const date = (createdRaw ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const fileName = `${date}-${slug}.md`;
  const dir = scopeName === 'agent'
    ? agentEpisodesDir(ownerId, scopeId)
    : projectEpisodesDir(ownerId, scopeId);
  const absPath = join(dir, fileName);
  ensureWithinRoot(memoryRoot(ownerId), absPath);
  const data: Frontmatter = {
    type: 'episode', // v1 兜底；frontmatter.type 会覆盖
    ...frontmatter,
    created: date,
  };
  await writeMarkdownFile(absPath, data, body);
  const relPath = relative(memoryRoot(ownerId), absPath);
  return relPath;
}

/**
 * 把一条 episode 从活跃目录物理移入同级 archived/ 子目录（标记即移入，S35·G37）。
 * 归档只是移出自动召回、工具仍搜得到（不是删除），可逆（搜得回）所以即时——无须等 90 天定时。
 * 幂等：已在 archived/ 下（archivedEpisodeRel 返回 null）就不动。移动失败静默——status 才是召回权威，
 * 物理位置是优化不是正确性。/episodes/archived/ 路径规则单源在 compressedPath.archivedEpisodeRel。
 */
async function relocateToArchived(ownerId: string, rel: string): Promise<void> {
  const archRel = archivedEpisodeRel(rel);
  if (!archRel) return; // 已归档 / 非 episode 路径，幂等
  const root = memoryRoot(ownerId);
  const dest = join(root, archRel);
  try {
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.rename(join(root, rel), dest);
  } catch {
    /* 移动失败静默：status 已生效，物理位置由存量兜底 archiver 补 */
  }
}

/**
 * 把一条事件标为 superseded（A/B 路径冲突处理时用）。
 * - frontmatter.status 改为 'superseded'
 * - 加 superseded-by（新事件 relPath）和 superseded-at
 * - 从 MEMORY.md 索引里删掉（superseded 不进 active 召回）
 * - 标记即物理移入 archived/（S35·G37）：expandPath 解压缩会回落 archived，路径可达性不变
 *
 * 找不到旧文件就静默——幂等。
 */
export async function markEpisodeSuperseded(
  ownerId: string,
  oldRelPath: string,
  newRelPath: string,
): Promise<{ ok: boolean }> {
  const root = memoryRoot(ownerId);
  let absOld: string;
  try {
    absOld = ensureWithinRoot(root, oldRelPath);
  } catch {
    return { ok: false };
  }
  const f = await readMarkdownFile(absOld);
  if (!f) return { ok: false };
  const data: Frontmatter = {
    ...f.data,
    status: 'superseded',
    'superseded-by': newRelPath,
    'superseded-at': new Date().toISOString().slice(0, 10),
  };
  await writeMarkdownFile(absOld, data, f.content);
  await removeIndexEntry(ownerId, oldRelPath).catch(() => {});
  await relocateToArchived(ownerId, oldRelPath);
  return { ok: true };
}

/**
 * 把一条事件标为 retired（按守则出清）。
 * - status 改 'retired'，记 retired-at / retired-reason
 * - 从 MEMORY.md 索引删掉（不进活跃召回）
 * - 标记即物理移入 archived/（S35·G37）：可逆标记（恢复 = status 回 active + 移回 + 索引回填），
 *   归档只移出自动召回、工具仍搜得到，故即时无须等定时
 */
export async function markEpisodeRetired(
  ownerId: string,
  relPath: string,
  reason: string,
): Promise<{ ok: boolean }> {
  const root = memoryRoot(ownerId);
  let abs: string;
  try {
    abs = ensureWithinRoot(root, relPath);
  } catch {
    return { ok: false };
  }
  const f = await readMarkdownFile(abs);
  if (!f) return { ok: false };
  const data: Frontmatter = {
    ...f.data,
    status: 'retired',
    'retired-at': new Date().toISOString().slice(0, 10),
    'retired-reason': reason,
  };
  await writeMarkdownFile(abs, data, f.content);
  await removeIndexEntry(ownerId, relPath).catch(() => {});
  await relocateToArchived(ownerId, relPath);
  return { ok: true };
}

/**
 * long-form 文件里把匹配 conflictsWith 文本的"活跃行"加删除线 + (superseded YYYY-MM-DD) 后缀。
 * 用于 evolution 语义（认知演化）——保留时间线。
 *
 * - 只匹配第一行未被划掉的（不含 ~~ 标记）
 * - bullet 行（- xxx）会改成 - ~~xxx~~ （superseded ...）
 * - 非 bullet 行原样包 ~~ ~~
 * - 用文本子串匹配，区分大小写
 *
 * 返回 { content, matched } —— matched=false 时 content 不变。
 */
export function applyConflictStrikethrough(
  existing: string,
  conflictsWith: string,
  today: string = new Date().toISOString().slice(0, 10),
): { content: string; matched: boolean } {
  const lines = existing.split('\n');
  let matched = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (matched) break;
    if (!line.includes(conflictsWith)) continue;
    if (line.includes('~~')) continue; // 已经划掉的跳过
    // bullet 行：- xxx → - ~~xxx~~ （superseded YYYY-MM-DD）
    const bulletMatch = /^(\s*-\s+)(.+)$/.exec(line);
    if (bulletMatch) {
      lines[i] = `${bulletMatch[1]}~~${bulletMatch[2]}~~ （superseded ${today}）`;
    } else {
      lines[i] = `~~${line}~~ （superseded ${today}）`;
    }
    matched = true;
  }
  return { content: lines.join('\n'), matched };
}

/**
 * long-form 文件里**真删除**第一条匹配 conflictsWith 文本的行。
 * 用于 correction 语义（错记纠正）——内容从未真实发生，没必要留时间线。
 *
 * 跟 strikethrough 的区别：删而不是划线。
 *
 * 返回 { content, matched }。
 */
export function applyConflictDeletion(
  existing: string,
  conflictsWith: string,
): { content: string; matched: boolean } {
  const lines = existing.split('\n');
  const idx = lines.findIndex((l) => l.includes(conflictsWith) && !l.includes('~~'));
  if (idx < 0) return { content: existing, matched: false };
  lines.splice(idx, 1);
  return { content: lines.join('\n'), matched: true };
}

/**
 * 读一条事件。按给定路径读不到时，回落到 archived 兄弟路径（S35·G37：取代/退休即移入 archived，
 * 按活跃路径来读的调用方透明命中已归档条目）。返回的 relPath 是实际命中的路径。
 */
export async function readEpisode(
  ownerId: string,
  relPath: string,
): Promise<Episode | null> {
  const root = memoryRoot(ownerId);
  let effectiveRel = relPath;
  let f = await readMarkdownFile(ensureWithinRoot(root, relPath));
  if (!f) {
    const arch = archivedEpisodeRel(relPath);
    if (arch) {
      f = await readMarkdownFile(ensureWithinRoot(root, arch));
      if (f) effectiveRel = arch;
    }
  }
  if (!f) return null;
  return {
    relPath: effectiveRel,
    frontmatter: f.data as EpisodeFrontmatter,
    body: f.content,
  };
}

/** 列出某 scope 下所有事件文件路径（相对 memoryRoot） */
export async function listEpisodes(
  ownerId: string,
  scopeName: 'agent' | 'project',
  scopeId: string,
): Promise<string[]> {
  const dir = scopeName === 'agent'
    ? agentEpisodesDir(ownerId, scopeId)
    : projectEpisodesDir(ownerId, scopeId);
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((n) => n.endsWith('.md'))
      .map((n) => relative(memoryRoot(ownerId), join(dir, n)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * 列出所有 agent/twin/episodes 和 projects/*\/episodes 下的事件，
 * 含 superseded（可选）。每条带 frontmatter 摘要 + mtime。
 *
 * 用于"含历史"开关——读 MEMORY.md 索引只能拿到 active；要看 superseded 必须扫文件系统。
 */
export type EpisodeSummary = {
  relPath: string;
  title: string;
  scope: string;
  tags: string[];
  status: EpisodeStatus;
  mtime: number;
  /** v2: episode 类别（五类）；老文件可能没有，回退 'agent' */
  type: string;
  /** v2: 一句话描述；老文件可能没有，空串 */
  description: string;
  /** v2: 从 frontmatter.created 取（YYYY-MM-DD）；fallback 文件名前缀 */
  date: string;
  /** 'user-direct' = 用户明确要求记住 */
  source?: string;
  /** 来源对话 id 列表（capture 落 sources:[convId]）；笔记详情「查看原文 ›」用 */
  sources?: string[];
  /** dream 纠错产物的校对日期 */
  correctedAt?: string;
  /** status=retired 时的淘汰判据 */
  retiredReason?: string;
};

export async function listAllEpisodesWithSuperseded(
  ownerId: string,
  includeSuperseded: boolean,
): Promise<EpisodeSummary[]> {
  const root = memoryRoot(ownerId);
  const entriesFromIndex = await readIndex(ownerId);
  // 索引里的就是 active（按定义）
  const out: EpisodeSummary[] = [];
  const seen = new Set<string>();

  for (const e of entriesFromIndex) {
    const abs = join(root, e.relPath);
    let mtime = 0;
    try {
      mtime = (await fs.stat(abs)).mtimeMs;
    } catch {
      continue; // 索引指向的文件不在了，跳过
    }
    // 读 frontmatter 拿 v2 字段
    const fm = (await readMarkdownFile(abs))?.data ?? {};
    out.push({
      relPath: e.relPath,
      title: e.title || (fm.title as string) || '',
      scope: e.scope,
      tags: e.tags,
      status: 'active',
      mtime,
      type: (fm.type as string) ?? 'agent',
      description: (fm.description as string) ?? '',
      date: (fm.created as string) ?? dateFromName(e.relPath),
      source: fm.source as string | undefined,
      sources: Array.isArray(fm.sources) ? (fm.sources as string[]) : undefined,
      correctedAt: fm['corrected-at'] as string | undefined,
    });
    seen.add(e.relPath);
  }

  if (!includeSuperseded) return out;

  // 扫两类目录寻找索引外的事件：<scope>/episodes 及其 archived/ 子目录——
  // 标记 superseded/retired 即物理移入 archived（S35·G37），「含历史」视图必须连 archived 一起扫，
  // 否则移档后的旧条在历史里彻底不可见。
  const candidateRoots: string[] = [];
  const pushScopeEpisodeDirs = async (scopeRoot: string): Promise<void> => {
    let subs: import('node:fs').Dirent[];
    try {
      subs = await fs.readdir(scopeRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      candidateRoots.push(join(scopeRoot, s.name, 'episodes'));
      candidateRoots.push(join(scopeRoot, s.name, 'episodes', 'archived'));
    }
  };
  await pushScopeEpisodeDirs(join(root, 'agents'));
  await pushScopeEpisodeDirs(join(root, 'projects'));

  for (const dir of candidateRoots) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (seen.has(rel)) continue;
      // 索引里没有的——读 frontmatter
      const f = await readMarkdownFile(abs);
      if (!f) continue;
      const fm = f.data as EpisodeFrontmatter;
      const status = (fm.status ?? 'active') as EpisodeStatus;
      // 只回 superseded / archived（active 应该已经在 index 里出现）
      if (status === 'active') continue;
      let mtime = 0;
      try {
        mtime = (await fs.stat(abs)).mtimeMs;
      } catch {
        // ignore
      }
      // title 取文件名 slug 部分作为兜底（YYYY-MM-DD-slug.md → slug）
      const titleFromName = name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
      out.push({
        relPath: rel,
        title: (fm as { title?: string }).title ?? titleFromName,
        scope: fm.scope ?? 'unknown',
        tags: fm.tags ?? [],
        status,
        mtime,
        type: (fm as { type?: string }).type ?? 'agent',
        description: (fm as { description?: string }).description ?? '',
        date: (fm as { created?: string }).created ?? dateFromName(rel),
        source: fm.source,
        sources: Array.isArray(fm.sources) ? (fm.sources as string[]) : undefined,
        correctedAt: fm['corrected-at'],
        retiredReason: fm['retired-reason'],
      });
    }
  }
  return out;
}

/** 从文件名拿 YYYY-MM-DD（兜底，frontmatter.created 缺失时用） */
function dateFromName(relPath: string): string {
  const name = relPath.split('/').pop() ?? '';
  const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/**
 * 找一条被 `targetRelPath` 取代的老 episode（即 frontmatter.superseded-by === targetRelPath）。
 *
 * 用于演化反查："给定当前 active 的 episode，找它取代的前一版"。
 *
 * 扫 agents/<name>/episodes + projects/<id>/episodes 全集（含 archived 子目录）。
 * v0.2 量级 (< 100) 扫描代价毫秒级；trigger 1000+ 或单次 50ms 时建反向 map。
 */
export async function readPredecessor(
  ownerId: string,
  targetRelPath: string,
): Promise<Episode | null> {
  const root = memoryRoot(ownerId);
  const dirs: string[] = [];
  // agents/<name>/episodes 和 archived
  const agentsRoot = join(root, 'agents');
  try {
    const subs = await fs.readdir(agentsRoot, { withFileTypes: true });
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      dirs.push(join(agentsRoot, s.name, 'episodes'));
      dirs.push(join(agentsRoot, s.name, 'episodes', 'archived'));
    }
  } catch { /* 无 agents 目录 */ }
  // projects/<id>/episodes 和 archived
  const projectsRoot = join(root, 'projects');
  try {
    const subs = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      dirs.push(join(projectsRoot, s.name, 'episodes'));
      dirs.push(join(projectsRoot, s.name, 'episodes', 'archived'));
    }
  } catch { /* 无 projects 目录 */ }

  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const abs = join(dir, name);
      const f = await readMarkdownFile(abs);
      if (!f) continue;
      const fm = f.data as EpisodeFrontmatter;
      // 按身份路径比较：superseded-by 存的是取代方当时的活跃路径，取代方后来也可能移入 archived
      // （S35·G37）——两边都归一到活跃形态再比，避免 archived 移动后链断。
      const supersededBy = fm['superseded-by'];
      if (supersededBy && activeEpisodeRel(supersededBy) === activeEpisodeRel(targetRelPath)) {
        return { relPath: relative(root, abs), frontmatter: fm, body: f.content };
      }
    }
  }
  return null;
}

// ─── MEMORY.md 索引 ─────────────────────────────────────────

// 索引是 capture/dream/record 共写的热点文件，重试预算需容纳突发竞争
const INDEX_LOCK_RETRIES = { retries: 10, minTimeout: 50, maxTimeout: 400 };

/** 持索引文件锁跑 fn——upsert/remove 的 read-modify-write 整块持锁，防并发丢条目。 */
function withIndexLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(memoryIndexPath(ownerId), fn, INDEX_LOCK_RETRIES);
}

/** 无锁写整个索引——仅供已持索引锁的调用方用。原子落盘（safeWrite：tmp→rename，含 mkdir），防崩溃截断。 */
function writeIndexBody(ownerId: string, entries: IndexEntry[]): void {
  safeWrite(memoryIndexPath(ownerId), renderIndexBody(entries), 'LF');
}

/**
 * 重写整个索引文件。entries 由调用方组织好。
 * 加文件锁，防止 A/B 路径 + dream 并发写。
 */
export async function writeIndex(ownerId: string, entries: IndexEntry[]): Promise<void> {
  await withIndexLock(ownerId, async () => writeIndexBody(ownerId, entries));
}

/** 读索引（如果不存在返回空数组） */
export async function readIndex(ownerId: string): Promise<IndexEntry[]> {
  const path = memoryIndexPath(ownerId);
  try {
    const text = await fs.readFile(path, 'utf-8');
    return parseIndexBody(text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * 索引正文渲染：分组按 scope，每组列条目
 *
 * # Oru 事件索引
 *
 * ## scope:agent
 * - [title](relPath) — tags:[a,b]
 * ...
 */
function renderIndexBody(entries: IndexEntry[]): string {
  if (entries.length === 0) return '# Oru 事件索引\n\n_(暂无事件)_\n';
  const byScope = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const arr = byScope.get(e.scope) ?? [];
    arr.push(e);
    byScope.set(e.scope, arr);
  }
  const lines: string[] = ['# Oru 事件索引', ''];
  for (const [scope, items] of byScope) {
    lines.push(`## ${scope}`);
    for (const it of items) {
      const tagsPart = it.tags.length > 0 ? ` — tags:[${it.tags.join(',')}]` : '';
      lines.push(`- [${it.title}](${it.relPath})${tagsPart}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 解析索引正文。容忍非标准格式（缺 tags 等），尽量恢复 entries。
 * 不要求严格往返同构——MEMORY.md 主要给 LLM 看，人类编辑时格式可能微调。
 */
function parseIndexBody(text: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  let currentScope = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('## ')) {
      currentScope = line.slice(3).trim();
      continue;
    }
    if (!line.startsWith('- [')) continue;
    // - [title](relPath) — tags:[a,b]
    const m = /^-\s+\[(.+?)\]\(([^)]+)\)(?:\s+—\s+tags:\[([^\]]*)\])?/.exec(line);
    if (!m) continue;
    const [, title, relPath, tagsStr] = m;
    const tags = tagsStr
      ? tagsStr
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    out.push({ title, relPath, scope: currentScope, tags });
  }
  return out;
}

// ─── 索引附加 / 删除 helper ────────────────────────────────

/** 加一条索引（已有同 relPath 的会被覆盖）——整块 RMW 持锁，防并发丢条目 */
export async function upsertIndexEntry(ownerId: string, entry: IndexEntry): Promise<void> {
  await withIndexLock(ownerId, async () => {
    const entries = await readIndex(ownerId);
    const idx = entries.findIndex((e) => e.relPath === entry.relPath);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    writeIndexBody(ownerId, entries);
  });
}

/** 删一条索引——整块 RMW 持锁，防并发丢条目 */
export async function removeIndexEntry(ownerId: string, relPath: string): Promise<void> {
  await withIndexLock(ownerId, async () => {
    const entries = await readIndex(ownerId);
    const filtered = entries.filter((e) => e.relPath !== relPath);
    if (filtered.length === entries.length) return;
    writeIndexBody(ownerId, filtered);
  });
}
