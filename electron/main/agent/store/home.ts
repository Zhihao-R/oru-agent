import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_TWIN_PERSONA,
  DIRECT_EDIT_LINE,
  ENGINEERING_DISPATCH_LINE,
  PROJECT_HINT_LINE,
} from '../../prompts/twinPersona';
import { readWithMetaAsync, safeWriteAsync } from '../../fs/safeWrite';

/**
 * 确保分身的家目录及其标准子目录存在；首次创建时填入默认 CLAUDE.md
 */
export async function ensureAgentHome(homePath: string): Promise<void> {
  await fs.mkdir(homePath, { recursive: true });
  await fs.mkdir(join(homePath, 'memory'), { recursive: true });
  await fs.mkdir(join(homePath, 'notes'), { recursive: true });
  await fs.mkdir(join(homePath, 'drafts'), { recursive: true });
  const claudeMdPath = join(homePath, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    await fs.writeFile(claudeMdPath, DEFAULT_TWIN_PERSONA, 'utf-8');
  }
}

/**
 * 已换过的模板句：旧字面量 → 新字面量。旧句是历史原文（仅供匹配，别在别处引用），
 * 新句一律引 twinPersona 导出的常量——模板与迁移共用同一字面量，两处不会漂移。
 * 模板句再演进就往这张表加一行。
 */
const TEMPLATE_LINE_MIGRATIONS: { from: string; to: string }[] = [
  {
    from: '- 用户当前关注哪个项目，会通过每轮 user prompt 前的 `[当前用户正在查看项目: ...]` hint 告诉你。',
    to: PROJECT_HINT_LINE,
  },
  {
    // 一行换两行：旧句把「小改直接做」与「工程改动派工」压在一句里，拆开后子项才挂在提案那条下面
    from: '- 改代码：你不能直接 Write/Edit/Bash。改代码必须先调 `propose_action` 工具递交提案，由 Oru 派子 agent 执行。',
    to: `${DIRECT_EDIT_LINE}\n${ENGINEERING_DISPATCH_LINE}`,
  },
  {
    // 委派工具收敛（2026-08-02）：已迁到「工程改动派工」中间态的 agent，把旧 propose_action 句
    // 追迁到 Task 句（防止曾迈过第一批迁移的用户永久停留在已退役的 propose_action 措辞上）
    from: '- 改完要跑起来验证才知道对不对的工程改动（要跑测试、要装依赖的那种），才调 `propose_action` 递交提案，由 Oru 派子 agent 在独立上下文里迭代：',
    to: ENGINEERING_DISPATCH_LINE,
  },
];

/**
 * 存量迁移：家目录 CLAUDE.md 里已换过的模板句逐条整行替换为新句。
 *
 * 这份 CLAUDE.md 是系统模板写入的 agent 私有文件（仅首建时写入），不是用户文档——
 * 精确整行替换不越界：只匹配旧句原文，该行被编辑过（无论 Oru 还是用户）就不再精确
 * 命中、那行不动；替换后旧句不复存在，天然幂等。一次读、按表全替、有变化才写。
 * 启动路径对 agents.json 里所有 agent 的 homePath 各跑一次（main/index.ts）。
 */
export async function migratePersonaTemplateLines(homePath: string): Promise<void> {
  const claudeMdPath = join(homePath, 'CLAUDE.md');
  let content: string;
  let lineEnding: 'LF' | 'CRLF';
  try {
    ({ content, lineEnding } = await readWithMetaAsync(claudeMdPath));
  } catch {
    return; // 文件不存在（家目录未初始化等）——迁移不负责创建
  }
  const migrated = TEMPLATE_LINE_MIGRATIONS.reduce(
    (text, { from, to }) => text.replace(from, to),
    content,
  );
  if (migrated === content) return;
  await safeWriteAsync(claudeMdPath, migrated, lineEnding);
}
