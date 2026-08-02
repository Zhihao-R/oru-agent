/**
 * 飞书首次适配（tech design §A，落地清单③）——doctor 自检 + 自动配 CLI，省掉首次命令行步骤。
 *
 * 承重 + 红线（必测）：
 * - parseDoctor：解析 `lark-cli doctor` 的 `{checks:[{name,status,message}]}`，全 pass 才算通；CLI 自身报错（ok:false）也不误判通。
 * - autoConfigFeishu：用 credentialStore 的 Secret 自动 `config init`——**App Secret 只走 stdin，绝不进 argv/进程列表**（红线 1），
 *   并 `config default-as bot`（应用身份、免 OAuth）。
 */
import { describe, expect, it, vi } from 'vitest';
import { parseDoctor, autoConfigFeishu, type LarkRunner } from '../../electron/main/platform/feishuSetup';

const DOCTOR_OK = JSON.stringify({
  checks: [
    { name: 'config_file', status: 'pass', message: 'config.json found' },
    { name: 'bot_identity', status: 'pass', message: 'Bot identity: ready' },
    { name: 'endpoint_open', status: 'pass', message: 'reachable' },
  ],
});
const DOCTOR_FAIL = JSON.stringify({
  checks: [
    { name: 'config_file', status: 'pass', message: 'found' },
    { name: 'bot_identity', status: 'fail', message: 'not configured' },
  ],
});

describe('parseDoctor', () => {
  it('全部 pass → ok，逐项回显', () => {
    const r = parseDoctor(DOCTOR_OK);
    expect(r.ok).toBe(true);
    expect(r.checks).toHaveLength(3);
    expect(r.checks[0]).toEqual({ name: 'config_file', status: 'pass', message: 'config.json found' });
  });
  it('有 fail → 不 ok（仍逐项回显，让用户看到哪项红）', () => {
    const r = parseDoctor(DOCTOR_FAIL);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'bot_identity')?.status).toBe('fail');
  });
  it('CLI 自身报错（结构化 {ok:false,error}）→ 不 ok、带 error 提示，不误判通', () => {
    const r = parseDoctor(JSON.stringify({ ok: false, error: { type: 'config', hint: '先 config init' } }));
    expect(r.ok).toBe(false);
    expect(r.checks).toEqual([]);
    expect(r.error).toContain('config init');
  });
  it('非 JSON 容错（不 ok、不抛）', () => {
    expect(parseDoctor('boom').ok).toBe(false);
  });
});

describe('autoConfigFeishu（红线 1：secret 走 stdin）', () => {
  function fakeRun() {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const run: LarkRunner = vi.fn(async (args, opts) => {
      calls.push({ args, stdin: opts?.stdin });
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    });
    return { run, calls };
  }

  it('config init 用 --app-secret-stdin、secret 经 stdin，绝不进 argv', async () => {
    const { run, calls } = fakeRun();
    const r = await autoConfigFeishu({ appId: 'cli_abc', appSecret: 'SECRET_xyz' }, run);
    expect(r.ok).toBe(true);
    const init = calls.find((c) => c.args.includes('init'))!;
    expect(init.args).toContain('--app-secret-stdin');
    expect(init.args).toContain('cli_abc'); // appId 可进 argv（非密）
    expect(init.stdin).toBe('SECRET_xyz'); // secret 走 stdin
    // 红线：secret 绝不出现在任何命令行参数里
    expect(calls.every((c) => c.args.every((a) => !a.includes('SECRET_xyz')))).toBe(true);
  });

  it('设应用身份 default-as bot（免 OAuth）', async () => {
    const { run, calls } = fakeRun();
    await autoConfigFeishu({ appId: 'cli_abc', appSecret: 's' }, run);
    expect(calls.some((c) => c.args.join(' ') === 'config default-as bot')).toBe(true);
  });

  it('config init 失败 → ok:false，不再设身份', async () => {
    const calls: string[][] = [];
    const run: LarkRunner = vi.fn(async (args) => {
      calls.push(args);
      return { exitCode: 1, stdout: '', stderr: '{"ok":false,"error":{"subtype":"bad_secret"}}' };
    });
    const r = await autoConfigFeishu({ appId: 'cli_abc', appSecret: 's' }, run);
    expect(r.ok).toBe(false);
    expect(calls.some((a) => a.includes('default-as'))).toBe(false); // init 没过就不往下走
  });
});
