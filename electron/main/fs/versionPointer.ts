/**
 * 版本指针抽象（项目B 第三期 Task11）
 *
 * 提交流（submissions.ts）的"改前/改后/取消"只需三件事：落一版拿 id、把某版写回活动文件、取某版内容。
 * 抽成 VersionPointer 接口，deck 与 html 各自实现，提交内核据此共用一条流（不再让 html 伪装成 deck）：
 * - deck：厚——包 history.ts（manifest/changedPages/undo 语义层保留），见 deck/deckPointer.ts。
 * - html：薄——直连 fileHistory，无 manifest（html 不需要 deck 的版本账本，历史走统一时间轴）。
 *
 * versionId 对内核不透明：deck 是 vNNN（语义层 id），html 是 fileHistory snapshot id（sNNN）。
 */
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import type { HistoryVersion } from '@shared/types';
import { commitSnapshot, restore as restoreSnapshot } from './fileHistory';
import { safeWriteAsync } from './safeWrite';
import { runExclusive } from './runExclusive';

/** 成版 kind——deck 的版本 kind 集（FileSnapshotKind 子集）；提交流实际只用 protective/ai。 */
export type CommitKind = HistoryVersion['kind'];

export interface VersionPointer {
  /** 落一版，返回不透明 versionId（before/after 锚点）。summary 仅 deck 用（落版本元数据），html 丢弃。 */
  commit(kind: CommitKind, summary: string): Promise<{ versionId: string }>;
  /** 把某版内容写回活动文件（取消/退回改前）。 */
  checkout(versionId: string): Promise<void>;
  /** 取某版完整内容（对比用，不改盘）。 */
  restore(versionId: string): Promise<string>;
}

/**
 * html 薄指针——key=resolve(htmlPath)，字节走 fileHistory。
 * 无 manifest/currentVersion/changedPages/undo：那些是 deck UI 的承重账本，html 不需要。
 */
export function htmlVersionPointer(htmlPath: string): VersionPointer {
  const key = resolve(htmlPath);
  return {
    // 读 + 落快照入 runExclusive(key) 串行——与 applyTextEdit（同 key）互斥，不快照到半写内容。
    // commitSnapshot 内容未变复用现存 ref（before 永不落空，不返 null）。锁序 workfile(key)→history 小锁，单向。
    async commit(kind) {
      return runExclusive(key, async () => {
        const content = await fs.readFile(key, 'utf-8');
        const ref = await commitSnapshot(key, kind, content);
        return { versionId: ref.id };
      });
    },
    async checkout(versionId) {
      return runExclusive(key, async () => {
        const content = await restoreSnapshot(key, versionId);
        await safeWriteAsync(key, content);
      });
    },
    restore(versionId) {
      return restoreSnapshot(key, versionId);
    },
  };
}
