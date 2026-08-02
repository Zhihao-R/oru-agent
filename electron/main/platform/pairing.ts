/**
 * PairingManager（tech design §6）——桌面生成一次性限时配对码，平台侧发对了即把发送者绑进
 * 白名单。安全要点：一次性（消费即失效）、限时（过期拒）、同一时刻只有一个活跃码（换发作废旧码）、
 * 无活跃码一律拒。配对码只显示在桌面，陌生人拿不到（PRD「陌生人零回应」的绑定凭证）。
 *
 * 时钟与码生成器都可注入——测试用确定性时钟 / 码；生产用 crypto 随机数。
 */
import { randomInt } from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60_000; // 几分钟（PRD）

function defaultGen(): string {
  // 6 位数字，便于在手机私聊里手输；威胁模型下足够（码只到你桌面、限时、fail-closed 沉默挡爆破）
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

type ActiveCode = { code: string; expiresAt: number };

export class PairingManager {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly gen: () => string;
  private current: ActiveCode | null = null;

  constructor(opts: { now: () => number; ttlMs?: number; gen?: () => string }) {
    this.now = opts.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.gen = opts.gen ?? defaultGen;
  }

  /** 生成新码（作废旧码），返回码与到期时间供桌面显示。 */
  issue(): ActiveCode {
    this.current = { code: this.gen(), expiresAt: this.now() + this.ttlMs };
    return this.current;
  }

  /** 校验并消费：匹配且未过期 → 失效该码并返回 true；否则 false。 */
  tryConsume(code: string): boolean {
    const active = this.active;
    if (!active) return false;
    if (!timingSafeEqualStr(code, active.code)) return false;
    this.current = null; // 一次性
    return true;
  }

  /** 当前可展示的活跃码；无 / 已过期则为 null（不展示死码）。 */
  get active(): ActiveCode | null {
    if (this.current && this.now() >= this.current.expiresAt) this.current = null;
    return this.current;
  }
}

/** 定长字符串等时比较——避免按字符提前返回泄露匹配进度。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
