import { describe, it, expect, afterEach } from 'vitest';
import { buildSubprocessEnv } from '../../electron/main/engine/subprocessEnv';

// 回归：shell 残留 ANTHROPIC_BASE_URL 曾劫持 claude-code 子进程请求（docs/bug/2026-06-09）
describe('buildSubprocessEnv', () => {
  const saved = process.env.ANTHROPIC_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
  });

  it('剥掉 shell 里的 ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example.com';
    const env = buildSubprocessEnv();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('apiKey 覆盖 ANTHROPIC_API_KEY，其余 env 透传', () => {
    const env = buildSubprocessEnv('sk-test');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('不传 apiKey 时不动 ANTHROPIC_API_KEY', () => {
    const env = buildSubprocessEnv(null);
    expect(env.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
  });
});
