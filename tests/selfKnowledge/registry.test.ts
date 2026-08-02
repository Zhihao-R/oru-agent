/**
 * 自我认知知识库 registry 单测（techdoc §A.5 / §I）。
 *
 * 用临时 fixture 目录喂受控条目，验：frontmatter 解析、id 唯一 / area 合法校验、
 * candidateSummaries 的**确定性顺序**（area 声明序 + id 字典序，不随 readdir 抖）、
 * getByIds 取对全文且返回序与输入序无关。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 显式钉死 app.isPackaged=false，让真实知识库测试走 dev 路径解析——
// 不靠"非 Electron 进程里 app 恰好是 undefined"的隐性行为（CLAUDE.md 测试约定）。
vi.mock('electron', () => ({ app: { isPackaged: false } }));
import {
  initSelfKnowledge,
  getAreas,
  candidateSummaries,
  getByIds,
  allCapabilities,
  __resetForTest,
} from '../../electron/main/selfKnowledge/registry';

let dir: string;

const AREAS = [
  { id: 'deck', name: '演示稿', blurb: '制作和处理演示稿' },
  { id: 'files', name: '文件管理', blurb: '组织和管理文件' },
];

function entry(o: {
  id: string;
  title?: string;
  area: string;
  summary?: string;
  covers?: string[];
  source?: string;
  body?: string;
}): string {
  const covers = JSON.stringify(o.covers ?? []);
  return [
    '---',
    `id: ${o.id}`,
    `title: ${o.title ?? o.id + ' 标题'}`,
    `area: ${o.area}`,
    `summary: ${o.summary ?? o.id + ' 概述'}`,
    `covers: ${covers}`,
    `source: docs/prd/${o.id}.md`,
    '---',
    '',
    o.body ?? `${o.id} 正文`,
  ].join('\n');
}

async function seed(areas: unknown, files: Record<string, string>): Promise<void> {
  await fs.mkdir(join(dir, 'capabilities'), { recursive: true });
  await fs.writeFile(join(dir, 'areas.json'), JSON.stringify(areas), 'utf-8');
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(dir, 'capabilities', name), content, 'utf-8');
  }
}

beforeEach(async () => {
  dir = join(tmpdir(), `oru-sk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  __resetForTest();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('initSelfKnowledge', () => {
  it('解析 frontmatter + body，getByIds 取对全文', async () => {
    await seed(AREAS, {
      'a.md': entry({ id: 'deck-export', area: 'deck', covers: ['generate_deck'], body: '导出演示稿。\n**限制**：图片版。' }),
    });
    initSelfKnowledge(dir);
    const [e] = getByIds(['deck-export']);
    expect(e.title).toBe('deck-export 标题');
    expect(e.area).toBe('deck');
    expect(e.covers).toEqual(['generate_deck']);
    expect(e.source).toBe('docs/prd/deck-export.md');
    expect(e.body).toBe('导出演示稿。\n**限制**：图片版。');
  });

  it('getAreas 按 areas.json 声明序', async () => {
    await seed(AREAS, { 'a.md': entry({ id: 'x', area: 'deck' }) });
    initSelfKnowledge(dir);
    expect(getAreas().map((a) => a.id)).toEqual(['deck', 'files']);
  });

  it('candidateSummaries 确定性序：area 声明序 + 组内 id 字典序', async () => {
    // 文件名故意与目标序错位，证明排序不靠 readdir / 文件名
    await seed(AREAS, {
      '9.md': entry({ id: 'files-b', area: 'files' }),
      '1.md': entry({ id: 'deck-z', area: 'deck' }),
      '5.md': entry({ id: 'deck-a', area: 'deck' }),
      '3.md': entry({ id: 'files-a', area: 'files' }),
    });
    initSelfKnowledge(dir);
    expect(candidateSummaries().map((c) => c.id)).toEqual([
      'deck-a',
      'deck-z',
      'files-a',
      'files-b',
    ]);
  });

  it('getByIds 返回序固定为确定性序，与输入 ids 顺序无关', async () => {
    await seed(AREAS, {
      'a.md': entry({ id: 'deck-a', area: 'deck' }),
      'b.md': entry({ id: 'files-a', area: 'files' }),
    });
    initSelfKnowledge(dir);
    expect(getByIds(['files-a', 'deck-a']).map((e) => e.id)).toEqual(['deck-a', 'files-a']);
  });

  it('getByIds 静默跳过未知 id（推送小模型可能吐不存在的 id）', async () => {
    await seed(AREAS, { 'a.md': entry({ id: 'deck-a', area: 'deck' }) });
    initSelfKnowledge(dir);
    expect(getByIds(['deck-a', 'nope']).map((e) => e.id)).toEqual(['deck-a']);
  });

  it('id 重复 → throw', async () => {
    await seed(AREAS, {
      'a.md': entry({ id: 'dup', area: 'deck' }),
      'b.md': entry({ id: 'dup', area: 'files' }),
    });
    expect(() => initSelfKnowledge(dir)).toThrow(/id 重复/);
  });

  it('area 不在 areas.json 内 → throw', async () => {
    await seed(AREAS, { 'a.md': entry({ id: 'x', area: 'ghost' }) });
    expect(() => initSelfKnowledge(dir)).toThrow(/不在 areas.json/);
  });

  it('frontmatter 缺必填字段 → throw', async () => {
    await seed(AREAS, {
      'a.md': ['---', 'id: x', 'area: deck', '---', '', '正文'].join('\n'),
    });
    expect(() => initSelfKnowledge(dir)).toThrow(/缺 title/);
  });

  it('covers 非字符串数组 → throw', async () => {
    await seed(AREAS, {
      'a.md': ['---', 'id: x', 'title: t', 'area: deck', 'summary: s', 'covers: nope', 'source: docs/x.md', '---', '', 'b'].join('\n'),
    });
    expect(() => initSelfKnowledge(dir)).toThrow(/covers 必须是字符串数组/);
  });

  it('未初始化即取用 → throw', () => {
    expect(() => getAreas()).toThrow(/未初始化/);
    expect(() => allCapabilities()).toThrow(/未初始化/);
  });
});

describe('真实知识库（resources/self-knowledge）', () => {
  // 默认路径解析（不传 dirOverride）加载随仓库发布的真实条目——
  // 任何条目 frontmatter 写坏 / area 拼错 / id 撞名，这条会第一时间报红。
  it('无错加载，条目非空、id 唯一、area 合法', () => {
    initSelfKnowledge();
    const caps = allCapabilities();
    expect(caps.length).toBeGreaterThan(0);
    const areaIds = new Set(getAreas().map((a) => a.id));
    const ids = new Set<string>();
    for (const c of caps) {
      expect(areaIds.has(c.area)).toBe(true);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(c.summary.trim().length).toBeGreaterThan(0);
    }
  });
});
