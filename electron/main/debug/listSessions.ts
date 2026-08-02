/**
 * 扫 debug 目录，给前端列表用——按 round 聚合（同一 conversation 多轮拆成多条）。
 *
 * 跟"按文件汇总"的旧版本相比，本版本会顺序扫整个 ndjson，按 round_start / round_done
 * 边界把每一轮拆成独立 RoundSummary。同一文件可能产出多条 RoundSummary。
 *
 * 性能：MVP 阶段允许一次 readFile + split('\n')；典型场景每文件 < 200 行 KB 级。
 * 文件爆炸时（每天数千轮 / 单文件数十 MB）再换 readline 流式扫——签名不变。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  DebugPayloadMap,
  DebugRecord,
  RoundSource,
  RoundSummary,
} from '@shared/debug/types';
import { debugDir } from '../runtime/paths';

/**
 * userText 列表预览上限。compress / web_summary 等后台 source 的 userText 是整段
 * prompt（几十 KB 级），不截断会让 debug:list 的 IPC payload 随历史线性膨胀。
 * 全文不丢——详情页走 debug:read 读原始 ndjson，RoundStartDetail 展示完整文本。
 */
const USER_TEXT_PREVIEW_CHARS = 200;

/** 按码点截断——slice 按 UTF-16 码元数会劈裂 emoji 等代理对，产生孤立代理项 */
function truncatePreview(text: string | undefined | null): string {
  if (text == null) return '';
  // 快速路径：码元数 ≤ 上限则码点数必 ≤ 上限，不用展开
  if (text.length <= USER_TEXT_PREVIEW_CHARS) return text;
  const points = [...text];
  if (points.length <= USER_TEXT_PREVIEW_CHARS) return text;
  return points.slice(0, USER_TEXT_PREVIEW_CHARS).join('') + '…';
}

/**
 * 纯函数：ndjson 文本 → 多 RoundSummary（按 round_start / round_done 切分）。
 *
 * 进行中的轮按 roundId 归属，允许多轮同时打开——主对话进行中发起的附属调用
 * （compress / web 摘要 / subagent）写进同一文件，记录与主轮嵌套或交错；
 * 单游标顺序切分会把主轮的 round_done / error 丢给别的轮或整体吞掉。
 *
 * 抽成纯函数便于单测，不读 fs。坏行（截断 / kill -9）自动跳过。
 */
export function parseRoundsFromText(
  dateKey: string,
  conversationId: string,
  text: string,
  fileMtimeMs: number,
): RoundSummary[] {
  const lines = text.split('\n').filter((l) => l.length > 0);

  const rounds: RoundSummary[] = [];
  /** 进行中的轮：roundId → 累积中的 summary */
  const open = new Map<string, RoundSummary>();

  for (const line of lines) {
    let rec: DebugRecord;
    try {
      rec = JSON.parse(line) as DebugRecord;
    } catch {
      // 坏行：跳过，继续找下一条 round_start
      continue;
    }

    if (rec.type === 'round_start') {
      const p = rec.payload as DebugPayloadMap['round_start'];
      open.set(rec.roundId, {
        dateKey,
        conversationId,
        roundId: rec.roundId,
        source: p.source as RoundSource,
        agentName: rec.agentName,
        userText: truncatePreview(p.userText),
        startTs: rec.ts,
        fileMtimeMs,
      });
      continue;
    }

    const cur = open.get(rec.roundId);
    if (!cur) continue;

    if (rec.type === 'round_done') {
      const p = rec.payload as DebugPayloadMap['round_done'];
      cur.durationMs = p.totalDurationMs;
      cur.hadError = p.hadError;
      open.delete(rec.roundId);
      rounds.push(cur);
      continue;
    }

    if (rec.type === 'error') {
      const p = rec.payload as DebugPayloadMap['error'];
      // 只记最后一条 error message——列表展示一行截断即可。
      // hadError 由 round_done 设权威值；这里不抢先覆盖。
      cur.errorMessage = p.message;
    }
  }

  // 没收到 round_done 的轮（进行中 / kill -9 / crash）——durationMs 等留 undefined
  rounds.push(...open.values());

  return rounds;
}

/** 单文件 → 多 RoundSummary（壳层：读 fs + 调 parseRoundsFromText） */
async function summarizeFile(
  dateKey: string,
  conversationId: string,
  filePath: string,
): Promise<RoundSummary[]> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return [];
  }
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  return parseRoundsFromText(dateKey, conversationId, text, stat.mtimeMs);
}

/** 列出某 owner 下所有 round——按 startTs 倒序，缺 startTs 时 fallback fileMtimeMs */
export async function listSessions(ownerId: string): Promise<RoundSummary[]> {
  const root = debugDir(ownerId);
  let dayDirs: string[];
  try {
    dayDirs = await fs.readdir(root);
  } catch {
    return [];
  }

  const all: RoundSummary[] = [];
  for (const dateKey of dayDirs) {
    const dayPath = join(root, dateKey);
    let files: string[];
    try {
      const stat = await fs.stat(dayPath);
      if (!stat.isDirectory()) continue;
      files = await fs.readdir(dayPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith('conversation-') || !f.endsWith('.ndjson')) continue;
      const conversationId = f.slice('conversation-'.length, -'.ndjson'.length);
      // capture_ 副本（conversation-capture_cnv_xxx.ndjson）与原始 conversation-cnv_xxx.ndjson
      // 内容完全相同——跳过副本，避免同 roundId 出两条导致 React key 重复
      if (conversationId.startsWith('capture_')) continue;
      const rounds = await summarizeFile(dateKey, conversationId, join(dayPath, f));
      all.push(...rounds);
    }
  }

  all.sort((a, b) => {
    // startTs > 0 时用绝对时间；为 0（异常时钟）才回退 fileMtime——避免把 0 当"无值"
    const aTs = a.startTs > 0 ? a.startTs : a.fileMtimeMs;
    const bTs = b.startTs > 0 ? b.startTs : b.fileMtimeMs;
    return bTs - aTs;
  });
  return all;
}
