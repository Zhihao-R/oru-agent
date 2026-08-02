/**
 * Frontmatter 读写 helpers
 *
 * 包 gray-matter，加上 ~/.oru/memory/ 路径沙箱。
 * 跟 fs/md.ts 平行：md.ts 是给项目文件用的（沙箱在项目根），
 * 这个是给记忆文件用的（沙箱在 ~/.oru/memory/）。
 */
import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import matter from 'gray-matter';
import { safeWrite } from './safeWrite';

export type Frontmatter = Record<string, unknown>;

export type ParsedFile = {
  data: Frontmatter;
  content: string;
};

/** 解析一段含 frontmatter 的 markdown 文本 */
export function parseFrontmatter(text: string): ParsedFile {
  const m = matter(text);
  return { data: m.data ?? {}, content: m.content ?? '' };
}

/** 把 frontmatter + 正文拼回一段 markdown 文本 */
export function stringifyFrontmatter(data: Frontmatter, content: string): string {
  // data 为空时不写 ---，对我们 OK
  if (Object.keys(data).length === 0) return content;
  // 关键：传「文件对象」而非裸字符串。matter.stringify(裸字符串, data) 会先把字符串 parse 一遍找 frontmatter——
  // 当 content（已是剥离过 frontmatter 的正文）以 `---` 块开头时，会把它误当 frontmatter：key:value 行被静默
  // 吸进元数据、正文里消失；散文则产出再也 parse 不动的坏档。传 {content} 走 file-object 分支，
  // content 原样、绝不二次解析（与 gray-matter 自身 YAML 引擎同源，输出逐字节不变）。见 frontmatter 回归测试。
  return matter.stringify({ content }, data);
}

/**
 * 路径沙箱——确保 target 在 root 之下。返回归一化的绝对路径。
 * 给记忆系统用：root 是 ~/.oru/memory/<ownerId>/，target 是任意子路径。
 */
export function ensureWithinRoot(root: string, target: string): string {
  const rootAbs = resolve(root);
  const abs = isAbsolute(target) ? resolve(target) : resolve(rootAbs, target);
  const rel = relative(rootAbs, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path ${target} escapes memory root ${root}`);
  }
  return abs;
}

/** 读 markdown 文件（带 frontmatter）。文件不存在时返回 null。 */
export async function readMarkdownFile(absPath: string): Promise<ParsedFile | null> {
  try {
    const text = await fs.readFile(absPath, 'utf-8');
    return parseFrontmatter(text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** 写 markdown 文件（带 frontmatter）。原子落盘（safeWrite：tmp→rename，含 mkdir），防崩溃截断。 */
export async function writeMarkdownFile(
  absPath: string,
  data: Frontmatter,
  content: string,
): Promise<void> {
  safeWrite(absPath, stringifyFrontmatter(data, content), 'LF');
}
