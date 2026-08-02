/**
 * provenance —— 来源反查：CSV 是不是某脚本的产物，看同目录脚本头部的输出声明。
 *
 * 来源的两个稳定事实（生成自谁、写出谁）记在伴生脚本头部注释里（脚本规范要求 agent
 * 这么写）；不往 CSV 里塞说明行污染数据，也不另立看不见的元数据文件。
 * 多脚本声明写出同一文件 → 全部返回，视图如实显示歧义。纯读无缓存。
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { TableProvenance } from '@shared/protocol';

const SCRIPT_EXT_RE = /\.(py|js|ts|sh)$/i;
/** 声明只认脚本头部（前 N 行）——scriptOutputs（覆盖确认/执行后校验）共用同一口径 */
export const SCRIPT_HEAD_LINES = 10;
export const OUT_DECLARATION_RE = /^\s*(?:#|\/\/)\s*写出[：:]\s*(.+?)\s*$/;
const SRC_RE = /^\s*(?:#|\/\/)\s*(?:来源|源文件)[：:]\s*(.+?)\s*$/;

export async function scanProvenance(
  projectRoot: string,
  relCsvPath: string,
): Promise<TableProvenance[]> {
  const dir = dirname(relCsvPath);
  const absDir = dir === '.' ? projectRoot : join(projectRoot, dir);
  const csvName = basename(relCsvPath);
  const names = await fs.readdir(absDir).catch(() => [] as string[]);
  const hits: TableProvenance[] = [];
  for (const name of names.filter((n) => SCRIPT_EXT_RE.test(n)).sort()) {
    let head: string;
    try {
      const fh = await fs.open(join(absDir, name), 'r');
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        head = buf.subarray(0, bytesRead).toString('utf-8');
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    const lines = head.split('\n').slice(0, SCRIPT_HEAD_LINES);
    let declaresOut = false;
    let source: string | null = null;
    for (const line of lines) {
      const out = OUT_DECLARATION_RE.exec(line);
      if (out && [csvName, relCsvPath, `./${csvName}`].includes(out[1]!)) declaresOut = true;
      const src = SRC_RE.exec(line);
      if (src && source === null) source = src[1]!;
    }
    if (declaresOut) hits.push({ script: name, source });
  }
  return hits;
}
