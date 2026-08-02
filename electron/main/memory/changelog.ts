/**
 * dream 动作变更记录 — <memory root>/changelog.md
 *
 * 一份人直接可读的 markdown，按夜分组（`## YYYY-MM-DD` 标题，时间正序追加）：
 * 标题下先是 dream 自写的夜记段落（writeNightNote），再是逐条机器明细
 * （appendChangeLine，applyOps 在 dream origin 的写 op 落盘后追加，不经模型）。
 *
 * 写入是读 + 拼 + 原子落盘的非原子 RMW——依赖同一 owner 的 dream 不并发
 * （dreamScheduler 的进程内 inFlight 单飞）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { MemoryOp } from '@shared/memory/operations';
import { safeWriteAsync } from '../fs/safeWrite';
import { memoryRoot } from './paths';

export function changelogPath(ownerId: string): string {
  return join(memoryRoot(ownerId), 'changelog.md');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readRaw(ownerId: string): Promise<string> {
  try {
    return await fs.readFile(changelogPath(ownerId), 'utf-8');
  } catch {
    return '';
  }
}

/** 确保当夜小节存在（时间正序，当夜永远是最后一节），返回已含小节的全文 */
function ensureSection(raw: string, date: string): string {
  const heading = `## ${date}`;
  if (raw.split('\n').some((l) => l.trim() === heading)) return raw;
  const sep = raw.length > 0 && !raw.endsWith('\n\n') ? (raw.endsWith('\n') ? '\n' : '\n\n') : '';
  return `${raw}${sep}${heading}\n`;
}

/** 追加一条机器明细行到当夜小节末尾。换行压成空格——一条明细必须是一行 */
export async function appendChangeLine(ownerId: string, line: string): Promise<void> {
  const clean = line.replace(/\s*\n\s*/g, ' ').trim();
  if (!clean) return;
  const raw = ensureSection(await readRaw(ownerId), today());
  const next = `${raw.endsWith('\n') ? raw : `${raw}\n`}- ${clean}\n`;
  await safeWriteAsync(changelogPath(ownerId), next);
}

/**
 * 把 dream 自写的夜记段落插到当夜标题之后、明细行之前。
 * 当夜没有任何明细（空跑）时也写——"看过一遍，没有需要整理的"同样是交代。
 */
export async function writeNightNote(ownerId: string, text: string): Promise<void> {
  const note = text.trim();
  if (!note) return;
  const date = today();
  const raw = ensureSection(await readRaw(ownerId), date);
  const lines = raw.split('\n');
  const idx = lines.findIndex((l) => l.trim() === `## ${date}`);
  lines.splice(idx + 1, 0, '', note);
  await safeWriteAsync(changelogPath(ownerId), lines.join('\n'));
}

/**
 * MemoryOp → 明细行文案。返回 null 的 op 不记（目前所有 dream 白名单 op 都记）。
 * @param resultDetail op 执行结果的 detail（episode 类 op 是新条的压缩路径）——
 *   校对行必须带新路径：前端「校对依据」按**新文件**的 date-slug 匹配明细行，
 *   只记旧路径会让那个入口永远落空（纠错产物是新文件，日期/slug 都可能变）。
 */
export function describeOpForChangelog(op: MemoryOp, resultDetail?: string): string | null {
  switch (op.op) {
    case 'correct-episode':
      return (
        `校对「${op.payload.title}」 ${op.oldPath}${resultDetail ? ` → ${resultDetail}` : ''}` +
        `${op.evidence ? `：依据「${op.evidence}」` : ''}（改前版本在回收站）`
      );
    case 'retire-episode':
      return `收起 ${op.path}：${op.reason}`;
    case 'merge-episodes':
      return `合并 ${op.mergeFrom.join('、')} → ${op.mergeInto}`;
    default:
      // 档案升格（user/self/项目）已改走 write_memory / edit_memory 文档模型、不经 applyOps，
      // 故不在此逐条记；其改动由 dream 夜记叙述概括。这里只记 episode 结构化 op。
      return null;
  }
}
