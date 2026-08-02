/**
 * openCsv —— 表格视图打开 CSV 的 main 侧入口：超限判定 + 内容回传。
 *
 * 上限 100,000 数据行（PRD「不做大数据」）：超限只回前 1,000 行只读预览，
 * "2 秒呈现"由头部流式解析保证（行数计到上限+1 即短路，不必读完）；
 * 总行数需读完全文件，countTotalRows 给调用方异步补报，首屏不等它。
 * 超限判定在打开时和每次外部刷新时重做（AI 加工可能让一张表跨过线）。
 */
import { createReadStream, promises as fs } from 'node:fs';
import Papa from 'papaparse';
import { parseCsv } from '@shared/csv';
import { PREVIEW_ROWS, ROW_LIMIT } from '@shared/tableLimits';
import { ensureWithinProject } from '../fs/projectPath';
import { readTextFile } from '../fs/textFile';

const PREVIEW_RECORDS = PREVIEW_ROWS + 1; // 表头 + 前 PREVIEW_ROWS 数据行
// 小于此值直接整读内存解析（编码探测/规范判定齐全）；超过走流式（按 UTF-8 读，
// GBK 的超大文件不做探测——超限本就只读预览，编码确认留给"交给 AI"动线
const IN_MEMORY_MAX_BYTES = 16 * 1024 * 1024;

export type OpenCsvResult =
  | {
      overLimit: false;
      content: string;
      encodingSafe: boolean;
      encoding: 'utf-8' | 'gbk';
      mtimeMs: number;
      sha256: string;
    }
  | {
      overLimit: true;
      previewRows: string[][];
      mtimeMs: number;
      /** 全量流式计数（数据行）——调用方异步跑完后补报 table.rowCount */
      countTotalRows: () => Promise<number>;
    };

/** 流式逐记录解析；onRecord 返回 false 即中止（已拿到判定所需的头部）。 */
function streamRecords(abs: string, onRecord: (record: string[]) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(abs, { encoding: 'utf-8' });
    Papa.parse<string[]>(stream as unknown as Papa.LocalFile, {
      header: false,
      delimiter: ',',
      quoteChar: '"',
      escapeChar: '"',
      dynamicTyping: false,
      skipEmptyLines: false,
      step: (res, parser) => {
        if (!onRecord(res.data)) parser.abort();
      },
      complete: () => resolve(),
      error: (e: Error) => reject(e),
    });
  });
}

/** 全量计数：记录数（剥尾部换行造成的单个空字段尾记录，与 parseCsv 口径一致）减表头。 */
async function countDataRows(abs: string): Promise<number> {
  let count = 0;
  let lastWasEmpty = false;
  await streamRecords(abs, (record) => {
    count++;
    lastWasEmpty = record.length === 1 && record[0] === '';
    return true;
  });
  if (lastWasEmpty) count--;
  return Math.max(0, count - 1);
}

export async function openCsv(
  projectRoot: string,
  relPath: string,
  opts?: { inMemoryMaxBytes?: number },
): Promise<OpenCsvResult> {
  const inMemoryMax = opts?.inMemoryMaxBytes ?? IN_MEMORY_MAX_BYTES;
  const abs = await ensureWithinProject(projectRoot, relPath);
  const stat = await fs.stat(abs);
  const mtimeMs = Math.floor(stat.mtimeMs);

  if (stat.size <= inMemoryMax) {
    const r = await readTextFile(projectRoot, relPath);
    const { headers, rows } = parseCsv(r.content);
    if (rows.length <= ROW_LIMIT) {
      return {
        overLimit: false,
        content: r.content,
        encodingSafe: r.encodingSafe,
        encoding: r.encoding,
        mtimeMs: r.mtimeMs,
        sha256: r.sha256,
      };
    }
    return {
      overLimit: true,
      previewRows: [headers, ...rows.slice(0, PREVIEW_RECORDS - 1)],
      mtimeMs,
      countTotalRows: async () => rows.length,
    };
  }

  // 流式路径：收集头部记录，行数过线即短路
  const preview: string[][] = [];
  let records = 0;
  let aborted = false;
  await streamRecords(abs, (record) => {
    records++;
    if (preview.length < PREVIEW_RECORDS) preview.push(record);
    if (records > ROW_LIMIT + 1) {
      aborted = true;
      return false;
    }
    return true;
  });
  if (aborted) {
    return { overLimit: true, previewRows: preview, mtimeMs, countTotalRows: () => countDataRows(abs) };
  }
  // 行数没过线（宽行大文件）：回到整读路径拿完整内容与规范判定
  const r = await readTextFile(projectRoot, relPath);
  return {
    overLimit: false,
    content: r.content,
    encodingSafe: r.encodingSafe,
    encoding: r.encoding,
    mtimeMs: r.mtimeMs,
    sha256: r.sha256,
  };
}
