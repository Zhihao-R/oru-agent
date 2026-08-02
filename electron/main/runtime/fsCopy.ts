/**
 * 递归复制目录（零依赖、无 electron 耦合）。
 *
 * ensureBuiltin（解包内置 skill）与 skills/installer（装外部 skill）共用——放 runtime/ 而非
 * ensureBuiltin.ts，是因为后者 import 了 electron `app`，在纯 node 上下文（tsx smoke）里 import
 * 会炸；copyDir 本身只用 node:fs，单独成文谁都能用。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** 递归复制 src → dst（跳过 symlink / 特殊类型）。 */
export async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}
