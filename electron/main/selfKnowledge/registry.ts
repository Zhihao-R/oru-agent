/**
 * 自我认知知识库 registry（子系统 A）。
 *
 * 事实源 = `resources/self-knowledge/` 下一组 markdown 条目（一条用户能感知的能力一个文件）
 * + 一份有序的 `areas.json`（领域清单）。启动期一次性读进内存、运行时只读。
 *
 * 与 builtin-skills 的差别（A.4）：skill 首启解包到 ~/.oru/skills 供用户改；知识库**只读、
 * 不解包**——它是产品真相，不该被用户改写后污染 Oru 的自我认知。直接从 resources 读进内存。
 *
 * 确定性排序是硬要求、不是优化（A.5）：`fs.readdir` 不保证顺序，若锚点/候选简介跟着 readdir 走，
 * 跨机器装配出的字节会变 → stable 段 token 错位 → prompt cache 静默失效。所以：areas.json 是
 * **有序数组**、按其声明序；条目一律按「area 声明序 + 组内 id 字典序」排，绝不用 Map 迭代序代替。
 */
import { app } from 'electron';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

/** 领域：常驻锚点（B）那条「领域线索」的粒度——只点「我大致有这几类能力」，不列明细。 */
export type Area = {
  id: string;
  /** 用户语言的领域名（中文） */
  name: string;
  /** 一句话定位 */
  blurb: string;
};

/** 一条用户能感知的能力。frontmatter 是机器读的结构，body 是给模型读的体感。 */
export type CapabilityEntry = {
  id: string;
  /** 用户语言的能力名 */
  title: string;
  /** 所属领域 id（必在 areas.json 内） */
  area: string;
  /** 一句话能力概述——喂给推送小模型的「候选简介」（C 读它挑相关），不进常驻锚点 */
  summary: string;
  /** 此能力由哪些工具名实现，D 的对账锚点；纯 UI 无工具锚点留空 */
  covers: string[];
  /** 溯源文档路径，仅供内部审计（H）——不吐给终端用户 */
  source: string;
  /** 正文（体感 / 限制 / 前提 / 怎么用） */
  body: string;
};

type Loaded = {
  areas: Area[];
  /** 按 (area 声明序, id 字典序) 排好的条目 */
  ordered: CapabilityEntry[];
  byId: Map<string, CapabilityEntry>;
};

let loaded: Loaded | null = null;

/**
 * 解析知识库根目录。复用 builtin-skills 的 dev/prod 路径分支（A.4），但**只读、不解包**。
 * prod = `process.resourcesPath/self-knowledge`；dev = `<项目根>/resources/self-knowledge`。
 */
function resolveSelfKnowledgeDir(): string {
  if (app?.isPackaged) {
    return join(process.resourcesPath, 'self-knowledge');
  }
  // dev：本文件编译到 out/main/selfKnowledge/registry.js（或测试期 tsx 直跑 electron/main/
  // selfKnowledge/registry.ts），两种情形项目根都在上溯三层——与 ensureBuiltin.ts 同构、逐个
  // existsSync 命中即用（保留 ../../ 这档与 builtin-skills 范式对齐，不另加跑出项目外的档）。
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../resources/self-knowledge', '../../../resources/self-knowledge']) {
    const candidate = join(here, rel);
    if (existsSync(candidate)) return candidate;
  }
  return join(here, '../../resources/self-knowledge');
}

function parseAreas(dir: string): Area[] {
  const raw = readFileSync(join(dir, 'areas.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('[selfKnowledge] areas.json 必须是有序数组');
  }
  return parsed.map((a, i): Area => {
    if (!a || typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.blurb !== 'string') {
      throw new Error(`[selfKnowledge] areas.json 第 ${i} 项缺 id/name/blurb`);
    }
    return { id: a.id, name: a.name, blurb: a.blurb };
  });
}

function parseEntry(dir: string, file: string): CapabilityEntry {
  const raw = readFileSync(join(dir, file), 'utf-8');
  const { data, content } = matter(raw);
  const need = (k: string): string => {
    const v = data[k];
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`[selfKnowledge] ${file}: frontmatter 缺 ${k}`);
    }
    return v;
  };
  const covers = data.covers ?? [];
  if (!Array.isArray(covers) || covers.some((c) => typeof c !== 'string')) {
    throw new Error(`[selfKnowledge] ${file}: covers 必须是字符串数组（无工具锚点留空 []）`);
  }
  return {
    id: need('id'),
    title: need('title'),
    area: need('area'),
    summary: need('summary'),
    covers,
    source: need('source'),
    body: content.trim(),
  };
}

/**
 * 启动期读盘 + 校验 + 填表。校验：frontmatter 必填、id 唯一、area 必在 areas.json 内。
 * （covers 工具名存在性属「声明面」对账，依赖 backend factory，归 D 检测单测，不在此校验。）
 *
 * @param dirOverride 测试用——指向 fixture 目录；缺省走 resolveSelfKnowledgeDir()。
 */
export function initSelfKnowledge(dirOverride?: string): void {
  const dir = dirOverride ?? resolveSelfKnowledgeDir();
  const areas = parseAreas(dir);
  const areaOrder = new Map(areas.map((a, i) => [a.id, i]));

  // 布局固定（A.4）：条目在 capabilities/*.md、areas.json 在根。只扫 capabilities/。
  const files = readdirSync(join(dir, 'capabilities'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('capabilities', f));

  const byId = new Map<string, CapabilityEntry>();
  for (const file of files) {
    const entry = parseEntry(dir, file);
    if (byId.has(entry.id)) {
      throw new Error(`[selfKnowledge] id 重复：${entry.id}`);
    }
    if (!areaOrder.has(entry.area)) {
      throw new Error(`[selfKnowledge] ${entry.id}: area「${entry.area}」不在 areas.json 内`);
    }
    byId.set(entry.id, entry);
  }

  const ordered = [...byId.values()].sort(
    (a, b) => areaOrder.get(a.area)! - areaOrder.get(b.area)! || a.id.localeCompare(b.id),
  );

  loaded = { areas, ordered, byId };
}

function ensureLoaded(): Loaded {
  if (!loaded) throw new Error('[selfKnowledge] 未初始化——先调 initSelfKnowledge()');
  return loaded;
}

/** B 装配领域线索用——按 areas.json 声明序。 */
export function getAreas(): Area[] {
  return ensureLoaded().areas;
}

/** C 喂给推送小模型的「候选简介」（确定性序：area 声明序 + id 字典序）。 */
export function candidateSummaries(): { id: string; area: string; summary: string }[] {
  return ensureLoaded().ordered.map((e) => ({ id: e.id, area: e.area, summary: e.summary }));
}

/**
 * C 取选中条目全文注入。未知 id 静默跳过（推送小模型可能吐出不存在的 id，保守跳过而非 throw）。
 * 返回序固定为确定性序，与输入 ids 顺序无关——保住注入块字节稳定（C.3 缓存约定）。
 */
export function getByIds(ids: string[]): CapabilityEntry[] {
  const { ordered } = ensureLoaded();
  const want = new Set(ids);
  return ordered.filter((e) => want.has(e.id));
}

/** D 检测用——全部条目（确定性序）。 */
export function allCapabilities(): CapabilityEntry[] {
  return ensureLoaded().ordered;
}

/** 仅供单测隔离用——清空已加载状态。 */
export function __resetForTest(): void {
  loaded = null;
}
