/**
 * skill.install 链路 smoke（§七 验收 5 核心，离线）：
 *
 * 用本地 git 仓库当"远程源"（不依赖网络），验证：
 *  1. probeSkillFromGithub：浅 clone + 定位 SKILL.md（根 / skills/<x>/）+ 解析 frontmatter
 *  2. skill.install 独立执行器：重新 clone → 复制进 ~/.oru/skills/<id>/ → 写 .oru-skill.json → 注册表扫到
 *  3. 引导卡路径（skillSubdir 留空、commit 留空）：安装时自动定位 SKILL.md，照样装上
 *  4. 拒绝重装：已注册的 id 再装 → failed
 *
 * 不依赖网络（git clone 走本地路径），不调真 Claude。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import simpleGit from 'simple-git';

import type { ServerEvent } from '@shared/protocol';
import { probeSkillFromGithub } from '../../electron/main/skills/installer';
import { runProposalStandalone } from '../../electron/main/proposals/standaloneExec';
import { buildSkillInstallProposal } from '../../electron/main/proposals/makePluginProposal';
import { getSkill, removeSkillFromRegistry } from '../../electron/main/skills/registry';
import { skillDir } from '../../electron/main/runtime/paths';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

/** 造一个本地 git 仓库当远程源；SKILL.md 落在 subdir（''=根）。返回仓库路径。 */
async function makeRemoteRepo(name: string, subdir: string, frontmatterName: string): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), `oru-skill-remote-${name}-`));
  const skillRoot = subdir ? join(root, subdir) : root;
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(
    join(skillRoot, 'SKILL.md'),
    `---\nname: ${frontmatterName}\ndescription: 测试用 deck skill ${frontmatterName}\n---\n# ${frontmatterName}\n正文`,
    'utf-8',
  );
  // 附一个资源文件，验证整目录被复制
  await fs.writeFile(join(skillRoot, 'theme.css'), '.slide{}', 'utf-8');
  const git = simpleGit({ baseDir: root });
  await git.init();
  await git.addConfig('user.email', 'smoke@oru.test');
  await git.addConfig('user.name', 'smoke');
  await git.add('.');
  await git.commit('init');
  return root;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

async function main() {
  const events: ServerEvent[] = [];
  const broadcast = (ev: ServerEvent) => events.push(ev);
  const conversationId = 'cnv_skill_install';

  // ── case 1：根 SKILL.md，走 probe（agent 工具路径）──
  const remoteRoot = await makeRemoteRepo('root', '', 'html-ppt');
  const probe = await probeSkillFromGithub(remoteRoot, 'html-ppt-skill');
  assert(probe.skillId === 'html-ppt-skill', 'probe.skillId 用 preferredId');
  assert(probe.skillSubdir === '', 'probe 定位到根 SKILL.md（subdir 空）');
  assert(probe.manifest.name === 'html-ppt', 'probe 解析 frontmatter name');
  assert(!!probe.manifest.description, 'probe 解析 frontmatter description');
  await fs.rm(probe.tmpCloneDir, { recursive: true, force: true }).catch(() => {});

  const prop1 = buildSkillInstallProposal({
    conversationId,
    title: '装 html-ppt',
    description: 'd',
    skillId: probe.skillId,
    skillManifest: probe.manifest,
    source: probe.source,
    skillSubdir: probe.skillSubdir,
  });
  await runProposalStandalone(prop1, broadcast);
  assert(prop1.status === 'executed', 'case1 安装 executed', prop1.failureMessage);
  assert(!!getSkill('html-ppt-skill'), 'case1 注册表扫到 html-ppt-skill');
  assert(await exists(join(skillDir('html-ppt-skill'), 'SKILL.md')), 'case1 SKILL.md 落盘');
  assert(await exists(join(skillDir('html-ppt-skill'), 'theme.css')), 'case1 资源文件一并复制');
  assert(await exists(join(skillDir('html-ppt-skill'), '.oru-skill.json')), 'case1 写 .oru-skill.json');
  assert(!(await exists(join(skillDir('html-ppt-skill'), '.git'))), 'case1 不带 .git');

  // ── case 2：引导卡路径——subdir 空 + commit 空，安装时自动定位 SKILL.md ──
  const remoteRoot2 = await makeRemoteRepo('catalog', '', 'frontend-slides');
  const prop2 = buildSkillInstallProposal({
    conversationId,
    title: '装 frontend-slides',
    description: 'd',
    skillId: 'frontend-slides',
    skillManifest: { name: 'frontend-slides', description: '清单卡片占位描述' },
    source: { type: 'github', url: remoteRoot2, commit: '' }, // commit 空 = 用 HEAD
    skillSubdir: '', // 空 = 安装时自动定位
  });
  await runProposalStandalone(prop2, broadcast);
  assert(prop2.status === 'executed', 'case2 引导卡路径安装 executed', prop2.failureMessage);
  assert(!!getSkill('frontend-slides'), 'case2 注册表扫到 frontend-slides');

  // ── case 3：skills/<x>/ 子目录布局 ──
  const remoteRoot3 = await makeRemoteRepo('subdir', 'skills/fancy', 'fancy-deck');
  const probe3 = await probeSkillFromGithub(remoteRoot3);
  assert(probe3.skillSubdir === 'skills/fancy', 'case3 probe 定位到 skills/fancy');
  assert(probe3.skillId === 'fancy', 'case3 skillId = 子目录末段');
  await fs.rm(probe3.tmpCloneDir, { recursive: true, force: true }).catch(() => {});
  const prop3 = buildSkillInstallProposal({
    conversationId,
    title: '装 fancy',
    description: 'd',
    skillId: probe3.skillId,
    skillManifest: probe3.manifest,
    source: probe3.source,
    skillSubdir: probe3.skillSubdir,
  });
  await runProposalStandalone(prop3, broadcast);
  assert(prop3.status === 'executed', 'case3 子目录 skill 安装 executed', prop3.failureMessage);
  assert(await exists(join(skillDir('fancy'), 'SKILL.md')), 'case3 子目录 SKILL.md 提到 skill 根');

  // ── case 4：拒绝重装 ──
  const propDup = buildSkillInstallProposal({
    conversationId,
    title: '重装 html-ppt',
    description: 'd',
    skillId: 'html-ppt-skill',
    skillManifest: { name: 'html-ppt', description: 'x' },
    source: { type: 'github', url: remoteRoot, commit: '' },
    skillSubdir: '',
  });
  await runProposalStandalone(propDup, broadcast);
  assert(propDup.status === 'failed', 'case4 已装的 id 重装 → failed');
  assert((propDup.failureMessage ?? '').includes('已安装'), 'case4 失败原因是已安装');

  // ── case 5：并发同 skillId 安装——按 skillId 串行化，一个成功一个被挡，不撞写同一目录 ──
  const remoteRoot5 = await makeRemoteRepo('concur', '', 'concur-deck');
  const mkProp = () =>
    buildSkillInstallProposal({
      conversationId,
      title: '并发装 concur',
      description: 'd',
      skillId: 'concur-skill',
      skillManifest: { name: 'concur-deck', description: 'x' },
      source: { type: 'github', url: remoteRoot5, commit: '' },
      skillSubdir: '',
    });
  const [pa, pb] = [mkProp(), mkProp()];
  await Promise.all([runProposalStandalone(pa, broadcast), runProposalStandalone(pb, broadcast)]);
  const statuses = [pa.status, pb.status].sort();
  assert(statuses[0] === 'executed' && statuses[1] === 'failed', 'case5 并发同 skillId：恰一个 executed 一个 failed', statuses.join(','));
  const blocked = [pa, pb].find((p) => p.status === 'failed');
  assert((blocked?.failureMessage ?? '').includes('正在安装中'), 'case5 被挡的那个原因是"正在安装中"');
  assert(!!getSkill('concur-skill'), 'case5 成功的那个已注册');
  removeSkillFromRegistry('concur-skill');

  // ── chip / 广播 ──
  const statusEvents = events.filter((e) => e.type === 'proposal.statusChanged');
  assert(statusEvents.length >= 4, '每次安装都广播 proposal.statusChanged');
  const skillsStateEvents = events.filter((e) => e.type === 'skills.state');
  assert(skillsStateEvents.length >= 1, '安装后广播 skills.state');

  // 清理注册表（隔离后续）
  removeSkillFromRegistry('html-ppt-skill');
  removeSkillFromRegistry('frontend-slides');
  removeSkillFromRegistry('fancy');

  const failed = RESULTS.filter((r) => !r.ok);
  console.log('');
  console.log(`Total: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.error(` - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke fatal:', e);
  process.exit(1);
});
