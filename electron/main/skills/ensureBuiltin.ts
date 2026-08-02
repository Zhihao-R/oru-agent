/**
 * Skill 模块（v1 加分项）：首次启动把内置 skill 解包到 ~/.oru/skills/。
 *
 * 规则：
 * - 源目录：dev = `<项目根>/resources/builtin-skills/`；prod = `process.resourcesPath/builtin-skills/`
 * - 目标目录：`~/.oru/skills/<name>/`
 * - 存在则跳过——用户在拓展页改过的不覆盖（PRD/Tech Design 已知约束）
 *
 * 启动期在 initSkillRegistry 之前调用——这样 init 扫盘能扫到新解包的 skill。
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS_DIR } from '../runtime/paths';
import { copyDir } from '../runtime/fsCopy';

function resolveBuiltinSourceDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'builtin-skills');
  }
  // dev fallback：当前文件在 out/main/skills/ 编译后；用 import.meta.url 反推项目根
  // out/main/skills/ensureBuiltin.js → ../../../resources/builtin-skills/
  const here = dirname(fileURLToPath(import.meta.url));
  // dev 路径：electron-vite 把 main 编译到 out/main/，所以 ../../resources/builtin-skills
  // 兜底先看 ../../../resources/，再看 ../../resources/，再看 ../../../../resources/
  for (const rel of ['../../resources/builtin-skills', '../../../resources/builtin-skills']) {
    const candidate = join(here, rel);
    if (existsSync(candidate)) return candidate;
  }
  // 还找不到就给项目根原始路径——dev 期最终兜底（直接跑 tsx 时）
  return join(here, '../../resources/builtin-skills');
}

export async function ensureBuiltinSkills(): Promise<{ copied: number; skipped: number }> {
  const sourceRoot = resolveBuiltinSourceDir();
  if (!existsSync(sourceRoot)) {
    // 没有内置 skill 目录——可能是开发期空跑或打包未带，跳过
    return { copied: 0, skipped: 0 };
  }
  await fs.mkdir(SKILLS_DIR, { recursive: true });

  let copied = 0;
  let skipped = 0;
  const entries = await fs.readdir(sourceRoot);
  for (const name of entries) {
    const srcDir = join(sourceRoot, name);
    const dstDir = join(SKILLS_DIR, name);
    try {
      const stat = await fs.stat(srcDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(dstDir)) {
      skipped += 1;
      continue;
    }
    try {
      await copyDir(srcDir, dstDir);
      copied += 1;
    } catch (e) {
      console.warn(`[oru.builtinSkills] 复制 ${name} 失败:`, e);
    }
  }
  return { copied, skipped };
}

/**
 * 给内置 skill 一个特殊 source 标识：扫到的 skill 如果其 path 起始于 SKILLS_DIR
 * 且 folder name 命中"内置清单"则 source='builtin'，否则 'standalone'。
 *
 * 注意：v1 简化——内置 skill 装在跟独立 skill 同目录，不刻意区分；区分仅用于 UI 分组展示。
 * resolveBuiltinNames 返回内置清单（写死，与 resources/builtin-skills/ 子目录对齐）。
 */
export function getBuiltinSkillNames(): string[] {
  // v1 仅一个：writing-oru-skills
  return ['writing-oru-skills'];
}
