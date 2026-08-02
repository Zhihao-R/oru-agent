/**
 * capture / dream 有效性 smoke 的 fixture 与取数 helper
 *
 * 配套 docs/plans/2026-07-30-capture-dream-有效性测试计划.md——计划钉死了三要素
 * （造什么数据 / 赢的标准 / 数据来源），这里只提供机制：
 *   造：对话 jsonl / episode（走 applyOps，可钉 userRequested 与 mtime）/ 注册项目 / 预写 profile
 *   取：落盘 episode（活跃+archived 两层）/ debug 日志 round 记录 / 工具调用计数
 *   报：行级 diff + 报告落盘（tmpdir，路径打印 console，3 次重复并排判一致性）
 *
 * 所有 fixture 文案硬编码在各场景文件里、3 次重复共用同一份——人判的「3 次一致性」
 * 以同一份输入为比较基础（计划实施步骤 1）。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps } from '../../../electron/main/memory/applyOps';
import { expandPath } from '../../../electron/main/memory/compressedPath';
import { changelogPath } from '../../../electron/main/memory/changelog';
import { memoryRoot, userProfilePath } from '../../../electron/main/memory/paths';
import {
  listAllEpisodesWithSuperseded,
  type EpisodeSummary,
} from '../../../electron/main/memory/store';
import { getBackendFor } from '../../../electron/main/agent/backends';
import { addProject, updateSettings } from '../../../electron/main/projects/store';
import { readMarkdownFile } from '../../../electron/main/fs/frontmatter';
import { safeWriteAsync } from '../../../electron/main/fs/safeWrite';
import { convDir, debugConvFile, debugDayDir } from '../../../electron/main/runtime/paths';
import { dateKey } from '../../../electron/main/debug/retention';
import { normalizeToolName } from '@shared/agent/toolName';
import type { DebugRecord } from '@shared/debug/types';
import type { EpisodeType } from '@shared/types';

// ─── backend 就绪 ─────────────────────────────────────────

/**
 * 确保 memoryDream backend 可用，返回实际生效的模式与模型（结论对应这个模型，报告必带）。
 * 顺序与环境陷阱：
 * 1. shell 带第三方 coding plan 凭证（ANTHROPIC_API_KEY+BASE_URL）→ 优先注入 kimi-coding
 *    provider。不能先信 OAuth 就绪检测：detectAuth 见 ANTHROPIC_API_KEY 就报 ready（env_api_key
 *    模式），但子进程 env 整包透传、BASE_URL 被剥后厂商 key 打到官方端点必 401
 *    （docs/bug/2026-06-09 的劫持陷阱）——「ready」不等于「能用」。
 * 2. 否则试 OAuth 回落（本机 Claude 登录态——计划「前提与适用边界」假设的默认路径）。
 * key 只从 env 读、不硬编码；隔离 ORU_DIR 是 tmpdir 一次性目录。
 * 走 coding plan 时结论对应该模型，不外推计划假设的 Claude opus（同节口径：换配置后需重跑）。
 */
export async function ensureSmokeMemoryBackend(): Promise<{ mode: string; model: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (apiKey && baseUrl) {
    // ANTHROPIC_MODEL 可能带 harness 私货后缀（如 k3[1m] 的 [1m] 是上下文窗标记），
    // 端点只认裸模型 id（k3）——剥掉方括号后缀
    const modelId = (process.env.ANTHROPIC_MODEL ?? 'kimi-for-coding').replace(/\[.*\]$/, '');
    await updateSettings((cur) => ({
      providers: [
        ...cur.providers,
        { id: 'prv_smoke_kimi', type: 'kimi-coding' as const, label: 'Kimi Coding（smoke 注入）', apiKey, baseUrl },
      ],
      models: [
        ...cur.models,
        {
          id: 'mdl_smoke_kimi',
          providerId: 'prv_smoke_kimi',
          modelId,
          label: modelId,
          contextWindow: 262_144,
          supportsVision: false,
        },
      ],
      modelAssignments: { ...cur.modelAssignments, memoryDream: 'mdl_smoke_kimi' },
    }));
    const injected = await getBackendFor('memoryDream');
    if ((await injected.isReady()).ok) return { mode: 'kimi-coding', model: modelId };
  }
  const oauth = await getBackendFor('memoryDream');
  if ((await oauth.isReady()).ok) return { mode: 'oauth-fallback', model: 'claude(opus 档)' };
  return null;
}

// ─── 造数据 ────────────────────────────────────────────────

export type FixtureMessage = { role: string; text: string };

/**
 * 造一段对话 jsonl（字段照 runCapture / read_conversation 两路都能读出的形态）。
 * baseTs 显式传入：增量场景（先造 N 轮抽一次、再追加 M 轮抽第二次）靠同一 base
 * 重写整个文件，保证第一批消息的 createdAt 在两次造数间稳定不变。
 */
export async function makeConversation(
  ownerId: string,
  convId: string,
  msgs: FixtureMessage[],
  baseTs?: number,
): Promise<number[]> {
  const dir = join(convDir(ownerId), 'twin');
  await fs.mkdir(dir, { recursive: true });
  const base = baseTs ?? Date.now() - msgs.length * 1000;
  const createdAts = msgs.map((_, i) => base + i * 1000);
  const lines = msgs
    .map((m, i) =>
      JSON.stringify({
        id: `${convId}-${i}`,
        role: m.role,
        conversationId: convId,
        text: m.text,
        createdAt: createdAts[i],
      }),
    )
    .join('\n');
  // 裸 writeFile：smoke 一次性 fixture（tmpdir 用完即弃），不走原子写内核（CLAUDE.md 豁免情形）
  await fs.writeFile(join(dir, `${convId}.jsonl`), `${lines}\n`, 'utf-8');
  return createdAts;
}

export type FixtureEpisode = {
  slug: string;
  type: EpisodeType;
  title: string;
  description: string;
  content: string;
  sources: string[];
  userRequested?: boolean;
};

/**
 * 造一条 episode（走 applyOps，origin=capture——capture 白名单只放行 create-episode，
 * 正好是 fixture 唯一需要的 op）。mtime 传入时用 utimes 钉死——dream 的输入索引按
 * mtime 倒序，D1 的交错散布靠它控制（只改 mtime 不改创建顺序，索引顺序可复现）。
 */
export async function makeEpisode(
  ownerId: string,
  ep: FixtureEpisode,
  mtime?: number,
): Promise<string> {
  const r = await applyOps(
    ownerId,
    [
      {
        op: 'create-episode',
        payload: {
          scope: 'agent',
          type: ep.type,
          title: ep.title,
          slug: ep.slug,
          description: ep.description,
          content: ep.content,
          sources: ep.sources,
          tags: [],
          ...(ep.userRequested ? { userRequested: true } : {}),
        },
      },
    ],
    'capture',
  );
  const [first] = r.results;
  if (!first?.ok) {
    throw new Error(`造 episode 失败 ${ep.slug}: ${JSON.stringify(r.results)}`);
  }
  const compressed = first.detail ?? '';
  if (mtime !== undefined) {
    const rel = await expandPath(ownerId, compressed);
    const abs = join(memoryRoot(ownerId), rel);
    await fs.utimes(abs, mtime / 1000, mtime / 1000);
  }
  return compressed;
}

/** 注册一个真实项目（P6 需要已注册项目 id），返回 projectId */
export async function registerSmokeProject(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'oru-smoke-proj-'));
  const project = await addProject(dir);
  return project.id;
}

/** 预写 user/profile.md 裸正文（documentIo 读写都合并现有 data、自刷 last-updated，无需 frontmatter） */
export async function writeUserProfile(ownerId: string, body: string): Promise<void> {
  await fs.mkdir(join(memoryRoot(ownerId), 'user'), { recursive: true });
  await safeWriteAsync(userProfilePath(ownerId), body);
}

export async function readUserProfile(ownerId: string): Promise<string> {
  return (await readMarkdownFile(userProfilePath(ownerId)))?.content ?? '';
}

/** 场景间清库：memoryRoot 整目录删掉（含索引 / changelog / .dream-state.json），各 dream 场景互不污染 */
export async function resetMemory(ownerId: string): Promise<void> {
  await fs.rm(memoryRoot(ownerId), { recursive: true, force: true });
}

// ─── 取数 ────────────────────────────────────────────────

/** 活跃 + archived 两层的全部 episode（retire/supersede 会物理移档，只扫活跃层会假绿） */
export async function listAllEpisodes(ownerId: string): Promise<EpisodeSummary[]> {
  return listAllEpisodesWithSuperseded(ownerId, true);
}

/** 读一条 episode 的 frontmatter + 正文全文 */
export async function readEpisodeFull(
  ownerId: string,
  relPath: string,
): Promise<{ data: Record<string, unknown>; content: string } | null> {
  const f = await readMarkdownFile(join(memoryRoot(ownerId), relPath)).catch(() => null);
  if (!f) return null;
  return { data: f.data as Record<string, unknown>, content: f.content };
}

/** 某个来源对话产出的全部 episode（按 sources 含 convId 过滤） */
export function episodesFromConv(eps: EpisodeSummary[], convId: string): EpisodeSummary[] {
  return eps.filter((e) => e.sources?.includes(convId));
}

/**
 * 读某个 conversationId 的 debug round 记录（当天目录，跨午夜回落昨天——
 * 23:59 开跑 00:01 读时「日志链路问题」是假红）。
 * capture 的 conversationId 是 `capture_<convId>`，dream 的是 `dream_<ts>`。
 * 调用前必须 debugLogger.setEnabled(true) 且 await debugLogger.flushForTest()——
 * 异步落盘，不 flush 读不到（计划实施步骤 2 的 P2/P3 假红陷阱）。
 */
export async function readDebugRecords(
  ownerId: string,
  conversationId: string,
): Promise<DebugRecord[]> {
  for (const day of todayAndYesterday()) {
    const records = await parseNdjson(debugConvFile(ownerId, day, conversationId));
    if (records.length > 0) return records;
  }
  return [];
}

/** 找指定前缀的最新一个 debug 会话文件（dream 的 convId 内嵌时间戳，只能靠前缀+mtime 定位；跨午夜同样回落昨天） */
export async function readLatestDebugRecords(
  ownerId: string,
  convIdPrefix: string,
): Promise<DebugRecord[]> {
  for (const day of todayAndYesterday()) {
    const dir = debugDayDir(ownerId, day);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    const candidates = names.filter((n) => n.startsWith(`conversation-${convIdPrefix}`));
    if (candidates.length === 0) continue;
    const withMtime = await Promise.all(
      candidates.map(async (n) => ({
        n,
        mtime: (await fs.stat(join(dir, n))).mtimeMs,
      })),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return parseNdjson(join(dir, withMtime[0].n));
  }
  return [];
}

function todayAndYesterday(): string[] {
  const now = Date.now();
  return [dateKey(now), dateKey(now - 24 * 3600_000)];
}

async function parseNdjson(path: string): Promise<DebugRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch {
    return [];
  }
  const out: DebugRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DebugRecord);
    } catch {
      // 坏行跳过（落盘中断截断是 debug 模块已声明的固有限制）
    }
  }
  return out;
}

/** 一轮 capture 的 prompt 原文（round_start 的 userText）；多轮取 rounds 里第 index 个 */
export function capturePrompts(records: DebugRecord[]): string[] {
  return records
    .filter((r) => r.type === 'round_start')
    .map((r) => (r.payload as { userText?: string }).userText ?? '');
}

/** 工具调用计数（tool_call_start 按 normalizeToolName 剥 mcp__oru__ 前缀后按名计数） */
export function countToolCalls(records: DebugRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of records) {
    if (r.type !== 'tool_call_start') continue;
    const name = normalizeToolName((r.payload as { name?: string }).name ?? '');
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** 工具调用明细（name + input），供报告摆「合并有没有 read_memory 支撑」「纠错 evidence」样本 */
export function toolCallDetails(
  records: DebugRecord[],
): Array<{ name: string; input: Record<string, unknown> }> {
  const out: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const r of records) {
    if (r.type !== 'tool_call_start') continue;
    const p = r.payload as { name?: string; input?: Record<string, unknown> };
    out.push({ name: normalizeToolName(p.name ?? ''), input: p.input ?? {} });
  }
  return out;
}

/** 当夜 changelog 全文（UTC 日期，与 changelog.ts 的 today() 同口径） */
export async function readChangelog(ownerId: string): Promise<string> {
  try {
    return await fs.readFile(changelogPath(ownerId), 'utf-8');
  } catch {
    return '';
  }
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 夜记段落：changelog 当夜 `## date` 日期行正下方首段。
 * op 明细（`- ` 行）也进同一小节，夜记被 writeNightNote 插在标题与明细之间——
 * 首段非空且不是明细行才算「跑成功且交代了」（R3 判法，计划组五）。
 */
export function nightNoteFromChangelog(raw: string, date: string): string {
  const lines = raw.split('\n');
  const idx = lines.findIndex((l) => l.trim() === `## ${date}`);
  if (idx < 0) return '';
  const para: string[] = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') {
      if (para.length > 0) break;
      continue;
    }
    if (l.startsWith('## ')) break;
    para.push(l);
  }
  return para.join('\n').trim();
}

// ─── 报告 ────────────────────────────────────────────────

/** 行级 diff（简单 LCS）：`- ` 删除行 / `+ ` 新增行，未变行原样。报告给档案全文 diff 用 */
export function diffLines(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  // LCS 长度表
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

/** 报告落盘：tmpdir 下独立目录（不进 ORU_DIR，避免污染「目录 diff」类断言），路径打印 console */
export async function writeSmokeReport(name: string, markdown: string): Promise<string> {
  const dir = join(tmpdir(), 'oru-memory-smoke-reports');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  await safeWriteAsync(path, markdown);
  console.log(`[smoke] 报告已落盘：${path}`);
  return path;
}

/** 把一条 episode 摆成报告块（索引行 + frontmatter 要点 + 全文） */
export async function episodeReportBlock(ownerId: string, e: EpisodeSummary): Promise<string> {
  const full = await readEpisodeFull(ownerId, e.relPath);
  return [
    `#### ${e.relPath}`,
    `- status: ${e.status}${e.retiredReason ? `（判据：${e.retiredReason}）` : ''}`,
    `- type: ${e.type} / source: ${e.source ?? '-'} / sources: [${(e.sources ?? []).join(', ')}]${e.correctedAt ? ` / corrected-at: ${e.correctedAt}` : ''}`,
    `- 标题：${e.title}`,
    `- 描述：${e.description}`,
    '',
    '正文：',
    '```',
    full?.content ?? '(读不到)',
    '```',
  ].join('\n');
}

// ─── 确定性洗牌（D1 交错散布，seed 固定可复现） ─────────────────

/** mulberry32：小而够用的确定性 PRNG——同 seed 同序列，3 次重复各一个 seed */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates，用传入的 PRNG（不用 Math.random——不可复现） */
export function shuffled<T>(arr: T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
