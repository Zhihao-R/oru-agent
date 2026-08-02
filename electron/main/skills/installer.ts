/**
 * 从外部源装独立 skill（通用能力，不为 deck skill 单开后门）。
 *
 * - probeSkillFromGithub（propose 阶段）：浅 clone → 找 SKILL.md（repo 根，或 skills/<x>/）→ 解析
 *   frontmatter name/description → 构 SkillInstallProposal payload。不动正式目录。
 * - performSkillInstall（执行阶段）：按 source.commit 重新 clone → 把 skill 子目录复制进
 *   ~/.oru/skills/<skillId>/ → 写 .oru-skill.json（enabled）→ 注册表 upsert（source='standalone'，
 *   id = 裸文件夹名）。纯执行：成败以返回值 / 抛错表达，状态迁移与 chip 由调用方统一收尾。
 *
 * 与 plugin.install 区别：只认 SKILL.md、不要求 .claude-plugin/plugin.json；浅 clone 走共用
 * sourceFetch 原语。
 */
import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import matter from 'gray-matter';
import type { SkillInstallProposal, SkillInstallSource } from '@shared/types';
import { SKILLS_DIR, skillDir } from '../runtime/paths';
import { shallowCloneToTemp, checkoutCommit } from '../plugins/sourceFetch';
import { copyDir } from '../runtime/fsCopy';
import { safeWriteAsync } from '../fs/safeWrite';
import { loadSkillFromDir, upsertSkill, getSkill } from './registry';
import { failure } from '../proposals/failure';

export type SkillProbeResult = {
  skillId: string;
  /** GitHub 探测的临时 clone 目录；本地安装无临时目录，为空串 */
  tmpCloneDir: string;
  skillSubdir: string;
  manifest: { name: string; description: string };
  source: SkillInstallSource;
};

/** 从 URL 推 repo 名（裸文件夹名兜底）：去掉 .git、取末段。 */
function repoNameFromUrl(url: string): string {
  return url.replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop() || 'skill';
}

/** 在 clone 根里定位 SKILL.md：先看根，再扫 skills/<x>/SKILL.md（取第一个）。返回相对目录（'' = 根）。 */
export async function findSkillDir(root: string): Promise<string | null> {
  try {
    await fs.access(join(root, 'SKILL.md'));
    return '';
  } catch {
    // 不在根，往下找 skills/
  }
  try {
    const entries = await fs.readdir(join(root, 'skills'));
    for (const name of entries.sort()) {
      try {
        await fs.access(join(root, 'skills', name, 'SKILL.md'));
        return join('skills', name);
      } catch {
        // 跳过非 skill 子目录
      }
    }
  } catch {
    // 无 skills/ 目录
  }
  return null;
}

/**
 * propose 阶段探测：浅 clone + 解析 SKILL.md frontmatter。失败抛错（调用方 catch 报给 LLM）。
 * @param preferredId 引导清单装默认项时传入，让 skillId 钉到清单约定的裸名（如 html-ppt-skill）。
 */
export async function probeSkillFromGithub(
  githubUrl: string,
  preferredId?: string,
): Promise<SkillProbeResult> {
  const { dir: tmpRoot, commit } = await shallowCloneToTemp(githubUrl, 'oru-skill-probe-');
  try {
    const subdir = await findSkillDir(tmpRoot);
    if (subdir === null) {
      throw new Error('repo 里找不到 SKILL.md（根目录或 skills/<x>/ 下都没有）');
    }
    const skillRoot = subdir ? join(tmpRoot, subdir) : tmpRoot;
    const raw = await fs.readFile(join(skillRoot, 'SKILL.md'), 'utf-8');
    const fm = matter(raw).data as Record<string, unknown>;
    const description = typeof fm.description === 'string' ? fm.description : '';
    if (!description) throw new Error('SKILL.md frontmatter 缺 description 字段');
    const name = typeof fm.name === 'string' ? fm.name : repoNameFromUrl(githubUrl);
    // skillId = 注册表 id = 裸文件夹名。优先用清单约定 id；否则子目录末段；否则 repo 名。
    const skillId = preferredId ?? (subdir ? subdir.split('/').pop()! : repoNameFromUrl(githubUrl));
    return {
      skillId,
      tmpCloneDir: tmpRoot,
      skillSubdir: subdir,
      manifest: { name, description },
      source: { type: 'github', url: githubUrl, commit },
    };
  } catch (e) {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * propose 阶段探测本地文件夹：定位 SKILL.md（根或 skills/<x>/）+ 解析 frontmatter，不做任何拷贝。
 * source.path 直接指到 SKILL.md 所在目录——execute 阶段照此 copy，无需再定位子目录。
 * @param preferredId 缺省用 SKILL.md 所在目录名（子目录末段 / 根用文件夹名）。
 */
export async function probeSkillFromLocal(
  localPath: string,
  preferredId?: string,
): Promise<SkillProbeResult> {
  const subdir = await findSkillDir(localPath);
  if (subdir === null) {
    throw new Error('目录里找不到 SKILL.md（根目录或 skills/<x>/ 下都没有）');
  }
  const skillRoot = subdir ? join(localPath, subdir) : localPath;
  const raw = await fs.readFile(join(skillRoot, 'SKILL.md'), 'utf-8');
  const fm = matter(raw).data as Record<string, unknown>;
  const description = typeof fm.description === 'string' ? fm.description : '';
  if (!description) throw new Error('SKILL.md frontmatter 缺 description 字段');
  const derivedId = subdir ? subdir.split('/').pop()! : basename(localPath);
  const name = typeof fm.name === 'string' ? fm.name : derivedId;
  return {
    skillId: preferredId ?? derivedId,
    tmpCloneDir: '',
    skillSubdir: subdir,
    manifest: { name, description },
    source: { type: 'local', path: skillRoot },
  };
}

/**
 * 正在安装的 skillId 集——上层只按 proposalId 去重，但同一 skillId 可能有两个 proposal
 * 同时执行（模型连发两次 / 信任模式自动跑）；它们会同时通过 getSkill/fs.stat 检查、撞写同一 dest
 * 目录，且失败回滚的 `fs.rm(dest)` 会删掉另一个刚装好的文件。按 skillId 串行化堵住这个窗口。
 */
const installingSkillIds = new Set<string>();

/**
 * 纯执行：装一个已审批的 skill.install proposal。只做事——成功返回装成什么，失败抛错。
 * 不碰 proposal.status（终态由调用方统一回报）、不发 chip（唯一落点在 proposals/outcomeChip）。
 */
export async function performSkillInstall(
  proposal: SkillInstallProposal,
): Promise<{ skillId: string; name: string }> {
  if (installingSkillIds.has(proposal.skillId)) {
    throw failure('skillInstallInFlight', { id: proposal.skillId });
  }
  installingSkillIds.add(proposal.skillId);
  try {
    return await runInstall();
  } finally {
    installingSkillIds.delete(proposal.skillId);
  }

  async function runInstall(): Promise<{ skillId: string; name: string }> {
  const dest = skillDir(proposal.skillId);

  // 拒绝重装：已注册或目标目录已存在
  if (getSkill(proposal.skillId)) throw failure('skillAlreadyInstalled', { id: proposal.skillId });
  const destExists = await fs.stat(dest).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw failure('skillStatFailed', { error: e.message });
      return false;
    },
  );
  if (destExists) throw failure('skillDestExists', { id: proposal.skillId });

  // 定位 skill 源目录：GitHub 重新 clone（不依赖 propose 时的 tmpCloneDir——重启可能已清），
  // 本地则直接用 source.path（探测时已指到 SKILL.md 所在目录）。tmpRoot 仅 GitHub 有、用完即删。
  let srcRoot: string;
  let tmpRoot: string | null = null;
  if (proposal.source.type === 'github') {
    const src = proposal.source;
    try {
      const cloned = await shallowCloneToTemp(src.url, 'oru-skill-install-');
      tmpRoot = cloned.dir;
      await checkoutCommit(tmpRoot, src.commit); // 锁定 commit（best-effort）
    } catch (e) {
      throw failure('skillCloneFailed', { error: (e as Error).message });
    }
    // skillSubdir 空（清单卡片不带）→ 安装时在仓库里自动定位 SKILL.md 所在目录
    let subdir = proposal.skillSubdir;
    if (!subdir) {
      const found = await findSkillDir(tmpRoot);
      if (found === null) {
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
        throw failure('skillMdNotFound');
      }
      subdir = found;
    }
    srcRoot = subdir ? join(tmpRoot, subdir) : tmpRoot;
  } else {
    // 本地文件夹：校验源仍在（用户可能装前删了），源本身绝不改动
    srcRoot = proposal.source.path;
    try {
      await fs.access(join(srcRoot, 'SKILL.md'));
    } catch {
      throw failure('skillSourceGone', { path: srcRoot });
    }
  }

  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    await copyDir(srcRoot, dest);
    // 去掉拷进来的 .git（GitHub clone / 本地带 git 的都可能有）——在 dest 上删，绝不碰用户源目录
    await fs.rm(join(dest, '.git'), { recursive: true, force: true }).catch(() => {});
    // 写 sidecar：enabled + 来源（跟 plugin 的 .oru-plugin.json 对齐）。走原子写内核（tmp+rename）——
    // 崩溃不留半截 JSON，否则下次启动 loadSkillFromDir 的 JSON.parse 抛错、已装 skill 从注册表消失。
    await safeWriteAsync(
      join(dest, '.oru-skill.json'),
      JSON.stringify({ enabled: true, source: proposal.source, installedAt: Date.now() }, null, 2),
    );
  } catch (e) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw failure('skillCopyFailed', { error: (e as Error).message });
  } finally {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  // 注册表 upsert（source='standalone'，id = 裸文件夹名）。装的 skill 立即可见（非自创，无回声问题）。
  try {
    const record = await loadSkillFromDir(dest, 'standalone');
    if (!record) throw new Error('SKILL.md frontmatter 解析未通过');
    upsertSkill(record);
  } catch (e) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw failure('skillRegisterFailed', { error: (e as Error).message });
  }

  return { skillId: proposal.skillId, name: proposal.skillManifest.name };
  }
}
