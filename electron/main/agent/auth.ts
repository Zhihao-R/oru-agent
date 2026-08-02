import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AuthMode, ClaudeAuthStatus } from '@shared/types';
import { getSettings } from '../projects/store';
import { buildSubprocessEnv } from '../engine/subprocessEnv';

const CLAUDE_CREDENTIALS = join(homedir(), '.claude', '.credentials.json');

// Claude Code v2+ 把凭证迁到了 macOS Keychain，老的 .credentials.json 文件不再生成
function hasClaudeCliCredentials(): boolean {
  if (existsSync(CLAUDE_CREDENTIALS)) return true;
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
      stdio: 'ignore',
      timeout: 2000,
    });
    if (r.status === 0) return true;
  }
  // TODO: Linux (libsecret) / Windows (wincred) 的凭证存储检测
  return false;
}

export async function detectAuth(): Promise<ClaudeAuthStatus> {
  if (hasClaudeCliCredentials()) {
    return {
      mode: 'claude_cli',
      ready: true,
      hint: '已复用 Claude Code 桌面端登录态',
    };
  }
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) {
    return {
      mode: 'env_api_key',
      ready: true,
      hint: '使用环境变量 ANTHROPIC_API_KEY',
    };
  }
  const settings = await getSettings();
  if (settings.manualApiKey && settings.manualApiKey.length > 0) {
    return {
      mode: 'manual_api_key',
      ready: true,
      hint: '使用手动填写的 API Key',
    };
  }
  return {
    mode: 'none',
    ready: false,
    hint: '尚未检测到鉴权；请登录 Claude Code 或在设置里填入 API Key',
  };
}

/**
 * 给 SDK 用的 API key（claude_cli 模式下不传，让 SDK 自己继承凭据）
 */
export async function resolveApiKeyForSdk(mode: AuthMode): Promise<string | undefined> {
  if (mode === 'env_api_key') return process.env.ANTHROPIC_API_KEY;
  if (mode === 'manual_api_key') return (await getSettings()).manualApiKey ?? undefined;
  return undefined;
}

/**
 * claude-code SDK 子进程的完整 env：鉴权探测 → API key 解析 → 剥 ANTHROPIC_BASE_URL / 补 key。
 * 收口原散在 7 个调用方的这条三步链（M4）——只有 ClaudeCodeBackend 需要它（HTTP 后端 HTTP 直连），
 * 故由 factory 在构造 ClaudeCodeBackend 时调一次、注入构造器。
 */
export async function resolveSubprocessEnv(): Promise<Record<string, string | undefined>> {
  const auth = await detectAuth();
  const apiKey = await resolveApiKeyForSdk(auth.mode);
  return buildSubprocessEnv(apiKey);
}
