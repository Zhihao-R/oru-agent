/**
 * SSRF 防护单测——核心：拦私有 IP / cloud 元数据；不误伤公网域名。
 *
 * 注意：DNS 解析判断会在 CI 网络条件不佳时不稳定，本测试只覆盖直接 IP / 已知 host 路径。
 */
import { describe, expect, it } from 'vitest';
import {
  __isV4BlockedForTest,
  checkUrlSafe,
  SsrfBlockedError,
} from '../../electron/main/search/ssrf';

describe('ssrf', () => {
  it('private v4 ranges blocked', () => {
    expect(__isV4BlockedForTest('10.0.0.1')).toBe(true);
    expect(__isV4BlockedForTest('172.16.0.1')).toBe(true);
    expect(__isV4BlockedForTest('192.168.1.1')).toBe(true);
    expect(__isV4BlockedForTest('169.254.169.254')).toBe(true);
    expect(__isV4BlockedForTest('127.0.0.1')).toBe(true);
  });

  it('public v4 not blocked', () => {
    expect(__isV4BlockedForTest('8.8.8.8')).toBe(false);
    expect(__isV4BlockedForTest('1.1.1.1')).toBe(false);
    expect(__isV4BlockedForTest('151.101.1.69')).toBe(false);
  });

  it('checkUrlSafe rejects localhost', async () => {
    await expect(checkUrlSafe('http://localhost:8080/x')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(checkUrlSafe('http://127.0.0.1/x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('checkUrlSafe rejects private IPv4', async () => {
    await expect(checkUrlSafe('http://192.168.1.1/admin')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(checkUrlSafe('http://10.0.0.1/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('checkUrlSafe rejects metadata endpoints', async () => {
    await expect(checkUrlSafe('http://169.254.169.254/latest/')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(checkUrlSafe('http://metadata.google.internal/')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('checkUrlSafe rejects bracketed IPv6 literals (loopback / IPv4-mapped)', async () => {
    // u.hostname 带方括号——剥括号后才判得中（第二轮 review 抓到的绕过）
    await expect(checkUrlSafe('http://[::1]:8080/x')).rejects.toBeInstanceOf(SsrfBlockedError);
    // IPv4-mapped 127.0.0.1（new URL 归一成 hex 形态 [::ffff:7f00:1]）
    await expect(checkUrlSafe('http://[::ffff:7f00:1]/x')).rejects.toBeInstanceOf(SsrfBlockedError);
    // IPv4-mapped 云元数据 169.254.169.254
    await expect(
      checkUrlSafe('http://[::ffff:169.254.169.254]/latest/'),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    // IPv6 未指定地址（可路由到本机，与 v4 的 0.0.0.0 对齐）
    await expect(checkUrlSafe('http://[::]/x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('checkUrlSafe rejects non-http(s) protocol', async () => {
    await expect(checkUrlSafe('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(checkUrlSafe('ftp://example.com/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('checkUrlSafe rejects malformed URL', async () => {
    await expect(checkUrlSafe('not a url')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
