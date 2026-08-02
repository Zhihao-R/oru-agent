/**
 * bash 执行器 —— spawn 子进程跑命令、超时杀进程组、输出截断落盘、后台任务。
 *
 * 入口：
 *   - runBashCommand：跑命令核心。bash 工具（信任模式直接、审批模式经用户确认后）内联调它，
 *     把真实输出作为工具结果返回；完整输出写 conversation .tool-cache，read_file 可取全文。
 *   - killBashForConversation：conversation 销毁/清空、或用户按停（chat.abort 对话级刹车）时
 *     kill 该对话所有后台进程组（防泄漏 / 防「以为停了其实还在跑」）。
 *
 * 安全机制（tech 6.6）：
 *   - spawn detached:true —— {shell:true} 会先起 shell 再 fork 实际命令，child.kill() 只杀 shell
 *     留孤儿；detached 让子进程成进程组组长，超时用 process.kill(-pid) 杀整个进程组。
 *   - 前台默认超时 2min / 上限 30min（前台阻塞对话轮，需上限）。
 *   - 输出 stdout/stderr 合并，超 30KB 截断 + 落盘。
 *   - run_in_background（S19·G15/G16/G18/G107）：立即返回 taskId，进登记表（跨重启存活）+ 输出边流边
 *     落盘（按编号读回）；进程退出即合成「完成」触发进统一队列（成败队列知悉）；豁免固定超时，但补一道
 *     「长时间无新输出」看门狗兜底停滞（PM 拍板：不定死最长存活，只判停滞——不误杀开发服务器/长构建）。
 *     生命周期仍由 conversation 销毁时的 killBashForConversation 兜底。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BashProposal } from '@shared/types';
import { newMessageId } from '@shared/ids';
import { assertTableGate } from './tableGate';
import { declaredOutputs } from '../table/scriptOutputs';
import { wasWrittenByOruSince } from '../fs/oruWrites';
import {
  type BackgroundCommandRecord,
  appendBackgroundOutput,
  backgroundOutputPath,
  createBackgroundCommand,
  patchBackgroundCommand,
} from './backgroundCommandStore';
import { redactSecrets } from '../platform/redact';
import { recordOutbound } from '../platform/outboundHistory';
import { frameUntrusted } from '../agent/untrustedContent';

// 前台命令超时的单一来源——bash 工具的钳制与描述文案都引用这两个常量（别在别处复制数值）
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_INLINE_OUTPUT = 30 * 1024; // 30KB 内联上限，超出截断 + 落盘

// 后台命令停滞看门狗（G107·PM 拍板口径）：不定「最长跑多久」硬上限（会误杀开发服务器/长构建），
// 只判「长时间没有任何新输出」——正常刷日志的构建、在服务请求的进程都不算停滞，真卡死（无输出无退出）
// 才被终止并当失败回报。判据是最后一次有新输出到现在的间隔。
export const BG_STALL_MS = 30 * 60 * 1000;
const BG_WATCHDOG_TICK_MS = 60 * 1000;

export type BashRunResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  taskId?: string;
  cachePath?: string;
};

// 后台任务运行态登记（内存）：id → 运行句柄。conversation 销毁/按停时按 conversationId 反查全杀；
// 看门狗按 lastOutputAt 反查停滞。持久登记表（跨重启）在 backgroundCommandStore，这里只放本进程运行态。
type BgRuntime = {
  id: string;
  conversationId: string;
  ownerId: string;
  pid: number | null;
  /** killGroup 排好的 SIGKILL 取消句柄：进程若在 2s 宽限内自行退出，cleanup 调它取消 SIGKILL。 */
  cancelKill: () => void;
  /** 最后一次有新输出的时刻——停滞看门狗依据。 */
  lastOutputAt: number;
  /** finalize 只跑一次（close / error / 看门狗 / 按停 竞争时去重）。 */
  finalized: boolean;
  /** 被 killBashForConversation 主动杀（对话销毁/清空/按停）——收尾时不发完成触发（用户已终止，非命令自然完成）。 */
  brakeKilled: boolean;
};
const bgRuntimes = new Map<string, BgRuntime>();

// 后台命令完成通知器（G15）：由 index.ts 注入 = 把「后台命令已结束」作为 task-completed 触发送进
// 统一队列（空闲起播报轮、忙时排队回合末合并）。不注入时静默——单测/无 UI 环境不需要。
type BgCompletionNotifier = (rec: BackgroundCommandRecord) => void;
let completionNotifier: BgCompletionNotifier | null = null;
export function setBackgroundCompletionNotifier(fn: BgCompletionNotifier | null): void {
  completionNotifier = fn;
}

/** conversation 销毁/清空/按停（对话级刹车）时调用——kill 该对话所有后台进程组。 */
export function killBashForConversation(conversationId: string): void {
  for (const rt of bgRuntimes.values()) {
    if (rt.conversationId !== conversationId || rt.pid == null) continue;
    rt.brakeKilled = true; // 主动杀：收尾时不发完成触发（用户终止/对话已走，非命令自然完成）
    // 重排 SIGKILL 取消句柄：进程随后 close 时 cleanup 会调它撤掉待发的 SIGKILL。
    rt.cancelKill = killGroup(rt.pid);
  }
}

/**
 * 跑命令核心 —— spawn 前台/后台 + 截断落盘，返回结果 + 内联文案。
 * bash 工具（信任模式 / 审批通过后）内联调用，把 inlineText 直接作为工具结果返回给模型（chip 即见输出）。
 */
export async function runBashCommand(
  p: BashProposal,
  abortSignal?: AbortSignal,
  onOutput?: (chunk: string) => void,
): Promise<{ result: BashRunResult; inlineText: string }> {
  const cwd = p.cwd ?? process.cwd();
  let timeout = p.timeout ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT_MS;
  if (timeout > MAX_TIMEOUT_MS) timeout = MAX_TIMEOUT_MS;

  // AI 出口闸门（信任/审批两路的共同执行点）：命中未保存草稿 / 非 UTF-8 CSV → 抛错拦截，
  // 错误文本经工具回执/提案失败原样给用户与模型（先请用户保存、或先提转换提案，再重试）。
  // 只读命令跳过编码检查：cat / wc 不改任何字节，不可逆性为零，本就不该被编码闸拦（判据见 tableGate 文件头）。
  // 草稿检查仍照跑——读命令读到的是磁盘版，用户草稿没保存时它看到的就是过期内容，那正是要说的话。
  // 闸门查询超时依赖 DEFAULT_TIMEOUT_MS=2000 默认；渲染端 dirtyFiles 的应答 cap=1200 严格小于它
  // （2026-08-02 闸门修复，见 dirtyFiles.ts）。不要给这里传更小的 timeoutMs，除非同步收紧渲染端 cap。
  await assertTableGate([p.command], { cwd: p.cwd, skipEncodingCheck: p.isReadOnly });

  if (p.runInBackground) {
    // 注：外发加固（G75 输出脱敏 + 落痕迹）只覆盖前台命令——发消息是快命令、不会 run_in_background，
    // 后台外发（run_in_background + delivery）非现实组合，本期不覆盖；真出现再补。
    const result = await startBackground(p, cwd);
    return {
      result,
      inlineText:
        `命令已在后台启动（taskId=${result.taskId}）：${p.command}\n` +
        `它结束时会自动通知你（成败都会）；执行期间可用 read_background_output 传 task_id=${result.taskId} 读取累积输出。`,
    };
  }

  // 执行后校验：快照脚本声明输出所在目录一层的 CSV（不递归扫项目根——大项目全扫成本高）
  const declared = await declaredOutputs(p.command, cwd).catch(() => [] as string[]);
  const startMs = Date.now();
  const before = declared.length > 0 ? await snapshotCsvDirs(declared) : null;

  const run = await runForeground(p.command, cwd, timeout, abortSignal, onOutput);
  // G75 外发出口加固：外发命令（proposal.delivery 非空）的输出脱敏——lark-cli/curl 回显可能带
  // token/密钥；脱敏后再落缓存、内联、读回，堵「输出泄密」。发送正文由命令行子进程直发、抠不出，
  // 不在此重发（PM 2026-07-12「加固现有出口」），但每个投递目标追加一条本地送达痕迹（可审计）。
  if (p.delivery?.length) {
    run.output = redactSecrets(run.output);
    const ts = Date.now();
    for (const d of p.delivery) {
      void recordOutbound({ ts, ownerId: p.ownerId, channel: d.channel, recipient: d.recipient, conversationId: p.conversationId, via: 'command' });
    }
  }
  const cachePath = await writeOutputCache(p, run.output);
  let inlineText = buildInlineOutput(run, cachePath);

  if (before) {
    const after = await snapshotCsvDirs(declared);
    const declaredSet = new Set(declared);
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => !declaredSet.has(path) && after.get(path) !== before.get(path))
      // 执行窗口内经 Oru 自有写盘链路落盘的排除（否则用户保存别的表会被误报）
      .filter((path) => !wasWrittenByOruSince(path, startMs));
    if (changed.length > 0) {
      // 措辞不断言"脚本改写"——只陈述观察（来源可能是任何并发写者）
      inlineText += `\n⚠ 执行期间 ${changed.map((c) => basename(c)).join('、')} 发生了变化（不在脚本声明的输出里），请确认是否符合预期`;
    }
  }
  return { result: { ...run, cachePath }, inlineText };
}

/** 声明输出所在目录（一层）的全部 CSV 快照：absPath → `${mtimeMs}:${size}`。 */
async function snapshotCsvDirs(declared: string[]): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const dir of [...new Set(declared.map((p) => dirname(p)))]) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!/\.csv$/i.test(name)) continue;
      const abs = join(dir, name);
      try {
        const st = await fs.stat(abs);
        snapshot.set(abs, `${Math.floor(st.mtimeMs)}:${st.size}`);
      } catch {
        // 快照间隙被删——按不存在处理
      }
    }
  }
  return snapshot;
}

/** 前台执行：收集合并输出，超时杀进程组；abortSignal abort（用户取消任务）时立即杀子进程组。 */
function runForeground(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  onOutput?: (chunk: string) => void,
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, { shell: true, cwd, detached: true });
    } catch (e) {
      reject(e);
      return;
    }

    let output = '';
    let timedOut = false;
    let aborted = false;
    let cancelKill: (() => void) | undefined;
    const append = (buf: Buffer) => {
      const chunk = buf.toString('utf-8');
      // 收集时即软上限，防超大输出撑爆内存（保留略多于 MAX_INLINE 供落盘）
      if (output.length < MAX_INLINE_OUTPUT * 4) output += chunk;
      onOutput?.(chunk); // G19：边跑边把新输出推给 UI（只给人看）
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    // 取消（cancelTask → ac.abort()）杀子进程组：detached spawn 后 -pid 杀整组、连子进程一起杀。
    // {once:true} + close/error 里显式 removeEventListener 双保险——同一 ac 跨多条命令复用，只靠 once 不够
    // （本仓 CLAUDE.md「AbortSignal 监听」约定）。
    const onAbort = (): void => {
      aborted = true;
      if (child.pid) cancelKill = killGroup(child.pid);
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    const removeAbort = (): void => abortSignal?.removeEventListener('abort', onAbort);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) cancelKill = killGroup(child.pid);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      removeAbort();
      cancelKill?.();
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      removeAbort();
      cancelKill?.(); // 进程已退出 → 取消待发的 SIGKILL，避免 2s 后误杀 pid 复用的无关进程
      const out = timedOut
        ? `${output}\n[命令超时（${Math.round(timeoutMs / 1000)}s），已终止进程组]`
        : aborted
          ? `${output}\n[任务取消，命令进程组已终止]`
          : output;
      resolve({ output: out, exitCode: code, timedOut });
    });
  });
}

/**
 * 后台执行（S19）：立即返回 taskId，进登记表（跨重启存活）+ 输出边流边落盘 + 退出即合成完成触发。
 * 不设固定超时（后台专为长任务设计），改由停滞看门狗（BG_STALL_MS 无新输出）兜底真卡死。
 */
async function startBackground(p: BashProposal, cwd: string): Promise<BashRunResult> {
  const id = `bash-bg-${newMessageId()}`;
  // 完成触发要按对话主分身入队；后台命令的执行上下文无 agentId（同 writeOutputCache），取当前 active。
  const agentId = await import('../agent/store/agents')
    .then((m) => m.listAgents())
    .then((r) => r.activeId ?? '')
    .catch(() => '');
  const startedAt = Date.now();
  const rec: BackgroundCommandRecord = {
    id,
    ownerId: p.ownerId,
    agentId,
    conversationId: p.conversationId,
    command: p.command,
    pid: null,
    status: 'running',
    exitCode: null,
    timedOut: false,
    startedAt,
    finishedAt: null,
    announcedAt: null,
    outputPath: backgroundOutputPath(p.ownerId, id),
  };

  let child;
  try {
    child = spawn(p.command, { shell: true, cwd, detached: true });
  } catch (e) {
    // spawn 就失败（命令不可执行等）：也要登记 + 合成完成触发，否则失败无声烂掉（G15 的初衷）。
    rec.status = 'exited';
    rec.exitCode = 127;
    rec.finishedAt = Date.now();
    await createBackgroundCommand(rec).catch(() => undefined);
    await appendBackgroundOutput(p.ownerId, id, `[无法启动命令] ${(e as Error).message}\n`).catch(
      () => undefined,
    );
    if (!isSubagentConversation(p.conversationId)) completionNotifier?.(rec);
    return { output: '', exitCode: 127, timedOut: false, taskId: id };
  }

  rec.pid = child.pid ?? null;
  await createBackgroundCommand(rec).catch(() => undefined);

  const rt: BgRuntime = {
    id,
    conversationId: p.conversationId,
    ownerId: p.ownerId,
    pid: child.pid ?? null,
    cancelKill: () => {},
    lastOutputAt: startedAt,
    finalized: false,
    brakeKilled: false,
  };
  bgRuntimes.set(id, rt);

  const onData = (buf: Buffer): void => {
    rt.lastOutputAt = Date.now();
    void appendBackgroundOutput(p.ownerId, id, buf.toString('utf-8')).catch(() => undefined);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  child.on('close', (code) => void finalizeBackground(rt, { exitCode: code }));
  child.on('error', (e) =>
    void finalizeBackground(rt, { exitCode: null, errorMessage: (e as Error).message }),
  );

  ensureBgWatchdog();
  child.unref(); // 后台进程脱离父进程生命周期
  return { output: '', exitCode: null, timedOut: false, taskId: id };
}

/** conversationId 是否属于派工 subagent（`task_<taskId>`）——它的完成触发不进主队列（subagent 自有生命周期）。 */
function isSubagentConversation(conversationId: string): boolean {
  return conversationId.startsWith('task_');
}

/**
 * 后台命令收尾（close / error / 看门狗停滞 竞争时只跑一次）：撤 SIGKILL、落终态、追一行退出标记、
 * 合成完成触发（G15）。timedOut=看门狗判停滞而终止。
 */
async function finalizeBackground(
  rt: BgRuntime,
  outcome: { exitCode: number | null; errorMessage?: string; timedOut?: boolean },
): Promise<void> {
  if (rt.finalized) return;
  rt.finalized = true;
  rt.cancelKill(); // 进程已退出 → 取消 killBashForConversation 可能排下的 SIGKILL（防误杀复用 pid）
  bgRuntimes.delete(rt.id);
  maybeStopBgWatchdog();

  const finishedAt = Date.now();
  const marker = outcome.timedOut
    ? `\n[后台命令长时间无新输出（${Math.round(BG_STALL_MS / 60000)} 分钟），已判停滞并终止进程组]\n`
    : outcome.errorMessage
      ? `\n[后台命令进程出错：${outcome.errorMessage}]\n`
      : `\n[后台命令结束，退出码 ${outcome.exitCode}]\n`;
  await appendBackgroundOutput(rt.ownerId, rt.id, marker).catch(() => undefined);

  const patched = await patchBackgroundCommand(rt.ownerId, rt.id, {
    status: 'exited',
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut ?? false,
    finishedAt,
  }).catch(() => null);

  // 完成即触发（G15）：结束——无论成败——作为触发进统一队列，交对话模型知悉/处置。
  // 三种不触发：① 派工 subagent 内起的（完成由 subagent 自身生命周期消化）；② 被 killBashForConversation
  // 主动杀的（用户终止/对话已走，非命令自然完成）。
  if (patched && !rt.brakeKilled && !isSubagentConversation(rt.conversationId)) {
    completionNotifier?.(patched);
  }
}

// ─── 停滞看门狗（G107）─────────────────────────────────────────────
let bgWatchdogTimer: ReturnType<typeof setInterval> | null = null;

function ensureBgWatchdog(): void {
  if (bgWatchdogTimer) return;
  bgWatchdogTimer = setInterval(bgWatchdogTick, BG_WATCHDOG_TICK_MS);
  bgWatchdogTimer.unref?.(); // 看门狗不应拖住进程退出
}

function maybeStopBgWatchdog(): void {
  if (bgWatchdogTimer && bgRuntimes.size === 0) {
    clearInterval(bgWatchdogTimer);
    bgWatchdogTimer = null;
  }
}

/** 扫本进程在跑的后台命令：超过 BG_STALL_MS 没有任何新输出 → 判停滞、杀进程组、按 timedOut 收尾。 */
function bgWatchdogTick(): void {
  const now = Date.now();
  for (const rt of [...bgRuntimes.values()]) {
    if (rt.finalized) continue;
    if (now - rt.lastOutputAt < BG_STALL_MS) continue;
    if (rt.pid != null) rt.cancelKill = killGroup(rt.pid);
    void finalizeBackground(rt, { exitCode: null, timedOut: true });
  }
}

/** 仅测试用：直接驱动一次看门狗扫描（跳过 interval）。 */
export function __bgWatchdogTickForTest(): void {
  bgWatchdogTick();
}

/** 仅测试用：注入一个假的后台运行态，验看门狗/收尾。 */
export function __registerBgRuntimeForTest(rt: {
  id: string;
  conversationId: string;
  ownerId: string;
  lastOutputAt: number;
}): void {
  bgRuntimes.set(rt.id, {
    id: rt.id,
    conversationId: rt.conversationId,
    ownerId: rt.ownerId,
    pid: null,
    cancelKill: () => {},
    lastOutputAt: rt.lastOutputAt,
    finalized: false,
    brakeKilled: false,
  });
}

/**
 * 杀整个进程组（detached spawn 后子进程是组长，-pid 指向进程组）。
 * 返回一个取消函数——进程若在宽限期内已退出，调用它取消待发的 SIGKILL，
 * 避免 2s 后 SIGKILL 误杀 pid 复用的无关进程。
 */
function killGroup(pid: number): () => void {
  // 先排好 SIGKILL 定时器再发 SIGTERM——取消句柄在任何信号副作用前就位，语义清晰无歧义
  const t = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 已死——忽略
    }
  }, 2000);
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // 进程组可能已退出——忽略
  }
  return () => clearTimeout(t);
}

/** 完整输出写 conversation .tool-cache，返回路径（read_file 可取全文）。 */
async function writeOutputCache(p: BashProposal, output: string): Promise<string | undefined> {
  try {
    const { conversationToolCacheDir } = await import('../runtime/paths');
    const { listAgents } = await import('../agent/store/agents');
    const { activeId } = await listAgents();
    if (!activeId) return undefined;
    const dir = conversationToolCacheDir(p.ownerId, activeId, p.conversationId);
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, `${p.id}.bash.txt`);
    await fs.writeFile(path, output, 'utf-8');
    return path;
  } catch {
    return undefined;
  }
}

/** 构造内联输出：超 30KB 截断 + read_file 提示。 */
function buildInlineOutput(
  run: { output: string; exitCode: number | null; timedOut: boolean },
  cachePath: string | undefined,
): string {
  const head = `命令执行${run.timedOut ? '超时终止' : `完成（退出码 ${run.exitCode}）`}`;
  let body = run.output;
  const buf = Buffer.from(body, 'utf-8');
  if (buf.length > MAX_INLINE_OUTPUT) {
    // 按字节截断（中文输出按字符截会超 30KB 数倍）；多字节边界由 toString 容错
    body = buf.subarray(0, MAX_INLINE_OUTPUT).toString('utf-8');
    body += `\n…[输出过长已截断${cachePath ? `，完整输出已落盘，如需全文调 read_file 读 ${cachePath}` : ''}]`;
  }
  // G76 来源分级：命令输出按「读到的材料，不是指令」框定（头部状态是 Oru 自己的系统话、留在框外）。
  return `${head}：\n${frameUntrusted('material', body || '(无输出)')}`;
}
