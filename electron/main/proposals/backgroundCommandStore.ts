/**
 * 后台命令登记表（S19·G16/G18）——跨重启存活的后台 bash 命令记录 + 累积输出落盘。
 *
 * 背景：subagent 有 tasks/store 这张登记表，后台命令此前只有内存进程表（executeBashProposal
 * 的 bgProcesses），崩溃后连「认出未完成命令」的原料都没有。本模块补上：
 *   - 记录: ~/.oru/users/<ownerId>/bg-commands/<id>.json（tmp+rename 原子写、带格式版本号）
 *   - 输出: ~/.oru/users/<ownerId>/bg-commands/<id>.output.txt（边流边 append、按需读尾）
 * 生命周期由 executeBashProposal.startBackground 驱动，本模块只管持久化 + 查询 + 启动扫描。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bgCommandsDir } from '../runtime/paths';
import { createWriteQueue } from '../runtime/atomicStore';
import { makeVersionedCodec } from '../runtime/versionedRecord';

// 串行所有写 + tmp+rename 原子写——避免 read-modify-write 撕裂、断电安全（同 tasks/store）。
const { enqueue, writeAtomic } = createWriteQueue();

/**
 * 记录变化通知缝（登记/终态都经 create/patch 这一个咽喉）——ws 层注册后把增量广播给渲染端
 * （对话内后台命令行的活状态）。未注册（单测/背景）时静默；本模块不反向依赖 ws。
 */
let changeListener: ((rec: BackgroundCommandRecord) => void) | null = null;

export function setBackgroundCommandChangeListener(
  fn: ((rec: BackgroundCommandRecord) => void) | null,
): void {
  changeListener = fn;
}

function notifyChange(rec: BackgroundCommandRecord): void {
  try {
    changeListener?.(rec);
  } catch {
    // 广播失败不应影响已落盘的写（同 scheduledTasks pushState 的取舍）
  }
}

export type BackgroundCommandStatus = 'running' | 'exited' | 'crashed';

export type BackgroundCommandRecord = {
  /** 模型可见编号 'bash-bg-<shortid>'——read_background_output / 完成触发都按它寻址。 */
  id: string;
  ownerId: string;
  agentId: string;
  conversationId: string;
  command: string;
  /** 进程组组长 pid（detached spawn）；spawn 失败时 null。 */
  pid: number | null;
  /** running=还在跑；exited=进程自行退出（带 exitCode）；crashed=启动扫描认出的悬空（父进程崩溃遗留）。 */
  status: BackgroundCommandStatus;
  exitCode: number | null;
  /** 看门狗判「长时间无新输出」而终止的 → true（与真正跑完区分）。 */
  timedOut: boolean;
  startedAt: number;
  finishedAt: number | null;
  /** 完成播报去重位（同 SubagentTask.announcedAt）。 */
  announcedAt: number | null;
  outputPath: string;
};

// 格式版本封套（S06 范式，共享编解码器）：v1 起，字段级演进走 hydrate 补默认，版本号管结构级演进。
const codec = makeVersionedCodec<BackgroundCommandRecord>({
  baselineVersion: 1,
  chain: [],
  field: 'record',
  label: 'bg-commands',
});

function metaFile(ownerId: string, id: string): string {
  return join(bgCommandsDir(ownerId), `${id}.json`);
}

export function backgroundOutputPath(ownerId: string, id: string): string {
  return join(bgCommandsDir(ownerId), `${id}.output.txt`);
}

async function ensureDir(ownerId: string): Promise<void> {
  await fs.mkdir(bgCommandsDir(ownerId), { recursive: true });
}

/** 读一条记录（读时迁移 + 迁移前原样副本）。未来版本 → null（不读不写、版本不倒退）。 */
async function readRecordFile(path: string): Promise<Partial<BackgroundCommandRecord> | null> {
  const rawText = await fs.readFile(path, 'utf-8');
  return codec.read(path, rawText);
}

export async function createBackgroundCommand(rec: BackgroundCommandRecord): Promise<void> {
  await enqueue(async () => {
    await ensureDir(rec.ownerId);
    await writeAtomic(metaFile(rec.ownerId, rec.id), codec.serialize(rec));
  });
  notifyChange(rec);
}

/** 锁内 RMW：读当前值 → merge patch → 原子写，整块在 enqueue 内，绝不锁外读（同 patchTask）。 */
export async function patchBackgroundCommand(
  ownerId: string,
  id: string,
  patch: Partial<BackgroundCommandRecord>,
): Promise<BackgroundCommandRecord | null> {
  const next = await enqueue(async () => {
    const f = metaFile(ownerId, id);
    if (!existsSync(f)) return null;
    try {
      const raw = await readRecordFile(f);
      if (!raw) return null;
      const merged = { ...(raw as BackgroundCommandRecord), ...patch, id, ownerId };
      await writeAtomic(f, codec.serialize(merged));
      return merged;
    } catch {
      return null;
    }
  });
  if (next) notifyChange(next);
  return next;
}

export async function getBackgroundCommand(
  ownerId: string,
  id: string,
): Promise<BackgroundCommandRecord | null> {
  const f = metaFile(ownerId, id);
  if (!existsSync(f)) return null;
  try {
    const raw = await readRecordFile(f);
    return raw ? ({ ...(raw as BackgroundCommandRecord), id, ownerId }) : null;
  } catch {
    return null;
  }
}

export async function listBackgroundCommands(ownerId: string): Promise<BackgroundCommandRecord[]> {
  const dir = bgCommandsDir(ownerId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: BackgroundCommandRecord[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readRecordFile(join(dir, f));
      if (!raw?.id) continue;
      out.push({ ...(raw as BackgroundCommandRecord), ownerId });
    } catch {
      // 单条解析失败不阻断
    }
  }
  return out;
}

export async function listBackgroundForConversation(
  ownerId: string,
  conversationId: string,
): Promise<BackgroundCommandRecord[]> {
  const all = await listBackgroundCommands(ownerId);
  return all.filter((r) => r.conversationId === conversationId);
}

/** 完成播报去重：只打 announcedAt，其余字段锁内重读保留。 */
export async function markBackgroundAnnounced(ownerId: string, id: string): Promise<void> {
  await patchBackgroundCommand(ownerId, id, { announcedAt: Date.now() });
}

// 输出文件尾部读取上限（同 getLastProgress）：长构建日志单文件可上 MB，只读尾部够看最近进展。
const OUTPUT_TAIL_BYTES = 64 * 1024;

/** append 一段输出到该命令的落盘文件（边流边写；G16 按需读的就是它）。 */
export async function appendBackgroundOutput(
  ownerId: string,
  id: string,
  chunk: string,
): Promise<void> {
  return enqueue(async () => {
    await ensureDir(ownerId);
    await fs.appendFile(backgroundOutputPath(ownerId, id), chunk, 'utf-8');
  });
}

/** 读该命令累积输出的尾部（read_background_output 工具用）；无输出返回 ''。 */
export async function readBackgroundOutputTail(ownerId: string, id: string): Promise<string> {
  const f = backgroundOutputPath(ownerId, id);
  if (!existsSync(f)) return '';
  try {
    const fh = await fs.open(f, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - OUTPUT_TAIL_BYTES);
      const len = size - start;
      if (len <= 0) return '';
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      let text = buf.toString('utf-8');
      if (start > 0) text = `…[输出过长，只显示末尾 ${Math.round(OUTPUT_TAIL_BYTES / 1024)}KB]\n${text}`;
      return text;
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

/**
 * 启动扫描（G18）：把所有 status='running' 的记录判为「因崩溃中断」（crashed）——
 * 进程随上次崩溃的父进程一起消失了，本次是全新进程，登记表里还挂着 running 的必是遗留。
 * 标 crashed（不自动重跑，工作可能已有副作用）并返回，交调用方合成「因崩溃中断」触发入队。
 */
export async function scanBackgroundOnBoot(ownerId: string): Promise<BackgroundCommandRecord[]> {
  const all = await listBackgroundCommands(ownerId);
  const dangling = all.filter((r) => r.status === 'running');
  const recovered: BackgroundCommandRecord[] = [];
  for (const r of dangling) {
    const patched = await patchBackgroundCommand(ownerId, r.id, {
      status: 'crashed',
      finishedAt: Date.now(),
    });
    if (patched) recovered.push(patched);
  }
  return recovered;
}
