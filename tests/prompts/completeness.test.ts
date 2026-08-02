import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listPrompts } from '../../electron/main/prompts';

const PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../electron/main/prompts',
);

describe('prompts 完整性', () => {
  // 自动对账：prompts/ 下每个 prompt 文件都必须被登记。
  // 不维护手写 id 名单——名单本身就是会漂移的东西，正是要消灭的。
  // 这道不变量直接抓住「建了瘦文件却忘了加进 barrel」：文件数 ≠ 登记数就红。
  it('prompts/ 下每个 prompt 文件都进了清单', () => {
    // registry/index 是基建，不算注册 prompt。outputLanguage 已入注册表：
    // 它曾是第一层成员里唯一没走 definePrompt 的，面板与本枚举测试都看不见它。
    const NON_PROMPT_FILES = new Set(['registry.ts', 'index.ts']);
    const promptFiles = readdirSync(PROMPTS_DIR).filter(
      (f) => f.endsWith('.ts') && !NON_PROMPT_FILES.has(f),
    );
    expect(listPrompts().length).toBe(promptFiles.length);
  });

  it('每段都有非空 title 与 body', () => {
    for (const p of listPrompts()) {
      expect(p.title.length, `${p.id} 缺 title`).toBeGreaterThan(0);
      expect(p.body.length, `${p.id} 缺 body`).toBeGreaterThan(0);
    }
  });

  // 抽查关键 prompt 的标志性文本，确保「逐字搬运」没截断/没漏。
  // capture 这条同时验证 ${EPISODE_TYPE_PROMPT} 插值确实展开了（而非被内联成别的）。
  it('关键 prompt 文本搬运无截断（spot check）', () => {
    const byId = Object.fromEntries(listPrompts().map((p) => [p.id, p.body]));
    expect(byId['dream-system']).toContain('你只做六件事');
    expect(byId['cadence']).toContain('## 节奏');
    expect(byId['taskboard-stable']).toContain('只会被 @ 才介入');
    expect(byId['capture-system']).toContain('Episode 类型分类法'); // ${EPISODE_TYPE_PROMPT} 已展开
  });
});
