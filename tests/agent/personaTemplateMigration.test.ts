/**
 * 家目录 CLAUDE.md 模板句演进 + 存量迁移（表驱动）。缘由与分界见 prompts/twinPersona.ts 的常量注释。
 *
 * 三态：命中旧句原文 → 替换；旧句被编辑过（整行不再精确匹配）→ 不动；重复跑 → 幂等。
 * 另验新建 agent 模板正确（含新句、不含已废描述）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TWIN_PERSONA,
  DIRECT_EDIT_LINE,
  ENGINEERING_DISPATCH_LINE,
  PROJECT_HINT_LINE,
} from '../../electron/main/prompts/twinPersona';
import { migratePersonaTemplateLines } from '../../electron/main/agent/store/home';

const OLD_HINT_LINE =
  '- 用户当前关注哪个项目，会通过每轮 user prompt 前的 `[当前用户正在查看项目: ...]` hint 告诉你。';
const OLD_EDIT_LINE =
  '- 改代码：你不能直接 Write/Edit/Bash。改代码必须先调 `propose_action` 工具递交提案，由 Oru 派子 agent 执行。';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'oru-persona-migration-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function writeClaudeMd(content: string): Promise<string> {
  const p = join(home, 'CLAUDE.md');
  await fs.writeFile(p, content, 'utf-8');
  return p;
}

describe('migratePersonaTemplateLines（存量模板句迁移）', () => {
  it('命中旧项目 hint 句 → 整行替换为新句，其余内容原样', async () => {
    const p = await writeClaudeMd(`# Oru 人格档案\n\n${OLD_HINT_LINE}\n\n## 价值观载体\n用户自己加的话\n`);
    await migratePersonaTemplateLines(home);
    const after = await fs.readFile(p, 'utf-8');
    expect(after).toContain(PROJECT_HINT_LINE);
    expect(after).not.toContain(OLD_HINT_LINE);
    expect(after).toContain('用户自己加的话');
  });

  it('命中旧"不能直接 Write/Edit/Bash"句 → 拆成「小改直连」+「工程改动派工」两行', async () => {
    const p = await writeClaudeMd(`## 项目工作的方式\n${OLD_EDIT_LINE}\n  - 提案的 description 必须是自然语言。\n`);
    await migratePersonaTemplateLines(home);
    const after = await fs.readFile(p, 'utf-8');
    expect(after).toContain(`${DIRECT_EDIT_LINE}\n${ENGINEERING_DISPATCH_LINE}`);
    expect(after).not.toContain(OLD_EDIT_LINE);
    // 从属子项原样保留，且落在派工那行之后（它们讲的是「开提案时怎么写」）
    expect(after.indexOf('  - 提案的 description')).toBeGreaterThan(after.indexOf(ENGINEERING_DISPATCH_LINE));
  });

  it('两条旧句同时存在 → 一次跑全部替换', async () => {
    const p = await writeClaudeMd(`${OLD_HINT_LINE}\n${OLD_EDIT_LINE}\n`);
    await migratePersonaTemplateLines(home);
    const after = await fs.readFile(p, 'utf-8');
    expect(after).toContain(PROJECT_HINT_LINE);
    expect(after).toContain(DIRECT_EDIT_LINE);
    expect(after).toContain(ENGINEERING_DISPATCH_LINE);
  });

  it('旧句被编辑过（整行不再精确匹配）→ 文件一字节不动', async () => {
    const edited = `# Oru 人格档案\n\n- 改代码：我自己改过这句。\n- 用户当前关注哪个项目，我也改过。\n`;
    const p = await writeClaudeMd(edited);
    await migratePersonaTemplateLines(home);
    expect(await fs.readFile(p, 'utf-8')).toBe(edited);
  });

  it('幂等：重复跑结果不变', async () => {
    const p = await writeClaudeMd(`前文\n${OLD_HINT_LINE}\n${OLD_EDIT_LINE}\n后文\n`);
    await migratePersonaTemplateLines(home);
    const once = await fs.readFile(p, 'utf-8');
    await migratePersonaTemplateLines(home);
    expect(await fs.readFile(p, 'utf-8')).toBe(once);
  });

  it('CLAUDE.md 不存在 → 不抛错', async () => {
    await expect(migratePersonaTemplateLines(home)).resolves.toBeUndefined();
  });
});

describe('新建 agent 模板', () => {
  it('模板含新句、不含已废描述', () => {
    expect(DEFAULT_TWIN_PERSONA).toContain(PROJECT_HINT_LINE);
    expect(DEFAULT_TWIN_PERSONA).toContain(DIRECT_EDIT_LINE);
    expect(DEFAULT_TWIN_PERSONA).toContain(ENGINEERING_DISPATCH_LINE);
    expect(DEFAULT_TWIN_PERSONA).not.toContain('[当前用户正在查看项目');
    expect(DEFAULT_TWIN_PERSONA).not.toContain('你不能直接 Write/Edit/Bash');
  });

  it('派工那行的子项紧跟其后（拆行后层级不错位）', () => {
    const dispatchAt = DEFAULT_TWIN_PERSONA.indexOf(ENGINEERING_DISPATCH_LINE);
    const childAt = DEFAULT_TWIN_PERSONA.indexOf('  - 提案的 description');
    expect(dispatchAt).toBeGreaterThan(DEFAULT_TWIN_PERSONA.indexOf(DIRECT_EDIT_LINE));
    expect(childAt).toBe(dispatchAt + ENGINEERING_DISPATCH_LINE.length + 1);
  });
});
