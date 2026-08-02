import { describe, expect, it, vi } from 'vitest';
import {
  HttpError,
  IdleTimeoutError,
  shouldRetry,
  parseRetryAfter,
  calculateBackoffMs,
  withRetry,
  retryStreamStart,
  readWithIdleTimeout,
  classifyError,
  sleep,
  DEFAULT_RETRY,
} from '../../electron/main/agent/util/retry';
import { ErrorCodes } from '../../shared/types';

// ─── shouldRetry ──────────────────────────────────────────────────────

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('shouldRetry', () => {
  it.each([408, 409, 429, 500, 502, 503, 504, 599])('status %i 应重试', (s) => {
    expect(shouldRetry(makeResponse(s))).toBe(true);
  });
  it.each([200, 201, 301, 400, 401, 403, 404, 422])('status %i 不重试', (s) => {
    expect(shouldRetry(makeResponse(s))).toBe(false);
  });
  it('x-should-retry: true 强制重试', () => {
    expect(shouldRetry(makeResponse(401, { 'x-should-retry': 'true' }))).toBe(true);
  });
  it('x-should-retry: false 强制不重试', () => {
    expect(shouldRetry(makeResponse(503, { 'x-should-retry': 'false' }))).toBe(false);
  });
});

// ─── parseRetryAfter ──────────────────────────────────────────────────

describe('parseRetryAfter', () => {
  it('retry-after-ms 数字优先', () => {
    expect(parseRetryAfter(makeResponse(429, { 'retry-after-ms': '1500' }))).toBe(1500);
  });
  it('retry-after 秒数', () => {
    expect(parseRetryAfter(makeResponse(429, { 'retry-after': '3' }))).toBe(3000);
  });
  it('retry-after HTTP-date', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const got = parseRetryAfter(makeResponse(429, { 'retry-after': future }));
    expect(got).toBeGreaterThan(4000);
    expect(got).toBeLessThanOrEqual(5000);
  });
  it('无头返回 null', () => {
    expect(parseRetryAfter(makeResponse(429))).toBeNull();
  });
});

// ─── calculateBackoffMs ───────────────────────────────────────────────

describe('calculateBackoffMs', () => {
  it('schedule 总和 = 500 秒', () => {
    const total = DEFAULT_RETRY.backoffScheduleSeconds.reduce((a, b) => a + b, 0);
    expect(total).toBe(500);
  });

  it.each([
    [1, 5],
    [2, 15],
    [3, 60],
    [4, 120],
    [5, 300],
  ])('attempt=%i 抖动落在 [base*0.75, base] 区间（base=%i）', (attempt, base) => {
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoffMs(attempt);
      expect(ms).toBeGreaterThanOrEqual(base * 750);
      expect(ms).toBeLessThanOrEqual(base * 1000);
    }
  });

  it('attempt 超出 schedule 长度时用最后一个 base 兜底', () => {
    const ms = calculateBackoffMs(99);
    expect(ms).toBeGreaterThanOrEqual(300 * 750);
    expect(ms).toBeLessThanOrEqual(300 * 1000);
  });
});

// ─── classifyError ────────────────────────────────────────────────────

describe('classifyError', () => {
  it('HttpError 401 → 不可重试，文案含"API Key"', () => {
    const r = classifyError(new HttpError(401, 'invalid key', '{"error":"unauthorized"}'));
    expect(r.retryable).toBe(false);
    expect(r.message).toContain('API Key');
    expect(r.code).toBe(ErrorCodes.UPSTREAM_FAILED);
  });
  it('HttpError 403 → 不可重试', () => {
    expect(classifyError(new HttpError(403, undefined, '')).retryable).toBe(false);
  });
  it('HttpError 400 → 不可重试，含原文', () => {
    const r = classifyError(new HttpError(400, 'model glm-4 not in region', ''));
    expect(r.retryable).toBe(false);
    expect(r.message).toContain('model glm-4 not in region');
  });
  it('HttpError 429 → 可重试', () => {
    expect(classifyError(new HttpError(429, undefined, '')).retryable).toBe(true);
  });
  it('HttpError 503 → 可重试', () => {
    expect(classifyError(new HttpError(503, undefined, '')).retryable).toBe(true);
  });
  it('IdleTimeoutError → 可重试，code=UPSTREAM_IDLE_TIMEOUT', () => {
    const r = classifyError(new IdleTimeoutError(60_000));
    expect(r.retryable).toBe(true);
    expect(r.code).toBe(ErrorCodes.UPSTREAM_IDLE_TIMEOUT);
    expect(r.message).toContain('60');
  });
  it('网络层 TypeError → 可重试', () => {
    const e = new TypeError('fetch failed');
    expect(classifyError(e).retryable).toBe(true);
  });
  it('AbortError 不分类，重新抛', () => {
    expect(() => classifyError(new DOMException('Aborted', 'AbortError'))).toThrow('Aborted');
  });
  it('未知错误 → 不可重试，原文展示', () => {
    const r = classifyError(new Error('something weird'));
    expect(r.retryable).toBe(false);
    expect(r.message).toBe('something weird');
  });
});

// ─── withRetry generator ──────────────────────────────────────────────

async function collectGen<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('withRetry generator', () => {
  it('首次 200 → 仅 yield 一个 response，无 retrying', async () => {
    const ctrl = new AbortController();
    const events = await collectGen(
      withRetry(async () => makeResponse(200), DEFAULT_RETRY, ctrl.signal),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('response');
  });

  it('连续 503 至上限 → yield 5 个 retrying（attempt 1..5 严格递增）+ 1 个 response', async () => {
    const ctrl = new AbortController();
    const cfg = {
      ...DEFAULT_RETRY,
      // 所有间隔改成 0，避免测试漫长
      backoffScheduleSeconds: [0, 0, 0, 0, 0],
    };
    const events = await collectGen(
      withRetry(async () => makeResponse(503), cfg, ctrl.signal),
    );
    const retryings = events.filter((e) => e.kind === 'retrying');
    const resps = events.filter((e) => e.kind === 'response');
    expect(retryings).toHaveLength(5);
    expect(retryings.map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(resps).toHaveLength(1);
    expect((resps[0] as { resp: Response }).resp.status).toBe(503);
  });

  it('Retry-After: 0 也不丢 retrying 事件（generator vs 标志位回归）', async () => {
    const ctrl = new AbortController();
    const cfg = { ...DEFAULT_RETRY, maxRetries: 2 };
    const events = await collectGen(
      withRetry(
        async () => makeResponse(429, { 'retry-after-ms': '0' }),
        cfg,
        ctrl.signal,
      ),
    );
    const retryings = events.filter((e) => e.kind === 'retrying');
    expect(retryings.map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2]);
  });

  it('外部 abort → 立即抛 AbortError，不继续 yield', async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // 一开始就 abort
    await expect(
      collectGen(withRetry(async () => makeResponse(503), DEFAULT_RETRY, ctrl.signal)),
    ).rejects.toThrow(/abort/i);
  });

  it('200 OK 直接退出循环，不进退避', async () => {
    const ctrl = new AbortController();
    const calls: number[] = [];
    let n = 0;
    const events = await collectGen(
      withRetry(
        async () => {
          calls.push(++n);
          return makeResponse(200);
        },
        DEFAULT_RETRY,
        ctrl.signal,
      ),
    );
    expect(calls).toEqual([1]);
    expect(events.length).toBe(1);
  });
});

// ─── readWithIdleTimeout ──────────────────────────────────────────────

function makeReader(chunks: (Uint8Array | 'pending')[]): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  return {
    async read() {
      if (i >= chunks.length) return { done: true, value: undefined };
      const c = chunks[i++];
      if (c === 'pending') {
        // 永远 pending，模拟"半死连接"
        return new Promise(() => {});
      }
      return { done: false, value: c };
    },
    async cancel() {},
    closed: Promise.resolve(undefined),
    releaseLock() {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe('readWithIdleTimeout', () => {
  it('idleMs 后抛 IdleTimeoutError + reader.cancel 被调用', async () => {
    const ctrl = new AbortController();
    let cancelled = false;
    const reader = {
      async read() {
        return new Promise(() => {}); // 永远 pending
      },
      async cancel() {
        cancelled = true;
      },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    const start = Date.now();
    await expect(
      collectGen(readWithIdleTimeout(reader, 80, ctrl.signal)),
    ).rejects.toBeInstanceOf(IdleTimeoutError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
    expect(cancelled).toBe(true);
  });

  it('持续 chunk → 不会误触发 IdleTimeoutError', async () => {
    const ctrl = new AbortController();
    const reader = makeReader([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5, 6]),
    ]);
    const chunks = await collectGen(readWithIdleTimeout(reader, 50, ctrl.signal));
    expect(chunks).toHaveLength(3);
  });

  it('外部 abort 优先于 idle：抛 AbortError 而非 IdleTimeoutError', async () => {
    const ctrl = new AbortController();
    const reader = makeReader(['pending']);
    const promise = collectGen(readWithIdleTimeout(reader, 200, ctrl.signal));
    setTimeout(() => ctrl.abort(), 30);
    await expect(promise).rejects.toThrow(/abort/i);
  });
});

// ─── retryStreamStart generator（S25 G09 · 直连后端统一重试可见）──────────

describe('retryStreamStart generator', () => {
  const cfg0 = { ...DEFAULT_RETRY, backoffScheduleSeconds: [0, 0, 0, 0, 0] };
  const always = () => true;

  /** 造一个「前 failTimes 次开流即抛，之后正常吐 events」的工厂。 */
  function flakyStream(failTimes: number, events: string[], err: () => unknown) {
    let calls = 0;
    return async function* (_signal: AbortSignal): AsyncGenerator<string> {
      const attempt = calls++;
      if (attempt < failTimes) throw err();
      for (const e of events) yield e;
    };
  }

  it('首次即成功 → 只透事件，无 retrying', async () => {
    const ctrl = new AbortController();
    const out = await collectGen(
      retryStreamStart(flakyStream(0, ['a', 'b'], () => new Error('x')), always, cfg0, ctrl.signal),
    );
    expect(out.map((e) => e.kind)).toEqual(['event', 'event']);
    expect(out.map((e) => (e.kind === 'event' ? e.event : null))).toEqual(['a', 'b']);
  });

  it('开流前连抛 2 次可重试错 → 2 个 retrying（attempt 1,2 递增）后成功', async () => {
    const ctrl = new AbortController();
    const out = await collectGen(
      retryStreamStart(flakyStream(2, ['ok'], () => new Error('net')), always, cfg0, ctrl.signal),
    );
    const retryings = out.filter((e) => e.kind === 'retrying');
    expect(retryings.map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(out.filter((e) => e.kind === 'event').map((e) => (e as { event: string }).event)).toEqual(['ok']);
  });

  it('已吐出事件后再抛 → 不重试，原样抛（M3 续写的地盘，不重发造重复）', async () => {
    const ctrl = new AbortController();
    // 第一个 event 后抛错：produced=true，不该重试
    async function* midDrop(): AsyncGenerator<string> {
      yield 'half';
      throw new Error('terminated mid-stream');
    }
    const gen = retryStreamStart(() => midDrop(), always, cfg0, ctrl.signal);
    const got: string[] = [];
    await expect(
      (async () => {
        for await (const e of gen) if (e.kind === 'event') got.push(e.event);
      })(),
    ).rejects.toThrow(/terminated/);
    expect(got).toEqual(['half']); // 半截已透出、未被重发
  });

  it('不可重试的错（isRetryable=false）→ 立即抛，零 retrying', async () => {
    const ctrl = new AbortController();
    const gen = retryStreamStart(
      flakyStream(1, ['never'], () => new Error('401')),
      () => false,
      cfg0,
      ctrl.signal,
    );
    await expect(collectGen(gen)).rejects.toThrow('401');
  });

  it('重试用尽仍失败 → 抛最后一次错', async () => {
    const ctrl = new AbortController();
    const cfg = { ...cfg0, maxRetries: 2 };
    const gen = retryStreamStart(flakyStream(99, [], () => new Error('down')), always, cfg, ctrl.signal);
    await expect(collectGen(gen)).rejects.toThrow('down');
  });

  it('已 abort → 立即抛 AbortError，不开流', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let opened = false;
    const gen = retryStreamStart(
      async function* () {
        opened = true;
        yield 'x';
      },
      always,
      cfg0,
      ctrl.signal,
    );
    await expect(collectGen(gen)).rejects.toThrow(/abort/i);
    expect(opened).toBe(false);
  });
});

// ─── sleep ─────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('正常返回', async () => {
    const ctrl = new AbortController();
    const start = Date.now();
    await sleep(40, ctrl.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
  });
  it('被 abort 立即 reject', async () => {
    const ctrl = new AbortController();
    const promise = sleep(1000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    const start = Date.now();
    await expect(promise).rejects.toThrow(/abort/i);
    expect(Date.now() - start).toBeLessThan(100);
  });
});
