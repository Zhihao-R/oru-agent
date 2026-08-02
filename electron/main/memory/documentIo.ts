/**
 * 档案的通用「写整篇 / 改一段」核心 —— 与对话文件工具（write_file / edit_file）对齐
 *
 * profile / self / 项目档案都只是 markdown 文档，写靠这两件通用操作，不认识任何固定区段
 * （收敛掉旧的 12 个 typed op）。事件（episode）带索引、走自己的结构化路径，不并入。
 *
 * - writeMemoryDocument：整篇覆盖正文；frontmatter 由系统保留/更新（last-updated 自动刷新），
 *   模型误带的 frontmatter 一律剥离。
 * - editMemoryDocument：正文内**唯一精确匹配** oldText 替换为 newText（newText 空串即删该段）；
 *   0 次或多次命中都不写盘、返回原因让模型读后重试（与 edit_file 同源、且杜绝改错段）。
 *
 * 落盘策略（档案 vs 非档案）：
 * - 档案（isProfileDocRelPath=true：user/profile.md / agents/<name>/self.md / projects/<id>/profile.md）
 *   走 commitWorkfileWrite / commitWorkfileEdit 统一内核，自动进 FileHistory（兜底找回）。
 *   外层 withFileLock 已删：commitWorkfileWrite 内部 runExclusive 已足够串行，双锁叠加是 C2 根因。
 * - 非档案（episode / list-entry / MEMORY.md 等）保持原 writeMarkdownFile 落盘，不进历史
 *   （这些文件无用户可感知「某时刻版本找回」语义）。
 *
 * 设计见 document-model §2 / §4。
 */
import { ensureWithinRoot, parseFrontmatter, readMarkdownFile, stringifyFrontmatter, writeMarkdownFile } from '../fs/frontmatter';
import { commitWorkfileWrite, commitWorkfileEdit } from '../fs/workfileWrite';
import { normalizeDecoded } from '../fs/safeWrite';
import { contentHash } from '../fs/fileHistory';
import { withFileLock } from '../fs/withFileLock';
import { memoryRoot, isProfileDocRelPath } from './paths';
import { profileBudgetForPath } from './snapshot';
import { parseProfileDoc } from '@shared/memory/profileDoc';
import type { ProfileSectionDelta } from '@shared/types';

/** 解析记忆相对路径到绝对路径，越界即抛（沙箱）。 */
function resolveWithinMemory(ownerId: string, relPath: string): string {
  return ensureWithinRoot(memoryRoot(ownerId), relPath);
}

/**
 * 档案篇幅硬上限守卫（S35·G35）：超硬上限即拦写、抛错让模型精简后重试。
 * 软预算超了不拦（是下次 dream 整篇重写的输入信号，不是错误态）；只有超「宽松的硬上限」才拦。
 * 非档案路径无预算、不拦。
 */
function assertWithinHardLimit(relPath: string, body: string): void {
  const budget = profileBudgetForPath(relPath);
  if (budget && body.length > budget.hard) {
    throw new Error(
      `档案篇幅超硬上限（${body.length} / ${budget.hard} 字）——请精简后重写：` +
        `删冗余、合并被新认知取代的旧段，只留解释「用户/项目/你自己是谁」的稳定画像`,
    );
  }
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 剥掉模型可能误带的 frontmatter，只取正文。无 frontmatter 时原样返回。 */
function stripFrontmatter(content: string): string {
  return parseFrontmatter(content).content;
}

/**
 * 整篇覆盖时新旧两版的小节差异。「整篇重写了《关于你》」本身不告诉用户任何东西，而整篇覆盖
 * 恰恰是能删掉任何小节的最大影响面动作——小节标题是档案的天然结构，据它报差异是诚实的，
 * 不用编摘要。写入时新旧两版都在手上，这是唯一算得出它的地方。
 */
function diffSections(oldBody: string, newBody: string): ProfileSectionDelta | undefined {
  const before = parseProfileDoc(oldBody).sections;
  const after = parseProfileDoc(newBody).sections;
  if (before.length === 0 && after.length === 0) return undefined;
  const beforeByTitle = new Map(before.map((s) => [s.title, s.body]));
  const afterTitles = new Set(after.map((s) => s.title));
  const added = after.filter((s) => !beforeByTitle.has(s.title)).map((s) => s.title);
  const changed = after
    .filter((s) => beforeByTitle.has(s.title) && beforeByTitle.get(s.title) !== s.body)
    .map((s) => s.title);
  const removed = before.filter((s) => !afterTitles.has(s.title)).map((s) => s.title);
  if (added.length === 0 && changed.length === 0 && removed.length === 0) return undefined;
  return { added, changed, removed };
}

export type WriteMemoryResult = {
  status: 'written' | 'merged' | 'discarded';
  content: string;
  /**
   * 写入后完整文件内容（含 frontmatter）的 hash，仅档案类且真落了盘时有。
   * 记忆卡「撤回这次修改」据它在 FileHistory 里定位这次写入产生的那一版、回到它前面一版；
   * 同时是「这之后档案没再被动过」的判据。
   */
  afterHash?: string;
  /** 整篇覆盖时新旧两版的小节差异（无档案结构或无变化时缺省） */
  sections?: ProfileSectionDelta;
};

export async function writeMemoryDocument(
  ownerId: string,
  relPath: string,
  content: string,
  opts?: { by?: 'user' | 'ai'; mark?: 'ai' | 'manual'; baseline?: string; mergeOnStale?: boolean },
): Promise<WriteMemoryResult> {
  const abs = resolveWithinMemory(ownerId, relPath);
  // 归一正文换行（BOM 剥离 + CRLF→LF），与锁内 cur（readWithMetaAsync→normalizeDecoded）同口径：
  // 否则 Windows 来源的 baseFull/mineFull 与归一后的磁盘 cur 逐字节对不上 → baseline-mismatch → 误 discarded。
  const body = normalizeDecoded(stripFrontmatter(content));
  const by = opts?.by ?? 'user';
  const mark = opts?.mark;

  if (isProfileDocRelPath(relPath)) {
    // 档案走统一内核（commitWorkfileWrite），自动进 FileHistory
    const existing = await readMarkdownFile(abs);
    // 防误删全损护栏：拒绝用空内容覆盖非空档案。
    // commitWorkfileWrite 是原子覆盖不留旧版，一次空写即不可逆——这正是本轨要堵的数据丢失门。
    // 要清空请逐节删（edit_memory 把各段删空）。
    if (!body.trim() && existing && existing.content.trim().length > 0) {
      throw new Error('拒绝用空内容覆盖非空档案（防误删全损）——要清空请逐节删除');
    }
    assertWithinHardLimit(relPath, body);
    // mine 和 baseline 共享同一份 frontmatter data，避免 last-updated 漂移导致 discarded
    const data = { ...(existing?.data ?? {}), 'last-updated': todayStamp() };
    const mineFull = stringifyFrontmatter(data, body);
    // baseline 同样归一（渲染端 body-only 字符串可能带 CRLF），与锁内 cur 口径一致
    const baseFull =
      opts?.baseline !== undefined
        ? stringifyFrontmatter(data, normalizeDecoded(opts.baseline))
        : undefined;
    const res = await commitWorkfileWrite({
      absPath: abs,
      content: mineFull,
      by,
      mark,
      baseline: baseFull !== undefined ? { content: baseFull } : undefined,
      mergeOnStale: opts?.mergeOnStale,
    });
    // afterHash 按**完整文件内容**算（含 frontmatter）——快照存的就是完整内容，撤回要按它在历史里
    // 定位「这次写入产生的那一版」。传 body 的 hash 会永远找不到。
    if (res.status === 'written') {
      return {
        status: 'written',
        content: body,
        afterHash: contentHash(mineFull),
        sections: diffSections(existing?.content ?? '', body),
      };
    }
    if (res.status === 'merged') {
      const mergedBody = parseFrontmatter(res.content).content;
      return {
        status: 'merged',
        content: mergedBody,
        afterHash: contentHash(res.content),
        sections: diffSections(existing?.content ?? '', mergedBody),
      };
    }
    // rejected（discarded / baseline-mismatch / 文件消失）→ 回磁盘现状 body 供编辑器 rebaseline
    // readMarkdownFile 裸读不归一，这里归一后再返回：编辑器拿它当下一轮 baseline，口径必须与锁内 cur 一致
    const disk = await readMarkdownFile(abs);
    return { status: 'discarded', content: disk ? normalizeDecoded(disk.content) : '' };
  } else {
    // 非档案（episode / list-entry / MEMORY.md 等）保持原 writeMarkdownFile 落盘
    const existing = await readMarkdownFile(abs);
    if (!body.trim() && existing && existing.content.trim().length > 0) {
      throw new Error('拒绝用空内容覆盖已有非空内容（防误删全损）');
    }
    assertWithinHardLimit(relPath, body);
    const data = { ...(existing?.data ?? {}) };
    data['last-updated'] = todayStamp();
    await writeMarkdownFile(abs, data, body);
    return { status: 'written', content: body };
  }
}

export type EditResult = {
  replaced: boolean;
  reason?: 'none' | 'multiple';
  /** 见 WriteMemoryResult.afterHash——档案类改动的撤回锚点 */
  afterHash?: string;
};

/** 统计 needle 在 haystack 中的非重叠出现次数（needle 为空记 0）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export async function editMemoryDocument(
  ownerId: string,
  relPath: string,
  oldText: string,
  newText: string,
): Promise<EditResult> {
  const abs = resolveWithinMemory(ownerId, relPath);

  if (isProfileDocRelPath(relPath)) {
    // 档案走 commitWorkfileEdit：read-apply-write 整段在同一把 workfile 锁内，AI 笔（by='ai'）。
    // 命中判定必须放在 commitWorkfileEdit **之外**：该内核锁内无条件跑 guardOverwrite + safeWrite +
    // （有 mark 时）snapshot——即使 apply 返回原串也照写、照推 lastAuthor='ai'、照打快照。
    // 故 0/多次命中若走进内核，会留下不该有的写盘/换笔/历史副作用。先读现存内容判命中，唯一命中才入锁。
    const existing = await readMarkdownFile(abs);
    if (!existing) return { replaced: false, reason: 'none' }; // 文件不存在＝0 次命中
    const count = countOccurrences(existing.content, oldText);
    if (count === 0) return { replaced: false, reason: 'none' };
    if (count > 1) return { replaced: false, reason: 'multiple' };
    // 唯一命中：入锁重取锁内最新 current 再替换（并发下 current 可能已变，承重判断锁内重做）。
    // 外层 read 在 runExclusive 队列之外，锁内 current 的命中数可能已非 1——必须锁内重校验，
    // 命中数≠1 就 throw 放弃写入（防 indexOf 返回 -1 时 slice 静默产出损坏内容并写盘打历史）。
    // 该 throw 在下面被捕获后按「未命中」处理（不写盘），不裸抛给调用方。
    let updated: string;
    try {
      updated = await commitWorkfileEdit({
        absPath: abs,
        mark: 'ai',
        apply: (current) => {
          const { data, content: body } = parseFrontmatter(current);
          const n = countOccurrences(body, oldText);
          if (n !== 1) throw new Error('editMemoryDocument: 锁内重读后命中数≠1，放弃写入（防静默损坏）');
          // 按字面切片替换（不走 String.replace，避免 $& / $1 等被当替换模式解释）
          const at = body.indexOf(oldText);
          const next = body.slice(0, at) + newText + body.slice(at + oldText.length);
          assertWithinHardLimit(relPath, next);
          return stringifyFrontmatter({ ...data, 'last-updated': todayStamp() }, next);
        },
      });
    } catch {
      // 锁内发现命中已不唯一＝按未命中处理，不写盘
      return { replaced: false, reason: 'none' };
    }
    // commitWorkfileEdit 返回的是写进磁盘的完整内容——与快照同口径，直接可作撤回锚点
    return { replaced: true, afterHash: contentHash(updated) };
  } else {
    // 非档案保持原锁内 RMW 逻辑（withFileLock 仍在非档案路径服务，仅档案路径删双锁）
    return withFileLock(abs, async () => {
      const existing = await readMarkdownFile(abs);
      if (!existing) return { replaced: false, reason: 'none' };
      const body = existing.content;
      const count = countOccurrences(body, oldText);
      if (count === 0) return { replaced: false, reason: 'none' };
      if (count > 1) return { replaced: false, reason: 'multiple' };
      const at = body.indexOf(oldText);
      const next = body.slice(0, at) + newText + body.slice(at + oldText.length);
      assertWithinHardLimit(relPath, next);
      const data = { ...existing.data, 'last-updated': todayStamp() };
      await writeMarkdownFile(abs, data, next);
      return { replaced: true };
    });
  }
}
