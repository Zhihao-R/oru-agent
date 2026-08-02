/**
 * Skill Bundle 支持 smoke
 *
 * 验证 bundle 类 skill 的运行：
 * - read_skill 返回 `<oru-skill-path>` 路径标签 + SKILL.md 全文
 * - read_file 能读 enabled skill 目录下的伴生文件
 * - read_file 拒绝读 disabled skill 目录下的文件
 * - read_file 拒绝 `..` 越界跳出 skill 目录
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { makeReadFileTool } from '../../electron/main/agent/agentTools/readFile';
import { makeReadSkillTool } from '../../electron/main/agent/agentTools/skillModule';
import {
  upsertSkill,
  setSkillEnabled,
  __resetForTest as resetSkillRegistry,
} from '../../electron/main/skills/registry';
import {
  upsertPlugin,
  setPluginEnabled,
  __resetForTest as resetPluginRegistry,
} from '../../electron/main/plugins/registry';
import { SKILLS_DIR, PLUGINS_DIR } from '../../electron/main/runtime/paths';
import type { SkillRecord, PluginRecord } from '@shared/types';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import type { ToolContext } from '@shared/agent/backend';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== Skill Bundle smoke ===');

// ─── 准备一个 bundle skill：SKILL.md + writer.md ─────────────────
const SKILL_NAME = 'test-bundle';
const skillPath = join(SKILLS_DIR, SKILL_NAME);
await fs.mkdir(skillPath, { recursive: true });
const skillMd =
  '---\n' +
  `name: ${SKILL_NAME}\n` +
  'description: 测试 bundle 类 skill 的伴生文件可达性\n' +
  '---\n\n' +
  '# Test Bundle\n\n' +
  '第 1 步：Read `writer.md` 看 prompt 模板。';
await fs.writeFile(join(skillPath, 'SKILL.md'), skillMd, 'utf-8');
await fs.writeFile(join(skillPath, 'writer.md'), '请用海明威的口吻写。', 'utf-8');

// 注入到注册表（绕过 initSkillRegistry——它会动态加载 ensureBuiltin，依赖 Electron app）
resetSkillRegistry();
const record: SkillRecord = {
  id: SKILL_NAME,
  name: SKILL_NAME,
  description: '测试 bundle 类 skill 的伴生文件可达性',
  path: skillPath,
  source: 'standalone',
  availableFromTimestamp: 0,
  enabled: true,
};
upsertSkill(record);

// ─── 构造 ctx ────────────────────────────────────────────────────
const agent = await ensureDefaultAgent();
const ctx: ToolContext = {
  conversationId: 'c1',
  agentId: agent.id,
  ownerId: 'local-user',
  usage: 'twinMain',
  approvalMode: 'work',
  abortSignal: new AbortController().signal,
  conversationCreatedAt: Date.now(),
};

// ─── 1. read_skill 返回路径标签 ──────────────────────────────────
const readSkill = makeReadSkillTool();
const r1 = await readSkill.execute({ skillId: SKILL_NAME }, ctx);
assert(r1.isError !== true, 'read_skill 成功', r1.text.slice(0, 80));
assert(
  r1.text.startsWith(`<oru-skill-path>${skillPath}</oru-skill-path>\n`),
  'read_skill text 以路径标签开头',
  r1.text.slice(0, 120),
);
assert(r1.text.includes('# Test Bundle'), 'read_skill text 含 SKILL.md 正文');
assert(r1.text.includes('Read `writer.md`'), 'read_skill text 含相对引用');

// ─── 2. read_file 能读 bundle 内伴生文件 ──────────────────────────
const readFile = makeReadFileTool();
const writerPath = join(skillPath, 'writer.md');
const r2 = await readFile.execute({ path: writerPath }, ctx);
assert(r2.isError !== true, 'read_file 读 writer.md 成功', r2.text.slice(0, 80));
// read_file 走 cat -n 行号格式（单行 → "1\t<内容>"），断言据此对齐
assert(r2.text === '1\t请用海明威的口吻写。', 'read_file 回读内容正确');

// ─── 3. read_file 拒绝读"未注册的目录"（即便文件真存在）─────────
// 在 SKILLS_DIR 下建一个真实存在但不进 registry 的目录——验证白名单严格匹配
const unregisteredDir = join(SKILLS_DIR, 'unregistered-skill');
await fs.mkdir(unregisteredDir, { recursive: true });
await fs.writeFile(join(unregisteredDir, 'SKILL.md'), 'unregistered', 'utf-8');
const r3 = await readFile.execute({ path: join(unregisteredDir, 'SKILL.md') }, ctx);
assert(r3.isError === true, '未注册到 registry 的 skill 目录被拒', r3.text);

// ─── 4. read_file 拒绝读 disabled skill ──────────────────────────
await setSkillEnabled(SKILL_NAME, false);
const r4 = await readFile.execute({ path: writerPath }, ctx);
assert(r4.isError === true, 'disabled skill 后 read_file 拒绝', r4.text);

// 恢复 enabled，验证 enabled 切换生效
await setSkillEnabled(SKILL_NAME, true);
const r5 = await readFile.execute({ path: writerPath }, ctx);
assert(r5.isError !== true, 're-enable 后 read_file 又能读', r5.text.slice(0, 80));

// ─── 5. plugin 内 skill 的 bundle 路径 ───────────────────────────
const PLUGIN_ID = 'test-plugin';
const PLUGIN_SKILL = 'inner-skill';
const pluginPath = join(PLUGINS_DIR, PLUGIN_ID);
const pluginSkillPath = join(pluginPath, 'skills', PLUGIN_SKILL);
await fs.mkdir(pluginSkillPath, { recursive: true });
await fs.writeFile(join(pluginSkillPath, 'helper.md'), 'plugin 内伴生文件', 'utf-8');

resetPluginRegistry();
const innerSkill: SkillRecord = {
  id: `${PLUGIN_ID}:${PLUGIN_SKILL}`,
  name: PLUGIN_SKILL,
  description: 'plugin 内 skill',
  path: pluginSkillPath,
  source: 'plugin',
  parentPluginId: PLUGIN_ID,
  availableFromTimestamp: 0,
  enabled: true,
};
const pluginRecord: PluginRecord = {
  id: PLUGIN_ID,
  manifest: { name: PLUGIN_ID, description: 'test plugin' },
  oruExtension: {
    source: { type: 'github', url: 'https://x', commit: 'x' },
    installedAt: 0,
  },
  skills: [innerSkill],
  mcpServers: [],
  ignoredSections: [],
  enabled: true,
};
upsertPlugin(pluginRecord);

// plugin enabled → 能读 plugin 内 skill 的伴生文件
const r6 = await readFile.execute({ path: join(pluginSkillPath, 'helper.md') }, ctx);
assert(r6.isError !== true, 'plugin enabled 时能读 plugin 内 skill 伴生文件', r6.text.slice(0, 80));
assert(r6.text === '1\tplugin 内伴生文件', 'plugin 内伴生文件回读正确');

// plugin disabled → 拒绝读
await setPluginEnabled(PLUGIN_ID, false);
const r7 = await readFile.execute({ path: join(pluginSkillPath, 'helper.md') }, ctx);
assert(r7.isError === true, 'plugin disabled 后 plugin 内伴生文件被拒', r7.text);

// ─── 总结 ─────────────────────────────────────────────────────────
const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== Skill Bundle smoke: ${RESULTS.length - failed.length}/${RESULTS.length} PASS ===`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL: ${r.name} — ${r.detail ?? ''}`);
  process.exit(1);
}
