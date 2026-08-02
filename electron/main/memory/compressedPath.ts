/**
 * 压缩 path 编解码
 *
 * 完整 relPath ↔ 压缩 path：
 *   agents/twin/episodes/2026-05-10-foo.md         ↔ twin/2026-05-10-foo
 *   agents/twin/episodes/archived/2026-01-01-x.md  ↔ twin/2026-01-01-x  (archived 不在压缩 path 体现)
 *   projects/oru/episodes/2026-05-10-bar.md        ↔ oru/2026-05-10-bar
 *   projects/oru/episodes/archived/2026-01-01-y.md ↔ oru/2026-01-01-y
 *
 * 解码方向（expandPath）：先找 active 路径下的文件，找不到再 fallback archived/。
 *
 * 假定：同 scope 下 `<date>-<slug>` 全局唯一（active + archived 不撞）。
 */
import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import {
  DEFAULT_AGENT_NAME,
  agentArchivedEpisodesDir,
  agentEpisodesDir,
  memoryRoot,
  projectArchivedEpisodesDir,
  projectEpisodesDir,
} from './paths';

/**
 * 识别用户传入的 path 形态：完整 relPath（含 .md）vs 压缩 episode 路径。
 *
 * 不验证文件存在、不抛错——只做语法层判别，把"找不到怎么办"留给调用方。
 * 两处调用方（applyOps.resolveOldEpisodePath / tools.resolveReadPath）共用此 helper。
 */
export type PathKind = 'full' | 'compressed';

export function classifyPathInput(input: string): { kind: PathKind; input: string } {
  const trimmed = input.trim();
  const isFullPath = trimmed.endsWith('.md') || trimmed.includes('.md/');
  return { kind: isFullPath ? 'full' : 'compressed', input: trimmed };
}

/**
 * 把用户输入（full relPath 或 compressed）归一到完整相对路径。
 *
 * @param verifyExists 仅 full 路径用：true 则 fs.access 验文件存在，不存在返回 null。
 *                     compressed 总是走 expandPath（它内部会验存在），失败返回 null。
 * @returns 归一后的完整 relPath；input 为空、compressed expand 失败、或 verifyExists 时文件不存在 → null。
 */
export async function resolveToFullRelPath(
  ownerId: string,
  input: string,
  verifyExists = false,
): Promise<string | null> {
  const { kind, input: trimmed } = classifyPathInput(input);
  if (trimmed.length === 0) return null;
  if (kind === 'full') {
    if (!verifyExists) return trimmed;
    const root = memoryRoot(ownerId);
    // 先按原样验；不在再回落 archived 兄弟路径——取代/退休即移入 archived（S35·G37），
    // 调用方（如 record_memory 的 conflictsWith）可能仍持旧活跃路径，与 readEpisode 回落同规。
    for (const cand of [trimmed, archivedEpisodeRel(trimmed)]) {
      if (!cand) continue;
      try {
        await fs.access(join(root, cand));
        return cand;
      } catch {
        /* 试下一个候选 */
      }
    }
    return null;
  }
  return await expandPath(ownerId, trimmed).catch(() => null);
}

/**
 * episode 活跃路径 → 同级 archived/ 兄弟路径（标记即移入的目的地，S35·G37）。
 * 已是 archived / 非 episode 路径返回 null。纯字符串变换、不碰盘。
 */
export function archivedEpisodeRel(relPath: string): string | null {
  const norm = relPath.split(sep).join('/');
  if (!norm.includes('/episodes/') || norm.includes('/episodes/archived/')) return null;
  return norm.replace(/\/episodes\/([^/]+)$/, '/episodes/archived/$1');
}

/**
 * episode 的「身份路径」：archived 与活跃视作同一条（去掉 /episodes/archived/ 的 archived 段）。
 * 用于跨 active↔archived 的相等比较（如 superseded-by 反查）——一条 episode 移入 archived 不改其身份。
 */
export function activeEpisodeRel(relPath: string): string {
  return relPath.split(sep).join('/').replace('/episodes/archived/', '/episodes/');
}

/** 完整 relPath（相对 memoryRoot）→ 压缩 path。同步纯函数。 */
export function compressPath(relPath: string): string {
  // 标准化分隔符
  const norm = relPath.split(sep).join('/');
  // agents/<scope>/episodes/[archived/]<file>.md
  let m = /^agents\/([^/]+)\/episodes\/(?:archived\/)?(.+)\.md$/.exec(norm);
  if (m) return `${m[1]}/${m[2]}`;
  // projects/<scope>/episodes/[archived/]<file>.md
  m = /^projects\/([^/]+)\/episodes\/(?:archived\/)?(.+)\.md$/.exec(norm);
  if (m) return `${m[1]}/${m[2]}`;
  // 兜底：传进来就不是 episode 路径——抛
  throw new Error(`compressPath: not an episode path: ${relPath}`);
}

/**
 * 压缩 path → 完整 relPath。
 *
 * 解析规则：
 *   - 第一段是 scope：'twin' = agent scope (DEFAULT_AGENT_NAME)，其它视作 projectId
 *   - 剩余部分是 file slug（含日期前缀）
 *
 * 找文件：先 active，再 archived。都不在抛 ENOENT。
 */
export async function expandPath(ownerId: string, compressed: string): Promise<string> {
  const parsed = parseCompressed(compressed);
  const root = memoryRoot(ownerId);
  const candidates = candidatePaths(ownerId, parsed);
  for (const abs of candidates) {
    try {
      await fs.access(abs);
      // 返回相对 root 的路径
      return abs.slice(root.length + 1).split(sep).join('/');
    } catch {
      // continue
    }
  }
  const err: NodeJS.ErrnoException = new Error(`expandPath: not found: ${compressed}`);
  err.code = 'ENOENT';
  throw err;
}

/** 找不到时给候选建议（编辑距离前 N 个） */
export async function suggestSimilar(
  ownerId: string,
  compressed: string,
  topN = 3,
): Promise<string[]> {
  const root = memoryRoot(ownerId);
  // 扫所有 episode 文件
  const all: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const rel = abs.slice(root.length + 1).split(sep).join('/');
        try {
          all.push(compressPath(rel));
        } catch {
          // 非 episode 路径，跳过
        }
      }
    }
  }
  await walk(join(root, 'agents'));
  await walk(join(root, 'projects'));

  return all
    .map((p) => ({ p, d: editDistance(p, compressed) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, topN)
    .map((x) => x.p);
}

/**
 * 从压缩 path 派生「所属项目」（S12 记忆粗筛 · G20）：首段是 scope——DEFAULT_AGENT_NAME（'twin'）＝
 * agent 域（全局记忆、不带项目标注 → 返回 undefined）；其余首段即 projectId。形态非法按全局降级
 * （粗筛只该多带、不该错排，无法判定归属时当全局最安全）。与 parseCompressed 的 scope 判定同口径。
 */
export function projectIdOfCompressed(compressed: string): string | undefined {
  const first = compressed.split('/')[0];
  if (!first || first === DEFAULT_AGENT_NAME) return undefined;
  return first;
}

// ─── 内部 helpers ─────────────────────────────────────────

type ParsedCompressed = {
  scope: 'agent' | 'project';
  scopeName: string;
  fileSlug: string;
};

function parseCompressed(compressed: string): ParsedCompressed {
  const parts = compressed.split('/');
  if (parts.length < 2) {
    throw new Error(`compressPath: invalid form, expect "<scope>/<file>": ${compressed}`);
  }
  const scopeName = parts[0];
  const fileSlug = parts.slice(1).join('/');
  // v0.1：scope=agent 等价于 scopeName === DEFAULT_AGENT_NAME
  const scope: 'agent' | 'project' =
    scopeName === DEFAULT_AGENT_NAME ? 'agent' : 'project';
  return { scope, scopeName, fileSlug };
}

function candidatePaths(ownerId: string, parsed: ParsedCompressed): string[] {
  const fileName = `${parsed.fileSlug}.md`;
  if (parsed.scope === 'agent') {
    return [
      join(agentEpisodesDir(ownerId, parsed.scopeName), fileName),
      join(agentArchivedEpisodesDir(ownerId, parsed.scopeName), fileName),
    ];
  }
  return [
    join(projectEpisodesDir(ownerId, parsed.scopeName), fileName),
    join(projectArchivedEpisodesDir(ownerId, parsed.scopeName), fileName),
  ];
}

/** Levenshtein 编辑距离 */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
