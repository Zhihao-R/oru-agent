/**
 * 文件 watcher 管理器 —— 哨兵按目录布设、按 owner 记账。
 *
 * 设计要点（见 docs/tech/2026-06-05-file-tree-lazy-live-tech-design.md 决策 2/5，
 * owner 记账见 docs/tech/2026-06-12-table-workbench-tech-design.md「草稿与保存」）：
 * - 监听集 = 文件树已展开目录（owner='tree'）+ 表格视图打开文件的父目录（owner=`table:${path}`），
 *   每个目录一个非递归 FSWatcher，多 owner 共享；owner 集清空才真正关 watcher。
 * - 文件树的调用形态不对称（展开逐目录 watch、折叠只对父目录发一次 unwatch 靠级联拆后代、
 *   reset 用 unwatch('')），级联只清 'tree' 的记账；表格 owner 按自己的 relDir 精确清理——
 *   裸引用计数在这套形态下必错，所以是 owner 集合不是计数。
 * - error 自毁与 unwatchAll 清该 relDir 的全部记账（否则自毁后记账残留 → watchDir 拒绝重布
 *   → 永久失盲）。
 * - 任一事件 → 防抖合并 → broadcast(fs.changed{projectId, path})。对事件 filename 不解析、
 *   整层重读，故 fs.watch 的重复事件/filename 为 null 都无害。
 * - 单活跃项目：watch 请求带新 projectId 时自动清掉旧项目全部 watch。
 * - 所有 per-watcher 回调（变更、error）都绑定到创建时捕获的 ProjectWatch（pw），不读模块
 *   全局 current，故切项目/退订后旧 watcher 的迟到回调既不会 NPE、也不会误伤新项目。
 */
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Broadcast } from '../ws/server';
import { fileChangedEvent } from './fsChanged';

const DEBOUNCE_MS = 250;

/** 'tree'＝文件树展开；`table:${打开文件的项目相对路径}`＝表格视图盯外部改动 */
export type WatchOwner = string;

type ProjectWatch = {
  projectId: string;
  projectPath: string;
  broadcast: Broadcast;
  watchers: Map<string, FSWatcher>; // relDir -> FSWatcher
  owners: Map<string, Set<WatchOwner>>; // relDir -> 谁需要这个哨兵
  timers: Map<string, ReturnType<typeof setTimeout>>; // relDir -> debounce timer
  pending: Map<string, Set<string>>; // relDir -> 本防抖窗口内变更的文件名（G38：攒着，flush 时逐个发文件级）
};

let current: ProjectWatch | null = null;

function isUnderOrEqual(parent: string, dir: string): boolean {
  if (parent === '') return true; // 根包含一切：故 unwatchDir(_, '', 'tree') 即树退订全部
  return dir === parent || dir.startsWith(`${parent}/`);
}

/**
 * 一次原始 fs.watch 事件：攒下变更的文件名（filename 可能为 null，见下），防抖后 flush。
 * G38：外部程序改动此前只发目录级信号（编辑器/预览要等切回标签页才被动对账）；现在攒住本窗口内的
 * 具体文件名，flush 时对每个文件发一条**文件级** fs.changed（带 filePath + path），编辑器/预览即时命中；
 * 事件本身仍带 path=relDir，故 fsStore/tableStore 这些目录级消费者语义不变。作者标缺省——
 * 编辑器靠「磁盘内容 vs 我提交的」判据决定要不要合并，自写回声不会被误当外部改动。
 */
function scheduleEmit(pw: ProjectWatch, relDir: string, filename: string | null): void {
  if (pw !== current) return; // pw 已被切项目/退订置换，迟到回调直接丢弃
  if (filename) {
    const set = pw.pending.get(relDir) ?? new Set<string>();
    set.add(filename);
    pw.pending.set(relDir, set);
  }
  const existing = pw.timers.get(relDir);
  if (existing) clearTimeout(existing);
  pw.timers.set(
    relDir,
    setTimeout(() => {
      pw.timers.delete(relDir);
      const names = pw.pending.get(relDir);
      pw.pending.delete(relDir);
      if (names && names.size > 0) {
        // 逐个文件发文件级事件；事件带 path=relDir 供目录级消费者，filePath 供编辑器/预览精确命中。
        for (const name of names) {
          pw.broadcast(fileChangedEvent(pw.projectId, relDir ? `${relDir}/${name}` : name));
        }
      } else {
        // filename 全为 null（个别平台）——退回目录级，至少让 fsStore 整层重读。
        pw.broadcast({ type: 'fs.changed', projectId: pw.projectId, path: relDir });
      }
    }, DEBOUNCE_MS),
  );
}

/** 关掉 relDir 的 FSWatcher 并清全部记账（error 自毁也走这里——记账必须随哨兵一起消失）。 */
function closeWatcherIn(pw: ProjectWatch, relDir: string): void {
  const w = pw.watchers.get(relDir);
  if (w) {
    w.close();
    pw.watchers.delete(relDir);
  }
  pw.owners.delete(relDir);
  pw.pending.delete(relDir);
  const t = pw.timers.get(relDir);
  if (t) {
    clearTimeout(t);
    pw.timers.delete(relDir);
  }
}

/** 给 relDir 布哨兵并登记 owner。哨兵幂等（多 owner 共享）；projectId 变更时先清旧项目。 */
export function watchDir(
  projectId: string,
  projectPath: string,
  relDir: string,
  owner: WatchOwner,
  broadcast: Broadcast,
): void {
  if (current && current.projectId !== projectId) unwatchAll();
  if (!current) {
    current = {
      projectId,
      projectPath,
      broadcast,
      watchers: new Map(),
      owners: new Map(),
      timers: new Map(),
      pending: new Map(),
    };
  }
  const pw = current; // 捕获，per-watcher 回调只认它、不读模块全局
  const existing = pw.owners.get(relDir);
  if (existing) {
    existing.add(owner);
    return; // 哨兵已在，只添记账
  }

  const abs = relDir ? join(projectPath, relDir) : projectPath;
  try {
    const w = watch(abs, { persistent: false }, (_evt, filename) =>
      scheduleEmit(pw, relDir, typeof filename === 'string' ? filename : null),
    );
    w.on('error', () => closeWatcherIn(pw, relDir)); // 目录被删/重命名时 watcher 报错，连记账一起撤
    pw.watchers.set(relDir, w);
    pw.owners.set(relDir, new Set([owner]));
  } catch {
    // 目录不存在/无权限：不布哨兵，静默（前端展开时 listDir 也会拿到空列表）
  }
}

/**
 * 撤掉 owner 在 relDir 上的记账；owner 集空了才真正撤哨兵。
 * owner='tree' 时级联到全部后代目录（折叠一个目录即收起整棵子树），但只清 'tree' 的记账，
 * 不动 table owner 的哨兵；其余 owner 只精确清 relDir 自己。relDir='' + 'tree' 即树退订全部。
 */
export function unwatchDir(projectId: string, relDir: string, owner: WatchOwner): void {
  if (!current || current.projectId !== projectId) return;
  const pw = current;
  const targets =
    owner === 'tree' ? [...pw.owners.keys()].filter((key) => isUnderOrEqual(relDir, key)) : [relDir];
  for (const key of targets) {
    const set = pw.owners.get(key);
    if (!set) continue;
    set.delete(owner);
    if (set.size === 0) closeWatcherIn(pw, key);
  }
}

/** 清掉当前项目的全部哨兵与记账（切项目、客户端断开、退出时调用）。 */
export function unwatchAll(): void {
  if (!current) return;
  for (const w of current.watchers.values()) w.close();
  for (const t of current.timers.values()) clearTimeout(t);
  current = null;
}

/** 仅供测试：当前记账快照 relDir → 排序后 owner 列表；空记账为 {}。 */
export function watcherOwnersForTest(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!current) return out;
  for (const [relDir, set] of current.owners) out[relDir] = [...set].sort();
  return out;
}

/** 仅供测试：模拟 relDir 的 FSWatcher error 自毁（真实 error 时机不可控）。 */
export function simulateWatcherErrorForTest(relDir: string): void {
  if (!current) return;
  closeWatcherIn(current, relDir);
}

/** 仅供测试：模拟 relDir 下一次 fs.watch 原始事件（filename=null 模拟无文件名平台）。 */
export function simulateChangeForTest(relDir: string, filename: string | null): void {
  if (!current) return;
  scheduleEmit(current, relDir, filename);
}
