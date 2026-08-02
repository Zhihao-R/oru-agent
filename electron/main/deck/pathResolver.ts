/**
 * Deck 标识 ↔ 路径解析 + sanitize + 重名后缀
 *
 * 标识体系（详 docs/tech/2026-05-26-html-deck-tech-design.md §2）：
 * - artifactId：跨进程 / 协议层用
 * - deckPath：仅 main 内文件操作；由 artifactId resolve 出来
 * - deckName：显示名 + 目录名（sanitize 后）
 *
 * 本模块**不**持有 deck 注册表——那是 store.ts 的职责；本模块只做纯函数路径计算。
 */
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 把用户输入的 deckName sanitize 成合法目录名。
 * - 替换文件系统非法字符：`/ \ : * ? " < > |` → `-`
 * - 保留中文 / 空格
 * - 多个连续 `-` 合并；首尾 `-` 去掉
 * - 长度上限 80 字符
 */
export function sanitizeDeckName(name: string): string {
  const replaced = name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
  return replaced.slice(0, 80);
}

/**
 * 在 parentPath 下挑一个不重名的目录名——已存在则加 `-2` / `-3` 后缀。
 * 不创建目录，只返回名字。
 */
export async function pickUniqueName(parentPath: string, name: string): Promise<string> {
  const sanitized = sanitizeDeckName(name);
  if (!sanitized) throw new Error('deck name 为空（sanitize 后）');
  let candidate = sanitized;
  let suffix = 2;
  while (await pathExists(join(parentPath, candidate))) {
    candidate = `${sanitized}-${suffix}`;
    suffix += 1;
    if (suffix > 999) throw new Error(`pickUniqueName 重名爆表：${sanitized}`);
  }
  return candidate;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Deck 目录内的常用文件路径 helper */
export function deckIndexPath(deckPath: string): string {
  return join(deckPath, 'index.html');
}

/**
 * deck 大锁 / fileHistory deckKey 的单一来源——`resolve(deckIndexPath(deckPath))`。
 * 必须 resolve 归一：deck 的版本 commit/checkout/重排走这把大锁，而行内改字经 applyTextEdit
 * 走 `runExclusive(resolve(filePath))`、fileHistory 小锁也 keyed on resolve 后路径。三者不同源
 * （裸 deckIndexPath 未 resolve）→ 同一 deck 落两把锁、丢更新（项目B 前置阻塞#4）。
 */
export function deckLockKey(deckPath: string): string {
  return resolve(deckIndexPath(deckPath));
}
export function deckAnnotationsPath(deckPath: string): string {
  return join(deckPath, '.annotations.json');
}

/** 提交中断轻量持久记录 `<path>/.annotations/interruptions.json`（项目B 第二期，崩溃「已中断」用）。 */
export function deckInterruptionsPath(deckPath: string): string {
  return join(deckPath, '.annotations', 'interruptions.json');
}
export function deckNarrativePath(deckPath: string): string {
  return join(deckPath, '.narrative.md');
}
export function deckHistoryDir(deckPath: string): string {
  return join(deckPath, '.history');
}
export function deckManifestPath(deckPath: string): string {
  return join(deckHistoryDir(deckPath), 'manifest.json');
}
export function deckVersionsDir(deckPath: string): string {
  return join(deckHistoryDir(deckPath), 'versions');
}
export function deckVersionFile(deckPath: string, versionId: string): string {
  return join(deckVersionsDir(deckPath), `${versionId}.html`);
}

// ── 项目B 第一期：.history → fileHistory 迁移的脚手架落点（烤熟后随旧存储兜底一并摘除）──
/** 「已迁移」原子 sentinel——存在=该 deck 已迁进中央仓，读路径只认它防重迁（前置阻塞#5）。 */
export function deckMigratedSentinelPath(deckPath: string): string {
  return join(deckHistoryDir(deckPath), 'migrated.json');
}
/** 迁移前 manifest 的只读备份，作回滚基线（恢复它=丢弃 post-migration 版本，§六-2）。 */
export function deckManifestBakPath(deckPath: string): string {
  return join(deckHistoryDir(deckPath), 'manifest.pre-migration.json');
}
/** per-deck 回滚标记——存在=该 deck 已手动回滚，迁移触发跳过它（不再自动重迁）。 */
export function deckRollbackFlagPath(deckPath: string): string {
  return join(deckHistoryDir(deckPath), 'rollback');
}
export function deckImagesDir(deckPath: string): string {
  return join(deckPath, 'images');
}

/** 框选注释截图目录 `<path>/.annotations/crops/` */
export function artifactCropsDir(artifactPath: string): string {
  return join(artifactPath, '.annotations', 'crops');
}

/** 单条注释的截图绝对路径 `<path>/.annotations/crops/<id>.png` */
export function artifactCropPath(artifactPath: string, annotationId: string): string {
  return join(artifactCropsDir(artifactPath), `${annotationId}.png`);
}
