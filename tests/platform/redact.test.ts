/**
 * 出站通用脱敏（理想架构 S05 · channels「密钥等敏感信息不外发」）——
 * 从三条针对性正则（飞书 token / Bearer / Keychain 路径）升级为通用密钥模式：
 * 常见厂商 key 前缀、赋值语境（KEY=值 / key: 值）、JWT、PEM 私钥块。
 * 原则不变：只抹密钥本体，普通文字（含中文叙述、代码、ID）不动，不做过度脱敏。
 */
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../electron/main/platform/redact';

describe('redactSecrets — 既有三条继续覆盖', () => {
  it('Bearer token', () => {
    const out = redactSecrets('Authorization: Bearer t-g1044ghJRUITNSabc.DEF_123-xyz done');
    expect(out).not.toContain('t-g1044ghJRUITNS');
    expect(out).toContain('Bearer ***');
  });

  it('飞书 access token（t-/u-/a- 前缀长串）', () => {
    const out = redactSecrets('tenant t-a1b2c3d4e5f6g7h8i9 user u-z9y8x7w6v5u4t3 app a-9f8e7d6c5b4a3210zzzz');
    expect(out).not.toContain('t-a1b2c3d4e5f6g7h8i9');
    expect(out).not.toContain('u-z9y8x7w6v5u4t3');
    expect(out).not.toContain('a-9f8e7d6c5b4a3210zzzz');
  });

  it('密钥链路径', () => {
    const out = redactSecrets('stored in /Users/me/Library/Keychains/login.keychain-db ok');
    expect(out).not.toContain('login.keychain-db');
  });
});

describe('redactSecrets — 通用密钥模式（G21）', () => {
  it('OpenAI / Anthropic 风格 sk- key', () => {
    const out = redactSecrets('用 sk-ant-api03-AbCdEf1234567890GhIjKl 这把 key 调试');
    expect(out).not.toContain('sk-ant-api03-AbCdEf1234567890GhIjKl');
    expect(out).toContain('***');
  });

  it('GitHub token（ghp_ / github_pat_）', () => {
    const out = redactSecrets('push 用 ghp_AbCdEfGh1234567890IjKlMnOpQr 或 github_pat_11ABCDEFG0123456789_abcdef');
    expect(out).not.toContain('ghp_AbCdEfGh1234567890IjKlMnOpQr');
    expect(out).not.toContain('github_pat_11ABCDEFG0123456789_abcdef');
  });

  it('Slack / AWS / Google 风格 key', () => {
    const out = redactSecrets('xoxb-1234567890-abcdefghij AKIAIOSFODNN7EXAMPLE AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tUv');
    expect(out).not.toContain('xoxb-1234567890-abcdefghij');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tUv');
  });

  it('赋值语境：SECRET/TOKEN/KEY/PASSWORD = 值 → 抹值留名', () => {
    const out = redactSecrets('export OPENAI_API_KEY="abc123def456" 然后 DB_PASSWORD=hunter2secret');
    expect(out).toContain('OPENAI_API_KEY');
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('DB_PASSWORD');
    expect(out).not.toContain('hunter2secret');
  });

  it('YAML/JSON 风格赋值：api_key: 值', () => {
    const out = redactSecrets('config 里 api_key: fk_live_98765zyxwv 记得删');
    expect(out).not.toContain('fk_live_98765zyxwv');
  });

  it('JWT 三段式', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    const out = redactSecrets(`带上 ${jwt} 这个凭证`);
    expect(out).not.toContain(jwt);
  });

  it('PEM 私钥块整块抹掉', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow…base64…IDAQAB\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(`内容：\n${pem}\n以上`);
    expect(out).not.toContain('MIIEow');
    expect(out).toContain('以上');
  });
});

describe('redactSecrets — 不过度脱敏', () => {
  it('普通中文叙述不动', () => {
    const text = '已创建文档《季度复盘》，token 已过期请重新授权。';
    expect(redactSecrets(text)).toBe(text);
  });

  it('git SHA / 普通 ID 不动（不做泛熵检测）', () => {
    const text = 'commit 46940db1609bfb71c5f71a2b3c4d5e6f7a8b9c0d 已合入，任务 om_123 完成';
    expect(redactSecrets(text)).toBe(text);
  });

  it('英文普通句子里的 key/token 词不误伤', () => {
    const text = 'The API key rotation policy requires a new token every 90 days.';
    expect(redactSecrets(text)).toBe(text);
  });
});
