/**
 * 飞书 CLI 输出安全处理（tech design §7，§11「CLI 错误脱敏 / 认证失效」）。
 *
 * detectAuthFailure：lark-cli 输出结构化 JSON {ok:false, error:{type,subtype,hint}}；据此检测认证失效
 *   （未配置 / 过期 / 撤销）→ 回「重新授权」链接，而非沉默或假装成功。普通校验错误（缺参）不算认证失效。
 * 输出脱敏（含 hint）走通用 redact.ts，其自身用例见 redact.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { detectAuthFailure } from '../../electron/main/platform/feishuCli';

describe('detectAuthFailure', () => {
  it('未配置（not_configured）→ 需重新授权 + 带 hint', () => {
    const json = JSON.stringify({
      ok: false,
      error: { type: 'config', subtype: 'not_configured', message: 'not configured', hint: '去授权' },
    });
    const r = detectAuthFailure(json);
    expect(r.needsReauth).toBe(true);
    expect(r.hint).toBe('去授权');
  });

  it('hint 含 token → 脱敏（红线 1：hint 会经 scopeCheck.error 透到 UI，不能漏 token）', () => {
    const json = JSON.stringify({
      ok: false,
      error: { type: 'auth', subtype: 'token_revoked', hint: 'token u-z9y8x7w6v5u4t3abc 已撤销，重新登录' },
    });
    const r = detectAuthFailure(json);
    expect(r.needsReauth).toBe(true);
    expect(r.hint).not.toContain('u-z9y8x7w6v5u4t3abc');
    expect(r.hint).toContain('***');
  });

  it('token 过期 / 撤销 → 需重新授权', () => {
    const json = JSON.stringify({ ok: false, error: { type: 'auth', subtype: 'token_expired', message: 'expired' } });
    expect(detectAuthFailure(json).needsReauth).toBe(true);
  });

  it('现行 wire 类目 authentication（上游 errs/category.go）→ 需重新授权', () => {
    // S4 对拍核实：lark-cli 实际输出 type:"authentication"（不是旧版 "auth"），subtype 为 token_invalid 等
    for (const subtype of ['token_missing', 'token_invalid', 'token_expired', 'refresh_token_expired']) {
      const json = JSON.stringify({ ok: false, error: { type: 'authentication', subtype, message: 'x' } });
      expect(detectAuthFailure(json).needsReauth, subtype).toBe(true);
    }
  });

  it('凭证错误（invalid_client）→ 需重新授权（重新配置）', () => {
    const json = JSON.stringify({ ok: false, error: { type: 'config', subtype: 'invalid_client', message: 'x' } });
    expect(detectAuthFailure(json).needsReauth).toBe(true);
  });

  it('普通校验错误（缺参）不算认证失效', () => {
    const json = JSON.stringify({ ok: false, error: { type: 'validation', subtype: 'invalid_argument', message: 'x' } });
    expect(detectAuthFailure(json).needsReauth).toBe(false);
  });

  it('成功输出（ok:true）不算认证失效', () => {
    expect(detectAuthFailure(JSON.stringify({ ok: true, data: {} })).needsReauth).toBe(false);
  });

  it('非 JSON 输出不误判（容错返回 false）', () => {
    expect(detectAuthFailure('plain text log line').needsReauth).toBe(false);
  });
});
