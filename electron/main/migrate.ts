/**
 * 数据迁移
 *
 * 1) migrateLegacySessions：把上个版本按 projectId 分桶的 sessions 归档到 legacy/
 *    - 旧格式: ~/.oru/sessions/<projectId>/<sessionId>.jsonl
 *    - 新格式: ~/.oru/users/<userId>/conversations/<agentId>/<convId>.jsonl
 *    - 不自动导入，归档保留供用户手动查看
 *
 * 2) migrateToUserScopedLayout：把"无 owner 单用户布局"迁到"按 ownerId 切片"
 *    - 旧布局: ~/.oru/{agents,agents.json,conversations,tasks,config.json}
 *    - 新布局: ~/.oru/users/local-user/{agents,agents.json,conversations,tasks,config.json}
 *    - 用 mv 整个目录 / 文件，不读不写内容（避免大数据时间长）
 *    - 幂等：跑 N 次结果一样
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_USER_ID } from './identity/getCurrentOwnerId';
import { ORU_DIR, userDir } from './runtime/paths';
import { safeWriteAsync } from './fs/safeWrite';

const OLD_SESSIONS = join(ORU_DIR, 'sessions');
const LEGACY_DIR = join(ORU_DIR, 'legacy', 'sessions');

export async function migrateLegacySessions(): Promise<void> {
  if (!existsSync(OLD_SESSIONS)) return;
  // 检查 sessions 里是否有内容
  let entries: string[] = [];
  try {
    entries = await fs.readdir(OLD_SESSIONS);
  } catch {
    return;
  }
  if (entries.length === 0) {
    // 空目录，直接删
    try {
      await fs.rmdir(OLD_SESSIONS);
    } catch { /* ignore */ }
    return;
  }
  await fs.mkdir(LEGACY_DIR, { recursive: true });
  const ts = Date.now();
  const target = join(LEGACY_DIR, `archived-${ts}`);
  await fs.rename(OLD_SESSIONS, target);
  console.log(`[oru.migrate] 老 sessions 已归档到 ${target}`);
}

/**
 * 把 ~/.oru/ 老布局（无 owner 切片）迁移到 ~/.oru/users/local-user/ 新布局。
 * 幂等：第一次跑搬数据，之后跑时检测到目标已存在就跳过。
 */
export async function migrateToUserScopedLayout(): Promise<void> {
  const targetDir = userDir(LOCAL_USER_ID);
  await fs.mkdir(targetDir, { recursive: true });

  // 老路径 → 新路径（fs.rename 对文件和目录通用，不需要分类）
  const moves: Array<{ from: string; to: string }> = [
    { from: join(ORU_DIR, 'agents'), to: join(targetDir, 'agents') },
    { from: join(ORU_DIR, 'agents.json'), to: join(targetDir, 'agents.json') },
    { from: join(ORU_DIR, 'conversations'), to: join(targetDir, 'conversations') },
    { from: join(ORU_DIR, 'tasks'), to: join(targetDir, 'tasks') },
    { from: join(ORU_DIR, 'config.json'), to: join(targetDir, 'config.json') },
  ];

  let moved = 0;
  for (const m of moves) {
    if (!existsSync(m.from)) continue;
    if (existsSync(m.to)) {
      // 目标已存在 = 之前迁过了，老的应该是残留——保险起见跳过，让用户自己处理
      // 实际上这种情况不应出现（因为新布局是"老的搬过去后老的就没了"）
      console.warn(`[oru.migrate] 跳过：${m.from} → ${m.to}（目标已存在）`);
      continue;
    }
    await fs.rename(m.from, m.to);
    moved += 1;
  }

  if (moved > 0) {
    console.log(`[oru.migrate] 迁移到 user-scoped 布局：移动 ${moved} 项 → ${targetDir}`);
  }

  // 修补 agents.json 里 agent.homePath 的旧绝对路径
  await fixAgentHomePathsInIndex(targetDir);
}

/**
 * agents.json 里的 agent.homePath 是绝对路径，迁移文件后路径已经变了
 * 这里把指向旧 ~/.oru/agents/* 的 homePath 修正到新位置
 */
async function fixAgentHomePathsInIndex(targetDir: string): Promise<void> {
  const indexPath = join(targetDir, 'agents.json');
  if (!existsSync(indexPath)) return;
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf-8');
  } catch {
    return;
  }
  let parsed: { agents?: Array<{ homePath?: string }>; activeId?: string | null };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || !Array.isArray(parsed.agents)) return;

  const oldPrefix = join(ORU_DIR, 'agents') + '/';
  const newPrefix = join(targetDir, 'agents') + '/';
  let changed = false;
  for (const a of parsed.agents) {
    if (typeof a.homePath === 'string' && a.homePath.startsWith(oldPrefix)) {
      a.homePath = newPrefix + a.homePath.slice(oldPrefix.length);
      changed = true;
    }
  }
  if (changed) {
    // 改写既有索引走原子写内核（tmp+rename）——半截 agents.json 会让启动读不出 agent
    await safeWriteAsync(indexPath, JSON.stringify(parsed, null, 2));
    console.log('[oru.migrate] 修正 agents.json 里 homePath 旧路径');
  }
}
