/**
 * 密钥保管内核（S07·G55）——加解密往返、前缀判据、降级与解不开的兜底。
 * safeStorage 用可控 mock 模拟三种世界：可加密 / 不可用 / 解密抛错。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// 用可切换的 mock 模拟 safeStorage 的三种状态
const state = {
  available: true,
  // 简易「加密」：可逆变换，够测往返；解密对非本方案密文抛错
  fail: false,
};
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (s: string) => Buffer.from(`CIPHER(${s})`, 'utf-8'),
    decryptString: (b: Buffer) => {
      if (state.fail) throw new Error('keychain mismatch');
      const raw = b.toString('utf-8');
      const m = /^CIPHER\((.*)\)$/s.exec(raw);
      if (!m) throw new Error('not our cipher');
      return m[1];
    },
  },
}));

import {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  isSecretEncryptionAvailable,
} from '../../electron/main/backup/keyVault';

beforeEach(() => {
  state.available = true;
  state.fail = false;
});

describe('keyVault 加解密往返', () => {
  it('明文加密后带前缀、能解回原文', () => {
    const enc = encryptSecret('sk-secret-123');
    expect(isEncryptedSecret(enc)).toBe(true);
    expect(enc).not.toContain('sk-secret-123'); // 落盘不含明文
    expect(decryptSecret(enc)).toBe('sk-secret-123');
  });

  it('空串原样返回、不加密', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
  });

  it('已是密文不重复加密（幂等）', () => {
    const enc = encryptSecret('key');
    expect(encryptSecret(enc)).toBe(enc);
  });

  it('存量明文（无前缀）decrypt 原样放行——兼容迁移', () => {
    expect(decryptSecret('legacy-plaintext-key')).toBe('legacy-plaintext-key');
  });
});

describe('降级与兜底', () => {
  it('加密不可用时降级明文保管、不丢钥', () => {
    state.available = false;
    expect(isSecretEncryptionAvailable()).toBe(false);
    const enc = encryptSecret('sk-secret-123');
    expect(enc).toBe('sk-secret-123'); // 明文落盘（无 keychain 环境的唯一选择）
    expect(isEncryptedSecret(enc)).toBe(false);
  });

  it('解不开（换机/keychain 变动）返回空串、不把乱码当 key', () => {
    const enc = encryptSecret('sk-secret-123');
    state.fail = true; // 模拟到了另一台机器
    expect(decryptSecret(enc)).toBe('');
  });
});
