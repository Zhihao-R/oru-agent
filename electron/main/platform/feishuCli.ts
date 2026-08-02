/**
 * 飞书 CLI 接线（tech design §7）——官方 larksuite/cli，作为 agent 命令用（写飞书文档/表格）。
 *
 * 本文件落地承重纯 helper（§11 必测）：
 *  - detectAuthFailure：解析 lark-cli 的结构化 JSON {ok:false, error:{type,subtype,hint}}，
 *    认证失效（未配置 / 过期 / 撤销）时回「重新授权」链接，而非沉默或假装成功。
 *  - 输出脱敏走通用 redact.ts（S05 起从本文件三条针对性正则升级为通用密钥模式）。
 *
 * 凭证隔离（红线 1）：lark-cli 把 token 存进操作系统原生密钥链（不进 env、不进日志）——天然满足，
 * 我们不靠裸环境变量把 secret 透传给子进程。app-secret 经 stdin 喂 `config init`（不进命令行 / 进程列表）。
 * headless 授权：`lark-cli config init --new` 阻塞并输出验证 URL，Oru 把 URL 经平台消息发给你点一次
 * （PoC 实测；安装 / 认证 / 用前 `skills read lark-doc` 的实跑接线在 gatewayWiring / 设置页落地）。
 */

import { spawn } from 'node:child_process';
import { redactSecrets } from './redact';

/** lark-cli 结构化错误里「认证 / 配置」类——据此判定需重新授权（区别于缺参等普通校验错误）。
 * 'authentication' 是现行 wire 类目（上游 errs/category.go）；'auth' 是旧版兼容保留。 */
const AUTH_ERROR_TYPES = new Set(['config', 'authentication', 'auth']);
const AUTH_ERROR_SUBTYPES = new Set([
  'not_configured',
  'invalid_client',
  'token_missing',
  'token_expired',
  'token_invalid',
  'token_revoked',
  'refresh_token_invalid',
  'refresh_token_expired',
  'refresh_token_revoked',
  'refresh_token_reused',
  'unauthorized',
  'invalid_token',
  'forbidden',
]);

export interface AuthFailure {
  needsReauth: boolean;
  hint?: string;
}

/**
 * 解析 lark-cli --json 输出，判断是否认证失效。认证 / 配置类 → needsReauth + hint（引导重新授权）；
 * 普通校验错误（invalid_argument 等）、成功（ok:true）、非 JSON 一律 false（不误判、不沉默）。
 */
export function detectAuthFailure(output: string): AuthFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { needsReauth: false };
  }
  if (!parsed || typeof parsed !== 'object') return { needsReauth: false };
  const obj = parsed as { ok?: unknown; error?: { type?: string; subtype?: string; hint?: string } };
  if (obj.ok !== false) return { needsReauth: false };
  const err = obj.error ?? {};
  if ((err.type && AUTH_ERROR_TYPES.has(err.type)) || (err.subtype && AUTH_ERROR_SUBTYPES.has(err.subtype))) {
    // hint 是 LarkCliResult 里唯一从未脱敏 JSON 解出的外泄字段（会经 scopeCheck.error 透到 UI）——源头脱敏
    return { needsReauth: true, hint: err.hint ? redactSecrets(err.hint) : undefined };
  }
  return { needsReauth: false };
}

// ─────────────── lark-cli 执行器 ───────────────

export interface LarkCliResult {
  exitCode: number | null;
  stdout: string; // 已脱敏
  stderr: string; // 已脱敏
  parsed?: unknown; // stdout 解析出的 JSON（--json 时）
  authFailure: AuthFailure;
}

/** 返回 text 本身当且仅当它能解析成 JSON 对象，否则 undefined（用于在 stdout/stderr 间挑出 JSON 那条）。 */
function tryJsonText(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    JSON.parse(t);
    return t;
  } catch {
    return undefined;
  }
}

/** 默认走 npx（无需全局安装）；ORU_LARK_CLI_BIN 可指向已装的 lark-cli 二进制。 */
const LARK_BIN = process.env.ORU_LARK_CLI_BIN;
const SPAWN_BASE = LARK_BIN ? { cmd: LARK_BIN, prefix: [] as string[] } : { cmd: 'npx', prefix: ['@larksuite/cli@latest'] };

/**
 * 跑一条 lark-cli 命令（tech design §7）。app-secret 等敏感输入经 stdin 喂（不进命令行 / 进程列表）；
 * 输出回发 / 落盘前已脱敏；解析结构化 JSON 并检测认证失效。env 不注入任何凭证（红线 1，token 在密钥链）。
 */
export function runLarkCli(args: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<LarkCliResult> {
  return new Promise((resolve) => {
    // detached：npx 会再 fork 真正的 lark-cli（孙进程），child.kill 只打得到 npx 本身——
    // detached 让子进程成进程组组长，超时 kill(-pid) 杀整组，挂死的 CLI 不成孤儿
    // （同 executeBashProposal 的进程组模式；该模式无平台分支，本仓只跑 POSIX）。
    const child = spawn(SPAWN_BASE.cmd, [...SPAWN_BASE.prefix, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    let err = '';
    // 保持既有直接 SIGKILL 语义（不升级成 bash 路径的 SIGTERM→宽限→SIGKILL 分级），只扩大打击面
    const killChildGroup = (): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // 进程组可能已退出——忽略
        }
      } else {
        child.kill('SIGKILL'); // spawn 失败无 pid 时退回单进程 kill
      }
    };
    const timer = opts?.timeoutMs ? setTimeout(killChildGroup, opts.timeoutMs) : null;
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    if (opts?.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // lark-cli 成功走 stdout、结构化错误走 stderr（PoC 实测）——两边都看，取能解析出 JSON 的那条
      const jsonText = tryJsonText(out) ?? tryJsonText(err);
      resolve({
        exitCode: code,
        stdout: redactSecrets(out),
        stderr: redactSecrets(err),
        parsed: jsonText ? JSON.parse(jsonText) : undefined,
        authFailure: detectAuthFailure(jsonText ?? ''),
      });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: redactSecrets(String(e)), authFailure: { needsReauth: false } });
    });
  });
}
