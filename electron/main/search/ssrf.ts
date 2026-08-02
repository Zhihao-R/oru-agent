/**
 * SSRF 防护：拦截目标 URL 是私有 IP / cloud 元数据端点。
 *
 * 已知风险（接受为 MVP）：DNS rebinding——攻击者能让 fetch 实际请求时再次 DNS lookup
 * 拿到不同 IP。彻底防需用"自己解析 IP → 直连 IP + Host header + TLS SNI"，工程量×3。
 * 单用户桌面应用风险低，本期接受；详见 tech-design §7.1.1。
 */
import { promises as dns } from 'node:dns';

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '::', // IPv6 未指定地址——与 v4 的 0.0.0.0 对齐（可路由到本机，必须挡）
  '0.0.0.0',
  '169.254.169.254', // AWS / GCP metadata
  'metadata.google.internal',
  'metadata.azure.com',
]);

/** CIDR ranges that are private / link-local / loopback */
type CidrV4 = { net: number; mask: number };
const BLOCKED_V4: CidrV4[] = [
  parseV4Cidr('10.0.0.0/8'),
  parseV4Cidr('172.16.0.0/12'),
  parseV4Cidr('192.168.0.0/16'),
  parseV4Cidr('169.254.0.0/16'),
  parseV4Cidr('127.0.0.0/8'),
  parseV4Cidr('0.0.0.0/8'),
];

const BLOCKED_V6_PREFIXES = ['fc', 'fd', 'fe80']; // ULA + link-local（粗略）

function parseV4Cidr(cidr: string): CidrV4 {
  const [ip, prefix] = cidr.split('/');
  const net = ipv4ToInt(ip);
  const bits = Number(prefix);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: net & mask, mask };
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return -1;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isV4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n < 0) return false;
  for (const { net, mask } of BLOCKED_V4) {
    if ((n & mask) === net) return true;
  }
  return false;
}

function isV6Blocked(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower === '::' || lower.startsWith('::ffff:')) {
    // ipv4-mapped——按 v4 判
    const v4 = lower.replace('::ffff:', '');
    return isV4Blocked(v4);
  }
  return BLOCKED_V6_PREFIXES.some((p) => lower.startsWith(p));
}

export class SsrfBlockedError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`SSRF blocked: ${url} (${reason})`);
  }
}

/**
 * 从 IPv4-mapped IPv6（`::ffff:x.x.x.x` 或归一后的 hex `::ffff:a9fe:a9fe` / `::ffff:7f00:1`）
 * 抽出内嵌的 IPv4，供按 v4 规则判私网。`new URL` 会把 `[::ffff:169.254.169.254]` 归一成 hex 形态，
 * 故 hex 双段必须解析——否则攻击者用 IPv6 表达式即可绕过 v4 黑名单（第二轮 review 实测的绕过）。
 */
function extractMappedV4(host: string): string | null {
  const m = host.match(/^::ffff:(.+)$/i);
  if (!m) return null;
  const tail = m[1];
  if (tail.includes('.')) return tail; // 点分四段直接是 IPv4
  const parts = tail.split(':'); // 两段 16-bit hex，如 7f00:1 → 127.0.0.1
  if (parts.length !== 2) return null;
  const h1 = parseInt(parts[0], 16);
  const h2 = parseInt(parts[1], 16);
  if (Number.isNaN(h1) || Number.isNaN(h2) || h1 > 0xffff || h2 > 0xffff) return null;
  return [(h1 >> 8) & 0xff, h1 & 0xff, (h2 >> 8) & 0xff, h2 & 0xff].join('.');
}

/** 判一个 IPv6 字面量（已剥方括号）是否私有/回环——含 IPv4-mapped 还原。 */
function isV6HostBlocked(host: string): boolean {
  const mapped = extractMappedV4(host);
  if (mapped && isV4Blocked(mapped)) return true;
  return isV6Blocked(host);
}

/**
 * 校验 URL 安全。命中则抛 SsrfBlockedError。
 * 仅校验 http(s)；其他 scheme（file:// / data:// 等）一律拒。
 */
export async function checkUrlSafe(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SsrfBlockedError(url, 'invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfBlockedError(url, `disallowed protocol: ${u.protocol}`);
  }
  // u.hostname 对 IPv6 字面量带方括号（如 "[::1]"）——剥掉再判，否则黑名单/前缀全失配（绕过）
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new SsrfBlockedError(url, `blocked host: ${hostname}`);
  }
  // 形如 192.168.x.x 直接判
  if (isV4Blocked(hostname)) {
    throw new SsrfBlockedError(url, `private IPv4: ${hostname}`);
  }
  if (hostname.includes(':') && isV6HostBlocked(hostname)) {
    throw new SsrfBlockedError(url, `private IPv6: ${hostname}`);
  }
  // DNS resolve（域名场景）
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    for (const { address, family } of addrs) {
      if (family === 4 && isV4Blocked(address)) {
        throw new SsrfBlockedError(url, `resolves to private IPv4: ${address}`);
      }
      if (family === 6 && isV6HostBlocked(address)) {
        throw new SsrfBlockedError(url, `resolves to private IPv6: ${address}`);
      }
    }
  } catch (e) {
    if (e instanceof SsrfBlockedError) throw e;
    // DNS 查询失败——不阻断，让后续 fetch 自己报错
  }
}

/** 仅测试用：暴露 IPv4 判断 */
export function __isV4BlockedForTest(ip: string): boolean {
  return isV4Blocked(ip);
}
