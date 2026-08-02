/**
 * scriptOutputs —— 解析 bash 命令引用的脚本文件，读取头部「写出：」输出声明。
 *
 * 与 provenance 同一份声明正则（脚本规范让 agent 在头部注释声明来源与输出）。
 * 诚实声明：静态判定"脚本以哪个文件为输出"不可能完备——这里只解析显式声明，
 * 用于覆盖确认卡与执行后 mtime 校验，是近似而非围栏。
 */
import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { OUT_DECLARATION_RE, SCRIPT_HEAD_LINES } from './provenance';

const SCRIPT_TOKEN_RE = /[^\s"'`;|&()<>]+\.(?:py|js|ts|sh)\b/gi;

/** 命令引用的脚本声明的输出文件（绝对路径，相对声明按 cwd 解析；去重）。 */
export async function declaredOutputs(command: string, cwd: string): Promise<string[]> {
  const outs = new Set<string>();
  for (const token of command.match(SCRIPT_TOKEN_RE) ?? []) {
    const scriptAbs = isAbsolute(token) ? token : join(cwd, token);
    let head: string;
    try {
      const fh = await fs.open(scriptAbs, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        head = buf.subarray(0, bytesRead).toString('utf-8');
      } finally {
        await fh.close();
      }
    } catch {
      continue; // 命中正则的 token 不一定是真实文件（如 URL 片段）——安静跳过
    }
    for (const line of head.split('\n').slice(0, SCRIPT_HEAD_LINES)) {
      const m = OUT_DECLARATION_RE.exec(line);
      if (m) outs.add(resolve(cwd, m[1]!));
    }
  }
  return [...outs];
}
