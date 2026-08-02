/**
 * 网络层重试 + 错误分类工具。
 *
 * fetch 层工具（withRetry / readWithIdleTimeout）仅 OpenAI-compatible backend 用（自己手写
 * fetch）；retryStreamStart（首事件前可重试，S25 G09）跨后端共用——anthropic 直连的首事件前
 * 重试与 claudeCode 的 spawn 阶段条款闸重试都走它。详见
 * docs/tech/2026-05-07-chat-streaming-control-tech-design.md §6。
 */

import { ErrorCodes, type ErrorCode } from '@shared/types';

// ─── 配置 ──────────────────────────────────────────────────────────────

export type RetryConfig = {
  /** 最多重试次数（首次请求 + maxRetries 次重试 = 总请求数）。默认 5。 */
  maxRetries: number;
  /** 单次请求"发起 → 拿到 Response header"的硬上限。默认 600s。
   *  注意：这条**不**覆盖流式期间——一旦 resp.ok 就 clearTimeout。
   *  流式期间靠下面的 idleTimeoutMs。 */
  timeoutMs: number;
  /** 流式期间"两次 chunk 之间"的 idle 上限。默认 60s。
   *  治"半死连接"bug 的关键——上游 200 OK 后再也不发 chunk 时主动断流。 */
  idleTimeoutMs: number;
  /** 第 n 次重试前的退避秒数（n 从 1 开始）。下标 = attempt - 1。
   *  默认 [5, 15, 60, 120, 300]，最后一次单独 5 分钟。
   *  总和 500s ≈ 8 分 20 秒；加 jitter 后总等待范围 ~6 分 15 秒 ~ 8 分 20 秒。 */
  backoffScheduleSeconds: number[];
};

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 5,
  timeoutMs: 600_000,
  idleTimeoutMs: 60_000,
  backoffScheduleSeconds: [5, 15, 60, 120, 300],
};

// ─── 错误类型 ──────────────────────────────────────────────────────────

/** HTTP 非 2xx 错误（含 status code 和服务商错误正文片段） */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyMessage: string | undefined,
    public readonly rawBody: string,
  ) {
    super(`HTTP ${status}: ${bodyMessage ?? rawBody.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

/** 流式期间 idle 超过 idleTimeoutMs（半死连接被主动断流） */
export class IdleTimeoutError extends Error {
  constructor(public readonly idleMs: number) {
    super(`SSE 流空闲超过 ${idleMs}ms（上游可能挂死）`);
    this.name = 'IdleTimeoutError';
  }
}

// ─── 重试判断 ──────────────────────────────────────────────────────────

/** 决定是否对这个 Response 重试。规则跟 Anthropic SDK 一字不差。 */
export function shouldRetry(resp: Response): boolean {
  const hint = resp.headers.get('x-should-retry');
  if (hint === 'true') return true;
  if (hint === 'false') return false;
  const s = resp.status;
  return s === 408 || s === 409 || s === 429 || s >= 500;
}

/** 解析 Retry-After 头，返回毫秒。无头或解析失败返回 null。 */
export function parseRetryAfter(resp: Response): number | null {
  const ms = resp.headers.get('retry-after-ms');
  if (ms !== null) {
    const n = parseInt(ms, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const after = resp.headers.get('retry-after');
  if (!after) return null;
  const n = Number(after);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  // HTTP-date
  const t = Date.parse(after);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return null;
}

/**
 * 显式 schedule + 抖动。
 * attempt 从 1 开始；超出 schedule 长度则用最后一个值兜底（不应该发生，因为 maxRetries 控制范围）。
 */
export function calculateBackoffMs(attempt: number, cfg: RetryConfig = DEFAULT_RETRY): number {
  const schedule = cfg.backoffScheduleSeconds;
  const idx = Math.min(Math.max(attempt - 1, 0), schedule.length - 1);
  const baseSeconds = schedule[idx];
  const jitter = 1 - Math.random() * 0.25; // 0.75 ~ 1.0
  return baseSeconds * jitter * 1000;
}

// ─── signal / sleep 辅助 ───────────────────────────────────────────────

/** 把多个 AbortSignal 合成一个：任意一个 abort 都触发新 controller 的 abort。
 *  注意：合成后的 signal 没有自动 cleanup——caller 用完应让原 signal 自然 GC。 */
export function composeSignals(...signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      return ctrl.signal;
    }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

/** 可被 AbortSignal 提前唤醒的 sleep。abort 时 reject AbortError。 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(handle);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const handle = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── withRetry ─────────────────────────────────────────────────────────

export type WithRetryEvent =
  | { kind: 'retrying'; attempt: number; maxRetries: number }
  | { kind: 'response'; resp: Response };

/**
 * 包装"返回 Response 的请求函数"，加重试 + 单次 header 超时。
 *
 * 设计为 **async generator**：每次重试前 yield 一个 retrying 事件，让 caller
 * 直接转发——避免回调中转标志位丢事件。最终 yield 一个 response 事件把 Response
 * 交回。
 *
 * 关键约束：只重试**还没开始读 body** 的请求——一旦 caller 拿到 resp 开始
 * reader.read()，本工具不接管后续。流式期间的 idle 超时由 readWithIdleTimeout
 * 单独负责。
 */
export async function* withRetry(
  doRequest: (signal: AbortSignal) => Promise<Response>,
  cfg: RetryConfig,
  externalSignal: AbortSignal,
): AsyncGenerator<WithRetryEvent> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (externalSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (attempt > 0) yield { kind: 'retrying', attempt, maxRetries: cfg.maxRetries };

    const timeoutCtrl = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutCtrl.abort(), cfg.timeoutMs);
    const composed = composeSignals(externalSignal, timeoutCtrl.signal);

    try {
      const resp = await doRequest(composed);
      if (resp.ok) {
        yield { kind: 'response', resp };
        return;
      }
      if (attempt < cfg.maxRetries && shouldRetry(resp)) {
        const wait = parseRetryAfter(resp) ?? calculateBackoffMs(attempt + 1, cfg);
        await sleep(wait, externalSignal);
        continue;
      }
      yield { kind: 'response', resp }; // 不可重试 / 重试用完 → 4xx/5xx 交上层抛错
      return;
    } catch (e) {
      lastErr = e;
      if (externalSignal.aborted) throw e; // 用户 Stop：立即抛
      if (attempt < cfg.maxRetries) {
        await sleep(calculateBackoffMs(attempt + 1, cfg), externalSignal);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
  throw lastErr ?? new Error('retry exhausted');
}

// ─── retryStreamStart ──────────────────────────────────────────────────

export type StreamStartEvent<T> =
  | { kind: 'retrying'; attempt: number; maxRetries: number }
  | { kind: 'event'; event: T };

/**
 * 「首事件前可重试」包装器（S25 G09 · 跨后端统一）——把「开一条事件流并逐个产出」的工厂包一层重试。
 *
 * 铁律（error-retry.html M2/M3）：**只在尚未产出任何事件时重试**——一旦流已吐出内容（说到一半），
 * 原样重发会造成重复，交给续写（M3 · runner 层），本工具不接管。这与 withRetry「拿到 resp 开始读
 * body 就不再重试」是同一条边界，只是作用在 SDK 抽象掉 Response 的直连后端（Anthropic）上。
 *
 * 设计为 async generator：每次重试前 yield 一个 retrying 事件让 caller 直接转发成 ConversationEvent，
 * 与 openaiCompatible 的 withRetry 产出同一形状的 retrying——两后端「正在重试」提示由此统一可见。
 * 正常事件包一层 { kind:'event' } 透出，caller 据此驱动各自的累加器。
 *
 * @param openStream 每次尝试新开一条流（失败重试时会再次调用，须每次是全新连接）。
 * @param isRetryable 判定 SDK 抛出的异常是否可重试（网络层 / 429 / 5xx），provider 专属逻辑由 caller 注入。
 */
export async function* retryStreamStart<T>(
  openStream: (signal: AbortSignal) => AsyncIterable<T>,
  isRetryable: (e: unknown) => boolean,
  cfg: RetryConfig,
  externalSignal: AbortSignal,
): AsyncGenerator<StreamStartEvent<T>> {
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (externalSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (attempt > 0) yield { kind: 'retrying', attempt, maxRetries: cfg.maxRetries };

    let produced = false; // 本次尝试是否已吐出任一事件——一旦为真就绝不重试（交续写）
    try {
      for await (const event of openStream(externalSignal)) {
        produced = true;
        yield { kind: 'event', event };
      }
      return;
    } catch (e) {
      if (externalSignal.aborted) throw e; // 用户 Stop：立即抛
      if (!produced && attempt < cfg.maxRetries && isRetryable(e)) {
        await sleep(calculateBackoffMs(attempt + 1, cfg), externalSignal);
        continue;
      }
      throw e; // 已产出 / 不可重试 / 重试用尽 → 原样抛，交上层（M3 续写或错误条）
    }
  }
}

// ─── readWithIdleTimeout ───────────────────────────────────────────────

/**
 * 包装 SSE reader：每次 read 间空闲超过 idleMs 抛 IdleTimeoutError。
 * 任何 chunk 到达就重置计时器。
 *
 * listener 生命周期：长流式 SSE 循环上百次 read，每轮都注册 abort listener
 * 必须显式清理；否则 externalSignal 会累积大量 listener（V8 默认 10 个就 warn）。
 * 用 finally + removeEventListener + { once: true } 双保险。
 */
export async function* readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  externalSignal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  while (true) {
    if (externalSignal.aborted) throw new DOMException('Aborted', 'AbortError');

    const idleCtrl = new AbortController();
    const idleHandle = setTimeout(() => idleCtrl.abort(), idleMs);

    // 桥接：外部 abort → idleCtrl.abort，由 race Promise 区分 abort 来源
    const onExternalAbort = () => idleCtrl.abort();
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const result = await Promise.race([
        reader.read().then((r) => ({ kind: 'chunk' as const, r })),
        new Promise<never>((_, reject) => {
          idleCtrl.signal.addEventListener(
            'abort',
            () => {
              if (externalSignal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
              } else {
                reject(new IdleTimeoutError(idleMs));
              }
            },
            { once: true },
          );
        }),
      ]);
      if (result.r.done) return;
      yield result.r.value;
    } catch (e) {
      // idle 超时 / 外部 abort：主动取消 reader 释放底层 TCP
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw e;
    } finally {
      clearTimeout(idleHandle);
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ─── 错误分类 ──────────────────────────────────────────────────────────

export type ClassifiedError = { message: string; retryable: boolean; code: ErrorCode };

/** 把 backend 抛出的异常分类成"给用户看的 message + 是否可手动重试"。 */
export function classifyError(e: unknown): ClassifiedError {
  // 1. AbortError（用户 Stop）→ 不进 errored 路径，让上层走 abort 分支
  if (isAbortError(e)) {
    throw e;
  }

  // 2. IdleTimeoutError → retryable=true（让用户看到 [重试]，但不算自动重试）
  if (e instanceof IdleTimeoutError) {
    return {
      code: ErrorCodes.UPSTREAM_IDLE_TIMEOUT,
      retryable: true,
      message: `上游长时间无响应（${Math.round(e.idleMs / 1000)} 秒无数据），已保留已写内容`,
    };
  }

  // 3. HTTP 错误
  if (e instanceof HttpError) {
    const s = e.status;
    const retryable = s === 408 || s === 409 || s === 429 || s >= 500;
    return {
      code: ErrorCodes.UPSTREAM_FAILED,
      retryable,
      message: formatHttpError(e),
    };
  }

  // 4. 网络层错误
  if (isNetworkError(e)) {
    return {
      code: ErrorCodes.UPSTREAM_FAILED,
      retryable: true,
      message: '网络连接失败',
    };
  }

  // 5. 其他未知错误 → 默认不可重试，让用户看到原文
  return {
    code: ErrorCodes.UNKNOWN,
    retryable: false,
    message: e instanceof Error ? e.message : String(e),
  };
}

function formatHttpError(e: HttpError): string {
  const detail = e.bodyMessage?.trim();
  const detailSuffix = detail ? `：${detail}` : '';
  switch (e.status) {
    case 401:
    case 403:
      return `API Key 无效或权限不足（${e.status}）${detailSuffix}`;
    case 404:
      return `接口不存在（404）${detailSuffix}`;
    case 400:
      return `请求被拒绝（400）${detailSuffix}`;
    case 429:
      return `上游限流（429）${detailSuffix}`;
    default:
      return e.status >= 500
        ? `上游服务故障（${e.status}）${detailSuffix}`
        : `出错（${e.status}）${detailSuffix}`;
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (isAbortError(e)) return false;
  if (e instanceof HttpError || e instanceof IdleTimeoutError) return false;
  // Node fetch 网络错通常是 TypeError: fetch failed
  // \bterminated\b：undici 在 SSE body 阶段被对端/中间链路切断 socket 时抛
  // Error: terminated（runner 重包后只剩 message，所以这里走正则兜底）
  return e.name === 'TypeError' || /fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|\bterminated\b/i.test(e.message);
}
