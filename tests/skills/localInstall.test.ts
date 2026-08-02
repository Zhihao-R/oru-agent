/**
 * 从本地文件夹装 skill（probeSkillFromLocal + performSkillInstall 的 local 分支，经独立执行器驱动）。
 *
 * 起因：installer 原只支持 source.type='github'。用户从聊天/网盘下载的 skill 是本地文件夹，
 * 没有 GitHub URL，Oru 只能 bash cp 进 ~/.oru/skills/——绕过热注册，运行期看不见（要重启）。
 * 补一条本地安装路径：走同一 proposal 审批门 + upsert + 广播，装完即热。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerEvent } from '@shared/protocol';

const ORU_DIR = join(tmpdir(), `oru-test-localinstall-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const SKILLS_DIR = join(ORU_DIR, 'skills');
const SRC_ROOT = join(tmpdir(), `oru-test-localsrc-${Date.now()}`);

/** 造一个"下载下来的"本地 skill 文件夹（可带子目录 / 可放进 skills/<x>/） */
async function writeLocalSkill(
  root: string,
  opts: { name: string; description?: string; withGit?: boolean; subPath?: string } = {
    name: 'draw-ascii-tarot',
  },
): Promise<string> {
  const skillRoot = opts.subPath ? join(root, opts.subPath) : root;
  await fs.mkdir(skillRoot, { recursive: true });
  const desc = opts.description ?? `A tarot skill named ${opts.name}`;
  await fs.writeFile(
    join(skillRoot, 'SKILL.md'),
    `---\nname: ${opts.name}\ndescription: ${desc}\n---\n\n# ${opts.name}\n`,
    'utf-8',
  );
  await fs.mkdir(join(skillRoot, 'scripts'), { recursive: true });
  await fs.writeFile(join(skillRoot, 'scripts', 'draw.mjs'), 'export const x = 1;\n', 'utf-8');
  if (opts.withGit) {
    await fs.mkdir(join(skillRoot, '.git'), { recursive: true });
    await fs.writeFile(join(skillRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
  }
  return skillRoot;
}

async function makeInstallProposal(skillId: string, srcPath: string, subdir = '') {
  const { buildSkillInstallProposal } = await import(
    '../../electron/main/proposals/makePluginProposal'
  );
  return buildSkillInstallProposal({
    conversationId: 'conv-1',
    title: `装 ${skillId}`,
    description: 'local install',
    skillId,
    skillManifest: { name: skillId, description: 'd' },
    source: { type: 'local', path: srcPath },
    skillSubdir: subdir,
  });
}

describe('probeSkillFromLocal', () => {
  afterEach(async () => {
    await fs.rm(SRC_ROOT, { recursive: true, force: true });
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('根目录有 SKILL.md：skillId=文件夹名，source=local，subdir 为空', async () => {
    const { probeSkillFromLocal } = await import('../../electron/main/skills/installer');
    await writeLocalSkill(SRC_ROOT, { name: 'draw-ascii-tarot' });

    const probe = await probeSkillFromLocal(SRC_ROOT);

    expect(probe.skillId).toBe(basename(SRC_ROOT));
    expect(probe.manifest.name).toBe('draw-ascii-tarot');
    expect(probe.manifest.description).toContain('tarot');
    expect(probe.source).toEqual({ type: 'local', path: SRC_ROOT });
    expect(probe.skillSubdir).toBe('');
  });

  it('SKILL.md 在 skills/<x>/ 子目录：skillId=子目录名，source.path 指到该子目录', async () => {
    const { probeSkillFromLocal } = await import('../../electron/main/skills/installer');
    await writeLocalSkill(SRC_ROOT, { name: 'foo', subPath: 'skills/foo' });

    const probe = await probeSkillFromLocal(SRC_ROOT);

    expect(probe.skillId).toBe('foo');
    expect(probe.skillSubdir).toBe(join('skills', 'foo'));
    expect(probe.source).toEqual({ type: 'local', path: join(SRC_ROOT, 'skills', 'foo') });
  });

  it('preferredId 覆盖推导出的 id', async () => {
    const { probeSkillFromLocal } = await import('../../electron/main/skills/installer');
    await writeLocalSkill(SRC_ROOT, { name: 'draw-ascii-tarot' });
    const probe = await probeSkillFromLocal(SRC_ROOT, 'pinned-id');
    expect(probe.skillId).toBe('pinned-id');
  });

  it('缺 SKILL.md → 抛错', async () => {
    const { probeSkillFromLocal } = await import('../../electron/main/skills/installer');
    await fs.mkdir(SRC_ROOT, { recursive: true });
    await expect(probeSkillFromLocal(SRC_ROOT)).rejects.toThrow(/SKILL\.md/);
  });

  it('SKILL.md 缺 description → 抛错', async () => {
    const { probeSkillFromLocal } = await import('../../electron/main/skills/installer');
    await fs.mkdir(SRC_ROOT, { recursive: true });
    await fs.writeFile(join(SRC_ROOT, 'SKILL.md'), `---\nname: x\n---\n# x\n`, 'utf-8');
    await expect(probeSkillFromLocal(SRC_ROOT)).rejects.toThrow(/description/);
  });
});

describe('skill.install 独立执行器 — local 分支', () => {
  beforeEach(async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const reg = await import('../../electron/main/skills/registry');
    reg.__resetForTest();
  });
  afterEach(async () => {
    await fs.rm(SKILLS_DIR, { recursive: true, force: true });
    await fs.rm(SRC_ROOT, { recursive: true, force: true });
    const reg = await import('../../electron/main/skills/registry');
    reg.__resetForTest();
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('成功：拷进 ~/.oru/skills/<id>/、写 sidecar、注册表 upsert、proposal executed、广播', async () => {
    const { runProposalStandalone } = await import('../../electron/main/proposals/standaloneExec');
    const { getSkill } = await import('../../electron/main/skills/registry');
    const skillRoot = await writeLocalSkill(SRC_ROOT, { name: 'draw-ascii-tarot' });
    const proposal = await makeInstallProposal('draw-ascii-tarot', skillRoot);
    const events: ServerEvent[] = [];
    const broadcast = vi.fn((e: ServerEvent) => events.push(e));

    await runProposalStandalone(proposal, broadcast);

    expect(proposal.status).toBe('executed');
    const dest = join(SKILLS_DIR, 'draw-ascii-tarot');
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'scripts', 'draw.mjs'))).toBe(true);
    const sidecar = JSON.parse(await fs.readFile(join(dest, '.oru-skill.json'), 'utf-8'));
    expect(sidecar.enabled).toBe(true);
    expect(sidecar.source).toEqual({ type: 'local', path: skillRoot });
    // 注册表立即可查（装完即热，无需重启）
    expect(getSkill('draw-ascii-tarot')?.source).toBe('standalone');
    // 广播了 skills 状态
    expect(events.some((e) => e.type === 'skills.state')).toBe(true);
  });

  it('不污染用户源目录：copy 后 dest 无 .git，源 .git 原封不动', async () => {
    const { runProposalStandalone } = await import('../../electron/main/proposals/standaloneExec');
    const skillRoot = await writeLocalSkill(SRC_ROOT, { name: 'with-git', withGit: true });
    const proposal = await makeInstallProposal('with-git', skillRoot);

    await runProposalStandalone(proposal, vi.fn());

    const dest = join(SKILLS_DIR, 'with-git');
    expect(existsSync(join(dest, '.git'))).toBe(false); // dest 不带 .git
    expect(existsSync(join(skillRoot, '.git', 'HEAD'))).toBe(true); // 源不动
  });

  it('源目录在执行时已不存在 → failed', async () => {
    const { runProposalStandalone } = await import('../../electron/main/proposals/standaloneExec');
    const proposal = await makeInstallProposal('ghost', join(SRC_ROOT, 'nope'));
    await runProposalStandalone(proposal, vi.fn());
    expect(proposal.status).toBe('failed');
  });

  it('重装（目标已存在）→ failed', async () => {
    const { runProposalStandalone } = await import('../../electron/main/proposals/standaloneExec');
    const skillRoot = await writeLocalSkill(SRC_ROOT, { name: 'dup' });
    await fs.mkdir(join(SKILLS_DIR, 'dup'), { recursive: true });
    const proposal = await makeInstallProposal('dup', skillRoot);
    await runProposalStandalone(proposal, vi.fn());
    expect(proposal.status).toBe('failed');
  });
});

function basename(p: string): string {
  return p.split('/').pop()!;
}
