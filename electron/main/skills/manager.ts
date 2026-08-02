/**
 * Skill manager（Skill 模块 v1 加分项）—— skill.create / skill.patch 的纯执行实现。
 *
 * 关键点：
 * - 写盘后 availableFromTimestamp = Date.now()，回声防护：本会话内 resolveSkill
 *   返回 null，下次会话才可见（避免分身刚自创 skill 立即被自己用，导致回声）
 * - patch unique 校验：跟内置 Edit 同款行为——oldString 必须 0 或 >1 匹配时拒绝
 *   （工具 execute 阶段已检查；perform 这里再校验一次防御 race）
 * - patch.target='skill' 改 ~/.oru/skills/<name>/SKILL.md
 * - patch.target='plugin-manifest' 改 ~/.oru/plugins/<id>/.oru-plugin.json 的 activationDescription
 *
 * UI 卡上用户改 description 字段的覆盖逻辑：v1 简化——proposal payload 已经定型，
 * perform 直接读 proposal.skillDescription / proposal.targetDescription。如果 UI 改了
 * description，应该由前端在 proposal.execute 时附带 descriptionOverride（第 6 期 UI 优化时接）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type {
  SkillCreateProposal,
  SkillPatchProposal,
} from '@shared/types';
import { SKILLS_DIR, skillDir, pluginDir } from '../runtime/paths';
import { safeWriteAsync } from '../fs/safeWrite';
import { loadSkillFromDir, upsertSkill, getSkill } from './registry';
import { getPlugin } from '../plugins/registry';
import { failure } from '../proposals/failure';

/**
 * 纯执行：新建一个已审批的 skill。只做事——成功返回建了什么，失败抛错。
 * 不碰 proposal.status、不发 chip（收尾统一在调用方，见 proposals/outcomeChip）。
 */
export async function performSkillCreate(
  proposal: SkillCreateProposal,
): Promise<{ skillId: string; name: string }> {
  const dir = skillDir(proposal.skillName);
  // 拒绝重名
  const dirExists = await fs.stat(dir).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw failure('skillStatFailed', { error: e.message });
      return false;
    },
  );
  if (dirExists) throw failure('skillNameTaken', { name: proposal.skillName });

  // 写 SKILL.md（如果用户在卡上改了 description，frontmatter 也要同步——简化：用户改 description
  // 由前端在 proposal.execute 时把 newSkillMd 一起带过来；v1 第 6 期暂不接，用 proposal 原始 md）
  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'SKILL.md'), proposal.skillMd, 'utf-8');
    // 写可选 scripts/
    if (proposal.scripts && proposal.scripts.length > 0) {
      const scriptsDir = join(dir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      for (const s of proposal.scripts) {
        const fullPath = join(scriptsDir, s.relPath);
        await fs.mkdir(join(fullPath, '..'), { recursive: true });
        await fs.writeFile(fullPath, s.content, 'utf-8');
      }
    }
  } catch (e) {
    // 回滚：rm 半写的目录
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw failure('skillWriteFailed', { error: (e as Error).message });
  }

  // 加载到注册表，覆盖 availableFromTimestamp 为 Date.now()（回声防护起点）
  try {
    const record = await loadSkillFromDir(dir, 'standalone');
    if (!record) throw new Error('加载新建 skill 失败：frontmatter 解析未通过');
    record.availableFromTimestamp = Date.now();
    upsertSkill(record);
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw failure('skillRegisterFailed', { error: (e as Error).message });
  }

  return { skillId: proposal.skillName, name: proposal.skillName };
}

/**
 * 纯执行：改一个已审批的 skill / plugin manifest。成功返回改了谁，失败抛错。
 * 不碰 proposal.status、不发 chip（收尾统一在调用方，见 proposals/outcomeChip）。
 */
export async function performSkillPatch(proposal: SkillPatchProposal): Promise<{ name: string }> {
  // 解析目标文件
  let targetPath: string;
  if (proposal.target === 'skill') {
    const skill = getSkill(proposal.name);
    if (!skill) throw failure('skillNotFound', { name: proposal.name });
    if (skill.source === 'plugin') {
      throw failure('skillInPluginNotPatchable');
    }
    targetPath = join(skill.path, 'SKILL.md');
  } else {
    // plugin-manifest
    const plugin = getPlugin(proposal.name);
    if (!plugin) throw failure('pluginNotFound', { id: proposal.name });
    targetPath = join(pluginDir(plugin.id), '.oru-plugin.json');
  }

  let text: string;
  try {
    text = await fs.readFile(targetPath, 'utf-8');
  } catch (e) {
    throw failure('patchTargetReadFailed', { error: (e as Error).message });
  }

  // 再次 unique 校验（防御 race）
  const count = countOccurrences(text, proposal.oldString);
  if (count === 0) throw failure('patchOldStringMissing');
  if (count > 1) throw failure('patchOldStringAmbiguous', { count: String(count) });

  const newText = text.replace(proposal.oldString, proposal.newString);
  try {
    // 改写既有文件走原子写内核（tmp+rename），崩溃不留半截 SKILL.md / manifest
    await safeWriteAsync(targetPath, newText);
  } catch (e) {
    throw failure('skillWriteFailed', { error: (e as Error).message });
  }

  // 重新加载到注册表（重置 availableFromTimestamp）
  try {
    if (proposal.target === 'skill') {
      const skill = getSkill(proposal.name);
      if (skill) {
        const fresh = await loadSkillFromDir(skill.path, 'standalone');
        if (fresh) {
          fresh.availableFromTimestamp = Date.now();
          upsertSkill(fresh);
        }
      }
    } else {
      // plugin-manifest：触发 plugin 重新加载
      const { loadPluginFromDir, upsertPlugin } = await import('../plugins/registry');
      const fresh = await loadPluginFromDir(proposal.name, pluginDir(proposal.name));
      if (fresh) upsertPlugin(fresh);
    }
  } catch (e) {
    console.warn(`[oru.skills] patch 后重载失败:`, e);
  }

  return { name: proposal.name };
}

/**
 * 统计某文本中 oldString 出现次数（unique 校验用）。
 * 零依赖、零正则——直接 indexOf 滚一遍，跟 Edit 工具同款行为。
 */
export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

/**
 * 构造 patch 的 diffPreview——展示 oldString 前后各 200 字符的上下文。
 */
export function buildDiffPreview(text: string, oldString: string, newString: string): string {
  const idx = text.indexOf(oldString);
  if (idx < 0) return '';
  const before = text.slice(Math.max(0, idx - 200), idx);
  const after = text.slice(idx + oldString.length, idx + oldString.length + 200);
  return `${before}[- ${oldString}]\n[+ ${newString}]${after}`;
}

/**
 * 从 SKILL.md frontmatter 抽 description（创建审批卡用户可改的初始值）。
 */
export function extractSkillDescription(skillMd: string): string {
  try {
    const fm = matter(skillMd).data as Record<string, unknown>;
    return typeof fm.description === 'string' ? fm.description : '';
  } catch {
    return '';
  }
}

// chip 写入收敛到 chipWriter.ts
