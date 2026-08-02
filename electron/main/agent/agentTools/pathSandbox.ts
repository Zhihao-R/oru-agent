/**
 * pathSandbox —— 文件工具共享的白名单沙箱（从 readFile.ts 抽出，read/write/edit/list/delete 共用）。
 *
 * 可读/可写范围（初期一致，见 PRD 开放问题）：
 *   - 当前对话 .tool-cache/
 *   - 当前 agent home（沙盒）
 *   - 已注册项目目录
 *   - enabled skill 目录
 *
 * bash 不走此校验——它不限沙箱，靠命令破坏性判定（bashCommand.ts）设防。
 */
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ToolContext } from '@shared/agent/backend';
import { conversationImagesDir, conversationToolCacheDir } from '../../runtime/paths';
import { getAgent } from '../store/agents';
import { listProjects } from '../../projects/store';

/** 越界错误——工具 catch 后转 isError，文案含允许范围（PRD 边界可发现）。 */
export class SandboxError extends Error {}

const ROOTS_HINT = '可写位置：当前对话 .tool-cache/、agent 沙盒、已注册项目目录';
const READ_ROOTS_HINT = '允许的根：当前对话 .tool-cache/、agent 沙盒、已注册项目目录、enabled skill 目录';

/**
 * 只读操作前断言目标在允许范围内，越界抛 SandboxError（read_file/list_dir/grep/glob 共用）。
 *   ① 绝对路径；② isWithin 白名单根；③ realpath 二次校验防 symlink 越界（目标不存在则放行，
 *      存在性留给调用方报具体错——macOS /var→/private/var 等 OS 层 symlink 要两侧都 realpath）。
 */
export async function assertReadableSandbox(
  path: string,
  ctx: ToolContext,
  /** 调用方显式传入的额外只读根——不进 allowedRoots，故写侧（write/manage）拿不到 */
  extraReadRoots: string[] = [],
): Promise<void> {
  if (!isAbsolute(path)) {
    throw new SandboxError(`path 必须是绝对路径，得到 "${path}"`);
  }
  const roots = [...(await allowedRoots(ctx)), ...extraReadRoots];
  if (!roots.some((r) => isWithin(path, r))) {
    throw new SandboxError(`路径不在允许的范围内：${path}（${READ_ROOTS_HINT}）`);
  }
  try {
    const rp = await fs.realpath(path);
    const realRoots = await Promise.all(roots.map((r) => fs.realpath(r).catch(() => r)));
    if (!realRoots.some((r) => isWithin(rp, r))) {
      throw new SandboxError(`解析符号链接后路径越界：${path} → ${rp}`);
    }
  } catch (e) {
    if (e instanceof SandboxError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // 不存在——交给调用方
    // realpath 其他错误（权限等）放行，让调用方读时报具体错
  }
}

/**
 * 本对话的图片附件目录——只读，由 read_file 显式传给 assertReadableSandbox 的 extraReadRoots。
 *
 * 为什么不加进 allowedRoots：assertWritableSandbox 吃的是同一份根表（两处都调 allowedRoots），
 * 加进去等于把用户原始上传图的写与删权限（write_file / manage_files）一并给了 AI。
 * 今天只有 read_file 要读它（claude-code 灌历史把老图占位句改成路径指路，模型按需读回），
 * 故做成「调用方显式传入的额外只读根」而非通用的「只读根」概念——出现第二处再抽。
 */
export function conversationImageReadRoot(ctx: ToolContext): string {
  return conversationImagesDir(ctx.ownerId, ctx.agentId, ctx.conversationId);
}

export async function allowedRoots(ctx: ToolContext): Promise<string[]> {
  const roots: string[] = [];

  // 1. 当前对话 .tool-cache/
  roots.push(conversationToolCacheDir(ctx.ownerId, ctx.agentId, ctx.conversationId));

  // 2. 当前 agent 沙盒（agent.homePath）
  try {
    const agent = await getAgent(ctx.agentId);
    if (agent.homePath) roots.push(agent.homePath);
  } catch {
    // agent 查不到——跳过沙盒根（仍可读 .tool-cache + 项目根）
  }

  // 3. 已注册项目根
  try {
    const { projects } = await listProjects();
    for (const p of projects) {
      if (p.path) roots.push(p.path);
    }
  } catch {
    // 项目列表读不到——跳过
  }

  // 4. enabled skill 目录——让 bundle skill 能读伴生文件
  const { listEnabledSkillRoots } = await import('../../skills/registry');
  roots.push(...(await listEnabledSkillRoots()));

  return roots;
}

/**
 * grep/glob 未指定 path 时的默认搜索根：优先 active 项目根，否则 agent home。
 * 固定可预测——返回 null 表示既无 active 项目也无 agent home（调用方报错）。
 */
export async function defaultSearchRoot(ctx: ToolContext): Promise<string | null> {
  if (ctx.activeProjectId) {
    try {
      const { projects } = await listProjects();
      const p = projects.find((x) => x.id === ctx.activeProjectId);
      if (p?.path) return p.path;
    } catch {
      // 项目读不到——退到 agent home
    }
  }
  try {
    const agent = await getAgent(ctx.agentId);
    if (agent.homePath) return agent.homePath;
  } catch {
    // agent 查不到
  }
  return null;
}

/** path 是否在 root 之下（绝对路径比较）。返回 true 表示允许。 */
export function isWithin(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 写操作前断言目标在可写沙箱内，越界抛 SandboxError（文案含可写位置）。
 *   ① 符号层 isWithin（.. 规范化）；
 *   ② 目标已存在的最近祖先目录 realpath 后再 isWithin——防 `<root>/symlink-to-etc/x` 穿越。
 * write 新建时目标不存在，故对**最近存在祖先**做 realpath，而非目标本身。
 */
export async function assertWritableSandbox(path: string, ctx: ToolContext): Promise<void> {
  if (!isAbsolute(path)) {
    throw new SandboxError(`路径必须是绝对路径：${path}`);
  }
  const roots = await allowedRoots(ctx);
  if (!roots.some((r) => isWithin(path, r))) {
    throw new SandboxError(`路径不在可写范围内：${path}\n${ROOTS_HINT}`);
  }

  // realpath 最近存在祖先目录，防经 symlink 父目录穿越到沙箱外
  const ancestor = await nearestExistingDir(path);
  if (ancestor) {
    let realAncestor: string;
    try {
      realAncestor = await fs.realpath(ancestor);
    } catch {
      return; // realpath 失败（权限等）——符号层已过，放行
    }
    const realRoots = await Promise.all(roots.map((r) => fs.realpath(r).catch(() => r)));
    // 把目标相对祖先的剩余段拼到 realAncestor 上，再核对
    const tail = relative(ancestor, path);
    const realTarget = resolve(realAncestor, tail);
    if (!realRoots.some((r) => isWithin(realTarget, r))) {
      throw new SandboxError(`解析符号链接后路径越界：${path} → ${realTarget}\n${ROOTS_HINT}`);
    }
  }
}

/** 沿父目录上溯，返回第一个真实存在的目录（用于 realpath 后验）。 */
async function nearestExistingDir(path: string): Promise<string | null> {
  let dir = dirname(path);
  // 上限若干层，防极端情形死循环
  for (let i = 0; i < 64; i++) {
    try {
      if ((await fs.stat(dir)).isDirectory()) return dir;
    } catch {
      // 不存在，继续上溯
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // 到根了
    dir = parent;
  }
  return null;
}
