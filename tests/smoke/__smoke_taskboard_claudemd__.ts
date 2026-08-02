/**
 * PR-A.5 smoke：项目 CLAUDE.md 注入（C2 后由 project-claude-md 能力承载，
 * 单一实现是 loadProjectClaudeMdSection——本 smoke 直接测它，另验第一层不再含该段）。
 *
 * case：
 * 1. activeProjectId=null → 空串
 * 2. 有 project + 有 CLAUDE.md → 含 marker + 标头
 * 3. 有 project + 无 CLAUDE.md → 不抛错，空串
 * 5. 有 project + CLAUDE.md 全空白 → 空串（!body.trim() 判空）
 * 4. 过期 projectId（不在 projects.json 里）→ 不抛错（getProject PROJECT_NOT_FOUND 被吞）
 * 6. buildStableSystemContext 产物不含 CLAUDE.md 标头（C2：第一层不随项目变）
 *
 * 不打 ws、不打网络。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildStableSystemContext,
  loadProjectClaudeMdSection,
} from '../../electron/main/agent/stableSystemContext';
import { addProject } from '../../electron/main/projects/store';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

const HEADING = '## 当前项目说明（CLAUDE.md）';
const MARKER = '__pra5_smoke_marker_unique_string__';

async function mkProjectDir(suffix: string, withClaudeMd: boolean): Promise<string> {
  const dir = join(tmpdir(), `oru-pra5-smoke-${Date.now()}-${suffix}`);
  await fs.mkdir(dir, { recursive: true });
  if (withClaudeMd) {
    await fs.writeFile(join(dir, 'CLAUDE.md'), `# fake project\n\n${MARKER}\n`, 'utf-8');
  }
  return dir;
}

async function main() {
  // ─── case 1: activeProjectId=null ───
  {
    const s = await loadProjectClaudeMdSection(null);
    assert(s === '', 'activeProjectId=null 时返回空串');
  }

  // ─── case 2: 有 project + 有 CLAUDE.md ───
  {
    const dir = await mkProjectDir('with-md', true);
    const project = await addProject(dir);
    const s = await loadProjectClaudeMdSection(project.id);
    assert(s.includes(HEADING), 'case 2 含 CLAUDE.md 标头');
    assert(s.includes(MARKER), 'case 2 含 CLAUDE.md 文件正文 marker');
  }

  // ─── case 3: 有 project + 无 CLAUDE.md ───
  {
    const dir = await mkProjectDir('no-md', false);
    const project = await addProject(dir);
    const s = await loadProjectClaudeMdSection(project.id);
    assert(s === '', 'case 3 无 CLAUDE.md 文件时返回空串');
  }

  // ─── case 5: 有 project + CLAUDE.md 文件存在但全空白 ───
  // （review 反馈：实现用 !body.trim() 判空，确保不显标头）
  {
    const dir = join(tmpdir(), `oru-pra5-smoke-${Date.now()}-empty-md`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'CLAUDE.md'), '   \n\n  \t\n', 'utf-8');
    const project = await addProject(dir);
    const s = await loadProjectClaudeMdSection(project.id);
    assert(s === '', 'case 5 文件全空白时返回空串');
  }

  // ─── case 4: 过期 projectId（不存在于 projects.json） ───
  {
    let threw = false;
    let s = '';
    try {
      s = await loadProjectClaudeMdSection('proj_does_not_exist');
    } catch {
      threw = true;
    }
    assert(!threw, 'case 4 过期 projectId 不抛错');
    assert(s === '', 'case 4 过期 projectId 返回空串');
  }

  // ─── case 6: 第一层不随项目变——产物不含 CLAUDE.md 标头 ───
  {
    const ctx = await buildStableSystemContext({
      agentSystemPromptAppend: 'fake-agent-prompt',
      memoryBPathInstruction: 'fake-memory-rule',
      mcpPrompt: '',
    });
    assert(!ctx.includes(HEADING), 'case 6 第一层不含 CLAUDE.md 标头（能力侧承载）');
    assert(ctx.includes('fake-agent-prompt'), 'case 6 其他段不受影响');
  }

  // ─── 汇总 ───
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
