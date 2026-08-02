/**
 * importXlsx —— xlsx → CSV 导入编排（转换在 convertXlsx，纯函数；这里管落盘与冲突）。
 *
 * 核心立场（PRD 场景一）："改没改过"不靠任何账本记录，直接把新转换结果与现有 CSV
 * 逐字节比：一致 → 跳过写盘（mtime 不动）；不一致 → 弹「覆盖 / 另存 / 取消」，按文件粒度。
 *
 * 唯一触发点：xlsx 预览里的显式「转为可编辑 CSV」（renderer 发 table.importXlsx）。
 * xlsx 出现/外部改动不触发任何转换——xlsx 与生成的 CSV 各自独立，不做同步绑定。
 *
 * 并发与时序三防：
 *   - in-flight 去重：按钮连点/双击确认与按钮紧邻触发时复用进行中的转换，
 *     否则 T≠现有 CSV 时会双弹窗、连环产出 -2.csv/-3.csv；
 *   - TOCTOU：用户点「覆盖」执行时重读磁盘，与判定时快照不一致（弹窗挂起期间
 *     用户 ⌘S 落过盘）则按新快照重发冲突，不按陈旧判定直接写；
 *   - 原子性：全部 sheet 在内存转换成功后才批量落盘（safeWriteAsync 单文件原子，
 *     "先算后写"避免 sheet1 落了、sheet2 损坏的半截状态）。
 *
 * 回执语义：importXlsxFile 返回逐 sheet 结果（written/identical/conflict + targetPath），
 * 预览据此在无冲突时原地切换成 CSV 标签；冲突解决写盘成功另广播 table.importWritten。
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { newReqId } from '@shared/ids';
import type { TableImportSheetResult } from '@shared/protocol';
import type { Broadcast } from '../ws/server';
import { safeWriteAsync } from '../fs/safeWrite';
import { ensureWithinProject } from '../fs/projectPath';
import { convertXlsxToCsvSheets } from './convertXlsx';

/** importXlsxFile 的返回：逐 sheet 结果；转换失败/空簿为 failed（message 与 importFailed/Notice 广播同文） */
export type ImportOutcome = { sheets: TableImportSheetResult[] } | { failed: string };

type PendingConflict = {
  projectId: string;
  projectRoot: string;
  xlsxRelPath: string;
  targetRelPath: string;
  csv: string;
  /** 判定时现有 CSV 的字节哈希——「覆盖」执行前重读比对（TOCTOU） */
  snapshotSha256: string;
};

const inFlight = new Map<string, Promise<ImportOutcome>>(); // abs xlsx path → 进行中的导入
const pendingConflicts = new Map<string, PendingConflict>();

export function resetImportStateForTest(): void {
  inFlight.clear();
  pendingConflicts.clear();
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** sheet 名 → 文件名片段：文件系统非法字符替换为 -（exceljs 已禁 * ? : \ / [ ]，这里兜剩余平台差异） */
function sanitizeSheetName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
}

/** 目标文件名规划：单 sheet → 基名.csv；多 sheet → 基名-sheet名.csv；批内清洗撞名加序号。 */
function planTargetNames(xlsxRelPath: string, sheetNames: string[]): string[] {
  const dir = dirname(xlsxRelPath);
  const base = basename(xlsxRelPath).replace(/\.[^.]+$/, '');
  const inDir = (name: string): string => (dir === '.' ? name : join(dir, name));
  if (sheetNames.length === 1) return [inDir(`${base}.csv`)];
  const used = new Set<string>();
  return sheetNames.map((sheet) => {
    const stem = `${base}-${sanitizeSheetName(sheet)}`;
    let candidate = stem;
    for (let i = 2; used.has(candidate); i++) candidate = `${stem}-${i}`;
    used.add(candidate);
    return inDir(`${candidate}.csv`);
  });
}

async function readBytesOrNull(abs: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/** 导入一个 xlsx。in-flight 去重：进行中的同路径导入直接复用（并发调用拿到同一份结果）。 */
export function importXlsxFile(
  projectId: string,
  projectRoot: string,
  xlsxRelPath: string,
  broadcast: Broadcast,
): Promise<ImportOutcome> {
  const key = join(projectRoot, xlsxRelPath);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = doImport(projectId, projectRoot, xlsxRelPath, broadcast).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

async function doImport(
  projectId: string,
  projectRoot: string,
  xlsxRelPath: string,
  broadcast: Broadcast,
): Promise<ImportOutcome> {
  const xlsxAbs = await ensureWithinProject(projectRoot, xlsxRelPath);
  let sheets;
  try {
    sheets = await convertXlsxToCsvSheets(xlsxAbs);
  } catch (e) {
    const message = `无法转换 ${basename(xlsxRelPath)}：文件可能已加密或损坏（${e instanceof Error ? e.message : String(e)}）`;
    broadcast({
      type: 'table.importFailed',
      projectId,
      xlsxPath: xlsxRelPath,
      message,
    });
    return { failed: message };
  }
  if (sheets.length === 0) {
    const message = `${basename(xlsxRelPath)} 中没有发现数据，未产出 CSV`;
    broadcast({
      type: 'table.importNotice',
      projectId,
      xlsxPath: xlsxRelPath,
      message,
    });
    return { failed: message };
  }

  const targets = planTargetNames(xlsxRelPath, sheets.map((s) => s.name));
  const results: TableImportSheetResult[] = [];
  let wrote = false;
  for (let i = 0; i < sheets.length; i++) {
    const targetRel = targets[i]!;
    const targetAbs = await ensureWithinProject(projectRoot, targetRel);
    const csvBuf = Buffer.from(sheets[i]!.csv, 'utf-8');
    const existing = await readBytesOrNull(targetAbs);
    if (existing === null) {
      await safeWriteAsync(targetAbs, sheets[i]!.csv);
      wrote = true;
      results.push({ name: sheets[i]!.name, targetPath: targetRel, status: 'written' });
      continue;
    }
    if (existing.equals(csvBuf)) {
      results.push({ name: sheets[i]!.name, targetPath: targetRel, status: 'identical' });
      continue; // 一致：静默刷新，零写盘
    }
    // 不一致：谁的劳动都不该被冲掉——弹三选一，按文件粒度
    const conflictId = newReqId();
    pendingConflicts.set(conflictId, {
      projectId,
      projectRoot,
      xlsxRelPath,
      targetRelPath: targetRel,
      csv: sheets[i]!.csv,
      snapshotSha256: sha256(existing),
    });
    results.push({ name: sheets[i]!.name, targetPath: targetRel, status: 'conflict' });
    broadcast({
      type: 'table.importConflict',
      conflictId,
      projectId,
      xlsxPath: xlsxRelPath,
      targetPath: targetRel,
    });
  }

  // sheet 改名/删减提醒：命名模式扫描（基名-*.csv 存在但本次未产出），不引账本，歧义只到
  // 提示级。多→单也要提示（旧拆分文件同样被遗留）；纯数字后缀（基名-2.csv）跳过——
  // 那是「另存」的序号副本，不是 sheet 拆分产物
  {
    const dir = dirname(xlsxRelPath);
    const base = basename(xlsxRelPath).replace(/\.[^.]+$/, '');
    const absDir = dir === '.' ? projectRoot : join(projectRoot, dir);
    const targetSet = new Set(targets.map((t) => basename(t)));
    const stale = (await fs.readdir(absDir).catch(() => [] as string[]))
      .filter(
        (n) =>
          n.startsWith(`${base}-`) &&
          n.endsWith('.csv') &&
          !targetSet.has(n) &&
          !/^\d+$/.test(n.slice(base.length + 1, -4)),
      )
      .sort();
    if (stale.length > 0) {
      broadcast({
        type: 'table.importNotice',
        projectId,
        xlsxPath: xlsxRelPath,
        message: `上次拆出的 ${stale.join('、')} 本次未出现（sheet 可能改名），旧文件已保留不动`,
      });
    }
  }

  if (wrote) broadcast({ type: 'fs.changed', projectId });
  return { sheets: results };
}

export type ConflictResolution = {
  outcome: 'written' | 'savedAs' | 'cancelled' | 'reconflict';
  savedAsPath?: string;
};

export async function resolveImportConflict(
  conflictId: string,
  choice: 'overwrite' | 'saveAs' | 'cancel',
  broadcast: Broadcast,
): Promise<ConflictResolution> {
  const pending = pendingConflicts.get(conflictId);
  pendingConflicts.delete(conflictId);
  if (!pending) return { outcome: 'cancelled' }; // 过期/未知 id——按取消处理
  const { projectId, projectRoot, xlsxRelPath, targetRelPath, csv, snapshotSha256 } = pending;

  if (choice === 'cancel') return { outcome: 'cancelled' };

  if (choice === 'saveAs') {
    const stem = targetRelPath.replace(/\.csv$/, '');
    let candidate = '';
    for (let i = 2; ; i++) {
      candidate = `${stem}-${i}.csv`;
      const abs = await ensureWithinProject(projectRoot, candidate);
      if ((await readBytesOrNull(abs)) === null) {
        await safeWriteAsync(abs, csv);
        break;
      }
    }
    broadcast({ type: 'fs.changed', projectId });
    broadcast({ type: 'table.importWritten', projectId, xlsxPath: xlsxRelPath, targetPath: candidate });
    return { outcome: 'savedAs', savedAsPath: candidate };
  }

  // overwrite：执行时重读磁盘，防按陈旧判定直接写
  const targetAbs = await ensureWithinProject(projectRoot, targetRelPath);
  const current = await readBytesOrNull(targetAbs);
  if (current !== null && current.equals(Buffer.from(csv, 'utf-8'))) {
    // 挂起期间磁盘已变成转换结果——视为一致，零写盘；仍发 importWritten 让等待中的预览完成切换
    broadcast({ type: 'table.importWritten', projectId, xlsxPath: xlsxRelPath, targetPath: targetRelPath });
    return { outcome: 'written' };
  }
  if (current !== null && sha256(current) !== snapshotSha256) {
    // 挂起期间磁盘又被改（用户 ⌘S / 外部工具）——按新快照重发冲突，本次不写
    const newId = newReqId();
    pendingConflicts.set(newId, { ...pending, snapshotSha256: sha256(current) });
    broadcast({
      type: 'table.importConflict',
      conflictId: newId,
      projectId,
      xlsxPath: xlsxRelPath,
      targetPath: targetRelPath,
    });
    return { outcome: 'reconflict' };
  }
  await safeWriteAsync(targetAbs, csv);
  broadcast({ type: 'fs.changed', projectId });
  broadcast({ type: 'table.importWritten', projectId, xlsxPath: xlsxRelPath, targetPath: targetRelPath });
  return { outcome: 'written' };
}
