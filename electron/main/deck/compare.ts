/**
 * 对比临时快照（提交组「对比」动作的后端）
 *
 * 历史字节存在 fileHistory 中央仓（项目B 第一期起；旧 `.history/versions/` 退役），但 HTML 里
 * `images/x.png` 这类相对路径是相对**制品根目录**写的——直接渲染中央仓内容会裂图。所以对比时把
 * before/after 两版内容临时写到制品根目录下，相对路径才解析得对；退出对比时删掉（只读临时态，
 * 不进版本系统）。取版本字节走 history.restoreVersionContent（按 deck 版本 id → snapshotId）。
 */
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { SubmissionTarget } from '../submissions/target';
import { deckTarget } from '../submissions/target';

/**
 * 把 before/after 两版快照内容临时写到**活动文件所在目录**（target.compareTmp），返回相对名（前端拼 fileUrl）。
 * 写在活动文件同目录是为了让快照里的相对路径（images/ 等）解析正确。deck/html 共用（落点/文件名由 target 决定）。
 */
export async function prepareCompareFor(
  target: SubmissionTarget,
  beforeVersionId: string,
  afterVersionId: string,
): Promise<{ beforeFile: string; afterFile: string }> {
  const [beforeHtml, afterHtml] = await Promise.all([
    target.pointer.restore(beforeVersionId),
    target.pointer.restore(afterVersionId),
  ]);
  // 临时对比文件（用完即删、可随时重建）——不值原子写，直接落
  await Promise.all([
    fs.writeFile(target.compareTmp.before, beforeHtml, 'utf-8'),
    fs.writeFile(target.compareTmp.after, afterHtml, 'utf-8'),
  ]);
  return { beforeFile: basename(target.compareTmp.before), afterFile: basename(target.compareTmp.after) };
}

/** 删两个对比临时文件（幂等：不存在不报错）。 */
export async function cleanupCompareFor(target: SubmissionTarget): Promise<void> {
  await Promise.all([
    fs.rm(target.compareTmp.before, { force: true }),
    fs.rm(target.compareTmp.after, { force: true }),
  ]);
}

// ── deck-facing 适配器（artifactId → deckTarget，旧签名/行为不变：落点 deckPath、名 .compare-*.html）──

export async function prepareCompare(
  artifactId: string,
  beforeVersionId: string,
  afterVersionId: string,
): Promise<{ beforeFile: string; afterFile: string }> {
  return prepareCompareFor(await deckTarget(artifactId), beforeVersionId, afterVersionId);
}

export async function cleanupCompare(artifactId: string): Promise<void> {
  return cleanupCompareFor(await deckTarget(artifactId));
}
