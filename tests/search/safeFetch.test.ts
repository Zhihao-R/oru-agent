/**
 * safeFetchManual 逐跳 SSRF 校验（审计 C1）
 *
 * 核心不变量：手动跟随 3xx，每一跳（含重定向落点）都过 checkUrlSafe。
 * 旧实现用 redirect:'follow' 只校验初始 URL，公网 host 302 跳 169.254.169.254 即绕过。
 * 用直接 IP 作初始 URL 避免 DNS 解析（与 ssrf.test 同策略）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetchManual } from '../../electron/main/search/safeFetch';
import { SsrfBlockedError } from '../../electron/main/search/ssrf';

function resp(status: number, headers: Record<string, string>, body = ''): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: null,
    async text() {
      return body;
    },
  } as unknown as Response;
}

const opts = () => ({
  headers: { 'User-Agent': 'test' },
  timeoutMs: 5000,
  signal: new AbortController().signal,
});

describe('safeFetchManual (C1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('302 跳云元数据 / 内网 → 落点被 checkUrlSafe 拦，不发第二跳', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(resp(302, { location: 'http://169.254.169.254/latest/meta-data/' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      safeFetchManual('http://8.8.8.8/', opts(), async () => 'unreachable'),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    // 初始跳发了一次 fetch；落点在 fetch 前就被 checkUrlSafe 拦掉
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('用 redirect:manual 而非 follow', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(200, { 'content-type': 'text/plain' }, 'ok'));
    vi.stubGlobal('fetch', fetchMock);

    await safeFetchManual('http://8.8.8.8/', opts(), async (r) => r.text());
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });

  it('跟随到公网落点 → consume 拿到终态 Response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(302, { location: 'http://1.1.1.1/page' }))
      .mockResolvedValueOnce(resp(200, { 'content-type': 'text/plain' }, 'hello'));
    vi.stubGlobal('fetch', fetchMock);

    const out = await safeFetchManual('http://8.8.8.8/', opts(), async (r) => r.text());
    expect(out).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('重定向超 5 跳 → 抛错', async () => {
    // 每跳都跳到下一个公网 IP，永不终止
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      n += 1;
      return resp(302, { location: `http://1.0.0.${n}/` });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetchManual('http://8.8.8.8/', opts(), async () => 'x')).rejects.toThrow(
      /重定向超过/,
    );
  });
});
