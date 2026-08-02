/**
 * skills 目录 watcher：外部拖入 / 删除 skill 文件夹 → 增量对账 + 广播，运行期即时生效（免重启）。
 * 生命周期照 ProjectWatch 范式：watch + debounce 成对清理，回调捕获创建时实例（迟到事件丢弃）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerEvent } from '@shared/protocol';

const ORU_DIR = join(tmpdir(), `oru-test-skillwatch-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const SKILLS_DIR = join(ORU_DIR, 'skills');

async function writeSkill(name: string): Promise<void> {
  const dir = join(SKILLS_DIR, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: desc ${name}\n---\n# ${name}\n`,
    'utf-8',
  );
}

describe('startSkillsWatch / stopSkillsWatch', () => {
  beforeEach(async () => {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const reg = await import('../../electron/main/skills/registry');
    reg.__resetForTest();
  });
  afterEach(async () => {
    const w = await import('../../electron/main/skills/watcher');
    w.stopSkillsWatch();
    await fs.rm(SKILLS_DIR, { recursive: true, force: true });
    const reg = await import('../../electron/main/skills/registry');
    reg.__resetForTest();
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('start 幂等；stop 后不再监听', async () => {
    const { startSkillsWatch, stopSkillsWatch, __isWatchingForTest } = await import(
      '../../electron/main/skills/watcher'
    );
    startSkillsWatch(vi.fn());
    startSkillsWatch(vi.fn()); // 第二次应 no-op
    expect(__isWatchingForTest()).toBe(true);
    stopSkillsWatch();
    expect(__isWatchingForTest()).toBe(false);
  });

  it('未 start 时 stop 安全（no-op）', async () => {
    const { stopSkillsWatch, __isWatchingForTest } = await import(
      '../../electron/main/skills/watcher'
    );
    expect(() => stopSkillsWatch()).not.toThrow();
    expect(__isWatchingForTest()).toBe(false);
  });

  it('外部拷入新 skill → 广播 skills.state 含它（免重启即时生效）', async () => {
    const { startSkillsWatch } = await import('../../electron/main/skills/watcher');
    const { getSkill } = await import('../../electron/main/skills/registry');
    const events: ServerEvent[] = [];
    startSkillsWatch((e: ServerEvent) => events.push(e));

    await writeSkill('tarot-dropped');

    await vi.waitFor(
      () => {
        const hit = events.find(
          (e) => e.type === 'skills.state' && e.skills.some((s) => s.id === 'tarot-dropped'),
        );
        expect(hit).toBeTruthy();
      },
      { timeout: 4000, interval: 100 },
    );
    expect(getSkill('tarot-dropped')?.source).toBe('standalone');
  });
});
