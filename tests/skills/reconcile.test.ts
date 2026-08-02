/**
 * reconcileSkillRegistry 增量对账回归。
 *
 * 现状：注册表只在 App 启动 initSkillRegistry 扫一次盘；手动拷进 ~/.oru/skills/ 的目录
 * 运行期看不见（要重启）。reconcile 让 watcher / 面板打开都能增量对账。
 *
 * 关键不变量（防 clear+rebuild 坑）：只增新目录、只删消失目录，**已注册条目不重读**——
 * 自创 skill 的 availableFromTimestamp（回声防护，仅内存）不能被对账重置为 0。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ORU_DIR 隔离：必须先于任何 import runtime/paths 的模块求值（SKILLS_DIR 在 import 期定死）
const ORU_DIR = join(tmpdir(), `oru-test-reconcile-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const SKILLS_DIR = join(ORU_DIR, 'skills');

/** 写一个合法 skill 目录（含 frontmatter name+description 的 SKILL.md） */
async function writeSkill(name: string, description = `desc of ${name}`): Promise<void> {
  const dir = join(SKILLS_DIR, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf-8',
  );
}

describe('reconcileSkillRegistry 增量对账', () => {
  beforeEach(async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const reg = await import('../../electron/main/skills/registry');
    reg.__resetForTest();
  });

  afterEach(async () => {
    // 清空 skills 目录（各用例互不干扰）
    await fs.rm(SKILLS_DIR, { recursive: true, force: true });
    const reg = await import('../../electron/main/skills/registry');
    reg.__resetForTest();
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('新拷入的目录：对账后 added 含它、注册表可查、source=standalone', async () => {
    const { reconcileSkillRegistry, getSkill } = await import('../../electron/main/skills/registry');
    await writeSkill('draw-ascii-tarot');

    const { added, removed } = await reconcileSkillRegistry();

    expect(added).toContain('draw-ascii-tarot');
    expect(removed).toEqual([]);
    const rec = getSkill('draw-ascii-tarot');
    expect(rec?.source).toBe('standalone');
    expect(rec?.enabled).toBe(true);
    // 手动拷入 = 非自创，立即可见（availableFromTimestamp=0）
    expect(rec?.availableFromTimestamp).toBe(0);
  });

  it('半拷贝（目录在但没 SKILL.md）：先跳过，SKILL.md 落齐后再对账才注册', async () => {
    const { reconcileSkillRegistry, getSkill } = await import('../../electron/main/skills/registry');
    const dir = join(SKILLS_DIR, 'half-copied');
    await fs.mkdir(dir, { recursive: true });

    const first = await reconcileSkillRegistry();
    expect(first.added).not.toContain('half-copied');
    expect(getSkill('half-copied')).toBeUndefined();

    // SKILL.md 后到（模拟 cp -r 内容陆续写入）
    await fs.writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: half-copied\ndescription: now valid\n---\n# x\n`,
      'utf-8',
    );
    const second = await reconcileSkillRegistry();
    expect(second.added).toContain('half-copied');
    expect(getSkill('half-copied')?.description).toBe('now valid');
  });

  it('目录消失：对账后 removed 含它、注册表清除', async () => {
    const { reconcileSkillRegistry, getSkill } = await import('../../electron/main/skills/registry');
    await writeSkill('gone-soon');
    await reconcileSkillRegistry();
    expect(getSkill('gone-soon')).toBeDefined();

    await fs.rm(join(SKILLS_DIR, 'gone-soon'), { recursive: true, force: true });
    const { added, removed } = await reconcileSkillRegistry();

    expect(removed).toContain('gone-soon');
    expect(added).toEqual([]);
    expect(getSkill('gone-soon')).toBeUndefined();
  });

  it('回声防护保持：已注册的自创条目对账后 availableFromTimestamp 不被重置为 0', async () => {
    const { reconcileSkillRegistry, getSkill, upsertSkill } = await import(
      '../../electron/main/skills/registry'
    );
    // 盘上有目录（自创 skill 已落盘），注册表里带未来时间戳（本会话不可见的回声防护）
    await writeSkill('self-authored');
    const future = 9_999_999_999_999;
    upsertSkill({
      id: 'self-authored',
      name: 'self-authored',
      description: 'desc of self-authored',
      path: join(SKILLS_DIR, 'self-authored'),
      source: 'standalone',
      availableFromTimestamp: future,
      enabled: true,
    });

    const { added, removed } = await reconcileSkillRegistry();

    expect(added).toEqual([]); // 已在表里，不重复 add
    expect(removed).toEqual([]);
    // 关键：不被 clear+rebuild 重置成 0，否则回声防护被击穿
    expect(getSkill('self-authored')?.availableFromTimestamp).toBe(future);
  });

  it('内置清单命中的目录标 source=builtin', async () => {
    const { reconcileSkillRegistry, getSkill } = await import('../../electron/main/skills/registry');
    await writeSkill('writing-oru-skills'); // 内置清单唯一项（见 ensureBuiltin.getBuiltinSkillNames）
    await reconcileSkillRegistry();
    expect(getSkill('writing-oru-skills')?.source).toBe('builtin');
  });

  it('单飞：并发两次对账共享同一 Promise，新 skill 只注册一次（不重复 add）', async () => {
    const { reconcileSkillRegistry, getSkill } = await import('../../electron/main/skills/registry');
    await writeSkill('concurrent-drop');

    // 模拟 watcher flush 与面板打开(skill.list) 同一 tick 并发触发
    const [a, b] = await Promise.all([reconcileSkillRegistry(), reconcileSkillRegistry()]);

    expect(a).toBe(b); // 同一 Promise 结果对象——证明单飞合流
    expect(a.added.filter((id) => id === 'concurrent-drop')).toHaveLength(1);
    expect(getSkill('concurrent-drop')).toBeDefined();
  });

  it('幂等：无盘面变化时第二次对账 added/removed 均空', async () => {
    const { reconcileSkillRegistry } = await import('../../electron/main/skills/registry');
    await writeSkill('stable');
    await reconcileSkillRegistry();
    const again = await reconcileSkillRegistry();
    expect(again.added).toEqual([]);
    expect(again.removed).toEqual([]);
  });
});
