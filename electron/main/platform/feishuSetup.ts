/**
 * 飞书首次适配（tech design §A，落地清单③）——doctor 自检 + 自动配 CLI，把首次的命令行步骤全省掉。
 *
 * - parseDoctor：解析 `lark-cli doctor`（默认 JSON：`{checks:[{name,status,message}]}`）→ 全 pass 才算通；
 *   CLI 自身报错（结构化 `{ok:false,error}`）→ 不误判通、带 hint。
 * - autoConfigFeishu：用 credentialStore 的 App Secret 自动 `config init`（**secret 只走 stdin**，红线 1）
 *   + `config default-as bot`（应用身份、免 OAuth，对应 PRD「应用身份 tenant」）。
 *
 * 凭证只在主进程（红线 1）：appId 非密可进 argv，App Secret 经 stdin 喂（不进命令行 / 进程列表 / env）。
 */
import { runLarkCli, type LarkCliResult } from './feishuCli';
import type { FeishuCredential } from './credentialStore';

/** 注入的 lark-cli 执行器（取 runLarkCli 真实签名的承重子集，便于测试瞬时化）。 */
export type LarkRunner = (
  args: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<Pick<LarkCliResult, 'exitCode' | 'stdout' | 'stderr'>>;

export interface DoctorCheck {
  name: string;
  status: string; // pass / fail / warn…（透传 CLI 原值）
  message: string;
}
export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
  /** CLI 自身报错（非逐项检查）时的 hint。 */
  error?: string;
}

/** 解析 `lark-cli doctor` 输出。全 pass 才 ok；CLI 结构化报错 / 非 JSON → 不 ok，绝不误判通。 */
export function parseDoctor(output: string): DoctorResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { ok: false, checks: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, checks: [] };
  const o = parsed as { checks?: unknown; ok?: unknown; error?: { hint?: string } };
  // CLI 自身报错形态：{ok:false, error:{...}}，没有 checks
  if (o.ok === false && !Array.isArray(o.checks)) {
    return { ok: false, checks: [], error: o.error?.hint };
  }
  if (!Array.isArray(o.checks)) return { ok: false, checks: [] };
  const checks: DoctorCheck[] = o.checks
    .filter((c): c is { name?: unknown; status?: unknown; message?: unknown } => !!c && typeof c === 'object')
    .map((c) => ({ name: String(c.name ?? ''), status: String(c.status ?? ''), message: String(c.message ?? '') }));
  return { ok: checks.length > 0 && checks.every((c) => c.status === 'pass'), checks };
}

/**
 * 自动配飞书 CLI：`config init`（appId 进 argv、Secret 走 stdin）+ `config default-as bot`（应用身份）。
 * init 没过就不往下设身份。run 注入便于测试（红线：断言 secret 不进 argv）。
 */
export async function autoConfigFeishu(cred: FeishuCredential, run: LarkRunner): Promise<{ ok: boolean; error?: string }> {
  const init = await run(['config', 'init', '--app-id', cred.appId, '--app-secret-stdin', '--brand', 'feishu'], {
    stdin: cred.appSecret,
    timeoutMs: 30_000,
  });
  if (init.exitCode !== 0) return { ok: false, error: init.stderr || init.stdout };
  const ident = await run(['config', 'default-as', 'bot'], { timeoutMs: 30_000 });
  if (ident.exitCode !== 0) return { ok: false, error: ident.stderr || ident.stdout };
  return { ok: true };
}

// ─────────────── 生产接线（真实 runLarkCli） ───────────────

/** 跑 `lark-cli doctor` 并解析（设置页「检查」用）。 */
export async function runDoctor(): Promise<DoctorResult> {
  const res = await runLarkCli(['doctor'], { timeoutMs: 30_000 });
  // doctor 成功走 stdout、CLI 报错可能走 stderr——取能解析出 checks/error 的
  const fromStdout = parseDoctor(res.stdout);
  if (fromStdout.checks.length) return fromStdout;
  const fromStderr = parseDoctor(res.stderr);
  return fromStderr.checks.length || fromStderr.error ? fromStderr : fromStdout;
}

/** 用已存的凭证自动配 CLI（保存凭证后调；红线 1：secret 经 stdin）。 */
export function configFeishuFromCredential(cred: FeishuCredential): Promise<{ ok: boolean; error?: string }> {
  return autoConfigFeishu(cred, runLarkCli);
}
