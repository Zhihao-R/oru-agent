/**
 * 带 SSRF 防护的 GET 原语——逐跳重新过 checkUrlSafe。
 *
 * 关键：`redirect: 'manual'` 逐跳重新校验落点。若用 `redirect: 'follow'`，
 * checkUrlSafe 只校验初始 URL，攻击者让公网 host 302 跳到 169.254.169.254 / 127.0.0.1 /
 * 内网地址即可绕过 SSRF 把字节拉回来——引擎返回的 URL 本就不可信，这条必须堵（决策 6 / §6 安全）。
 *
 * 图片下载与网页抓取共用 safeFetchManual 这条逐跳原语，避免两份重定向逻辑漂移。
 */
import { checkUrlSafe } from './ssrf';
import { readBoundedBytes } from './selector';

const MAX_REDIRECTS = 5;
const USER_AGENT = 'Oru/0.1 (+https://oru.app)';

export class ImageFetchError extends Error {}

export type SafeImageFetchResult = { bytes: Uint8Array; mime: string };

/**
 * 逐跳 SSRF 校验 + 短超时的 GET：手动跟随 3xx，每一跳（含重定向落点）都过 checkUrlSafe。
 * 终态（非 3xx）的 Response 交给 consume 回调消费——超时与 abort 在 consume 期间仍然有效，
 * 故 body 读取也受超时保护。consume 返回什么，本函数就返回什么。
 * 抛 ImageFetchError：SSRF 命中、缺 Location、重定向超限。
 */
export async function safeFetchManual<T>(
  url: string,
  opts: {
    headers: Record<string, string>;
    timeoutMs: number;
    signal: AbortSignal;
    maxRedirects?: number;
  },
  consume: (res: Response) => Promise<T>,
): Promise<T> {
  const max = opts.maxRedirects ?? MAX_REDIRECTS;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= max; hop += 1) {
      await checkUrlSafe(current); // 每一跳都校验，含 redirect 落点
      const res = await fetch(current, {
        headers: opts.headers,
        signal: ctrl.signal,
        redirect: 'manual',
      });
      // 3xx：手动跟随，把 Location 解析成绝对 URL 后下一跳再校验
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new ImageFetchError(`HTTP ${res.status} 无 Location`);
        current = new URL(loc, current).toString();
        continue;
      }
      return await consume(res);
    }
    throw new ImageFetchError(`重定向超过 ${max} 跳`);
  } finally {
    clearTimeout(t);
    opts.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 安全拉取图片字节：逐跳 SSRF 校验 + 短超时 + 体积上限。
 * 抛 ImageFetchError 的情形：SSRF 命中、!ok、重定向超限、超体积（overflow）、空响应。
 * 返回 mime = content-type 的类型部分（缺省时为 ''，由调用方决定是否靠 magic bytes 兜底）。
 */
export async function safeImageFetch(
  url: string,
  opts: { maxBytes: number; timeoutMs: number; signal: AbortSignal },
): Promise<SafeImageFetchResult> {
  return safeFetchManual(
    url,
    {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    },
    async (res) => {
      if (!res.ok) throw new ImageFetchError(`HTTP ${res.status}`);
      const mime = (res.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
      const { bytes, overflow } = await readBoundedBytes(res, opts.maxBytes);
      if (overflow) throw new ImageFetchError('图太大（超过体积上限）');
      if (bytes.byteLength === 0) throw new ImageFetchError('空响应');
      return { bytes, mime };
    },
  );
}
