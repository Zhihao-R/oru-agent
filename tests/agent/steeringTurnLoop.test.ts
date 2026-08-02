/**
 * Steering 回合循环（回合末读 + outcome 消费）回归。
 *
 * S08（G13/G14）：runTurn 返回 TurnOutcome，循环按 outcome 分流——
 *  - ok → concludeTurn 续跑 / idle；
 *  - error → 不 concludeTurn、按 token 交还、停转（队列空也停）；
 *  - aborted → Esc 已抢先交还则幂等直接返回、远程刹车未交还则交还；
 * 并把跨轮累积的最终 outcome（error 粘滞 > aborted > ok）作为返回值上交。
 */
import { describe, expect, it, vi } from 'vitest';
import { createSteeringQueue, steeringKey, type SteeringMsg } from '../../electron/main/agent/steeringQueue';
import { runSteeringTurnLoop } from '../../electron/main/agent/steeringTurnLoop';

function seqGen() {
  let n = 0;
  return () => `s${(n += 1)}`;
}
const user = (clientMsgId: string, text: string) => ({ clientMsgId, text, trigger: 'user' as const });
const noop = () => {};

/** 起回合并取归属 token（§6）：模拟入口在占闸那一刻拿到凭据、线程化传给循环。 */
async function startTurn(
  q: ReturnType<typeof createSteeringQueue>,
  key: string,
  msg: Parameters<ReturnType<typeof createSteeringQueue>['enqueueOrStart']>[1],
): Promise<number> {
  const d = await q.enqueueOrStart(key, msg);
  if (d.action !== 'started') throw new Error('expected started');
  return d.token;
}

describe('runSteeringTurnLoop · 回合末读', () => {
  it('无积压：只跑一轮就停，返回 ok', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '首条'));
    const runTurn = vi.fn(async () => 'ok' as const);
    const persistConsumed = vi.fn(async () => {});
    const acc = await runSteeringTurnLoop({ key, token, firstText: '首条', queue: q, runTurn, persistConsumed, onHandback: noop });
    expect(acc).toBe('ok');
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith('首条', undefined); // 首轮无 restart 批
    expect(persistConsumed).not.toHaveBeenCalled();
    expect(q.isRunning(key)).toBe(false);
  });

  it('首轮跑时积压两条：跑完续跑一轮、那两条在边界一起被消费', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '首条'));
    const consumedBatches: string[][] = [];
    let firstTurn = true;
    const runTurn = vi.fn(async () => {
      if (firstTurn) {
        firstTurn = false;
        await q.enqueueOrStart(key, user('b', '补1'));
        await q.enqueueOrStart(key, user('c', '补2'));
      }
      return 'ok' as const;
    });
    const persistConsumed = vi.fn(async (msgs: SteeringMsg[]) => {
      consumedBatches.push(msgs.map((m) => m.text));
    });
    await runSteeringTurnLoop({ key, token, firstText: '首条', queue: q, runTurn, persistConsumed, onHandback: noop });
    expect(runTurn.mock.calls.map((c) => c[0])).toEqual(['首条', undefined]);
    // 续跑轮拿到 restart 批（G70 装配标注取材）：首轮 restartBatch=undefined，续跑轮=那两条
    expect(runTurn.mock.calls[0][1]).toBeUndefined();
    expect(runTurn.mock.calls[1][1]?.map((m) => m.text)).toEqual(['补1', '补2']);
    expect(consumedBatches).toEqual([['补1', '补2']]);
    expect(q.isRunning(key)).toBe(false);
  });

  it('persistConsumed 失败（落盘故障）：不冻结对话——交还未消费队列、清队、idle、返回 error', async () => {
    // 回归：修复前 catch 里 return 'ok' 留 running=true、队列没人消费，对话卡到重启（review 抓出）。
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '首条'));
    let firstTurn = true;
    const runTurn = vi.fn(async () => {
      if (firstTurn) {
        firstTurn = false;
        await q.enqueueOrStart(key, user('b', '补1'));
      }
      return 'ok' as const;
    });
    const persistConsumed = vi.fn(async () => {
      throw new Error('落盘失败');
    });
    const handed: string[][] = [];
    const acc = await runSteeringTurnLoop({
      key,
      token,
      firstText: '首条',
      queue: q,
      runTurn,
      persistConsumed,
      onHandback: (items) => handed.push(items.map((m) => m.text)),
    });
    expect(acc).toBe('error');
    expect(runTurn).toHaveBeenCalledTimes(1); // 不续跑
    expect(handed).toEqual([['补1']]); // 未消费队列交还用户
    expect(q.pendingCount(key)).toBe(0); // 队列清
    expect(q.isRunning(key)).toBe(false); // 释放闸，不冻结
  });
});

describe('runSteeringTurnLoop · 故障后不自动续跑 + 交还（G13）', () => {
  it('error → 不 concludeTurn、交还队列、队列清、idle、返回 error', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '首条'));
    await q.enqueueOrStart(key, { clientMsgId: 'm1', text: '定时', trigger: 'scheduled' });
    const handed: string[][] = [];
    const runTurn = vi.fn(async () => 'error' as const);
    const acc = await runSteeringTurnLoop({
      key,
      token,
      firstText: '首条',
      queue: q,
      runTurn,
      persistConsumed: async () => {},
      onHandback: (items) => handed.push(items.map((m) => m.text)),
    });
    expect(acc).toBe('error');
    expect(runTurn).toHaveBeenCalledTimes(1); // 不续跑
    expect(handed).toEqual([['定时']]); // 队列交还
    expect(q.pendingCount(key)).toBe(0); // 队列清
    expect(q.isRunning(key)).toBe(false); // idle
  });

  it('error 且队列空 → 停转、不续跑、不交还（onHandback 不调）', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '首条'));
    const onHandback = vi.fn();
    const acc = await runSteeringTurnLoop({
      key,
      token,
      firstText: '首条',
      queue: q,
      runTurn: async () => 'error' as const,
      persistConsumed: async () => {},
      onHandback,
    });
    expect(acc).toBe('error');
    expect(onHandback).not.toHaveBeenCalled();
    expect(q.isRunning(key)).toBe(false);
  });

  it('跨轮 outcome 累积：ok 轮后 error 轮 → 返回 error（error 粘滞）', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '首条'));
    let firstTurn = true;
    const runTurn = vi.fn(async () => {
      if (firstTurn) {
        firstTurn = false;
        await q.enqueueOrStart(key, user('b', '补1')); // 制造续跑
        return 'ok' as const;
      }
      return 'error' as const; // 续跑轮失败
    });
    const acc = await runSteeringTurnLoop({
      key,
      token,
      firstText: '首条',
      queue: q,
      runTurn,
      persistConsumed: async () => {},
      onHandback: noop,
    });
    expect(acc).toBe('error');
    expect(runTurn).toHaveBeenCalledTimes(2);
  });
});

describe('runSteeringTurnLoop · 中止交还按路径分流（G14）', () => {
  it('aborted 且已被 Esc 交还 → 幂等直接返回、不重复交还', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '首条'));
    const onHandback = vi.fn();
    const runTurn = vi.fn(async () => {
      // 模拟 Esc：桌面按停先 drain（running=false）再让本轮 runChat 抛 aborted
      await q.drainUnconsumedOnAbort(key);
      return 'aborted' as const;
    });
    const acc = await runSteeringTurnLoop({ key, token, firstText: '首条', queue: q, runTurn, persistConsumed: async () => {}, onHandback });
    expect(acc).toBe('aborted');
    expect(onHandback).not.toHaveBeenCalled(); // Esc 已交还草稿，循环不重复交还
    expect(q.isRunning(key)).toBe(false);
  });

  it('aborted 未交还（远程刹车）→ 交还队列', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '首条'));
    await q.enqueueOrStart(key, { clientMsgId: 'm1', text: '定时', trigger: 'scheduled' });
    const handed: string[][] = [];
    // 远程 /stop 不经 drain：running 仍 true、队列仍在
    const runTurn = vi.fn(async () => 'aborted' as const);
    await runSteeringTurnLoop({
      key,
      token,
      firstText: '首条',
      queue: q,
      runTurn,
      persistConsumed: async () => {},
      onHandback: (items) => handed.push(items.map((m) => m.text)),
    });
    expect(handed).toEqual([['定时']]);
    expect(q.isRunning(key)).toBe(false);
  });

  it('【并发回归】abort 后新回合已起：旧循环的 aborted 交还不误清新回合 running', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '回合1'));
    const onHandback = vi.fn();
    const runTurn = vi.fn(async () => {
      // 回合1 被 Esc 交还后，用户立刻发新消息起回合2
      await q.drainUnconsumedOnAbort(key); // running=false
      await q.enqueueOrStart(key, user('b', '回合2')); // running=true，token 自增
      return 'aborted' as const;
    });
    await runSteeringTurnLoop({ key, token, firstText: '回合1', queue: q, runTurn, persistConsumed: async () => {}, onHandback });
    expect(onHandback).not.toHaveBeenCalled(); // 旧 token 失配，不碰回合2 的队列
    expect(q.isRunning(key)).toBe(true); // 回合2 存活
  });
});

describe('runSteeringTurnLoop · 占闸 token 线程化（§6 归属重检）', () => {
  it('旧入口迟到起跑（Esc 后新回合已起）：旧循环不得清新回合的闸/抢走其队列', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    // 旧入口占闸……
    const d1 = await q.enqueueOrStart(key, user('a', '旧'));
    const staleToken = (d1 as { action: 'started'; token: number }).token;
    // ……它的 await 间隙里：用户 Esc 清闸，新回合随即占闸起跑
    await q.drainUnconsumedOnAbort(key);
    await q.enqueueOrStart(key, user('b', '新'));
    // 旧入口此刻才起循环——起点归属校验直接拦下，一轮都不跑
    const onHandback = vi.fn();
    const runTurn = vi.fn(async () => 'error' as const);
    const acc = await runSteeringTurnLoop({
      key,
      firstText: '旧',
      queue: q,
      token: staleToken,
      runTurn,
      persistConsumed: async () => {},
      onHandback,
    });
    expect(acc).toBe('aborted');
    expect(runTurn).not.toHaveBeenCalled(); // 僵尸入口连一轮都不起
    expect(q.isRunning(key)).toBe(true); // 新回合的闸不被旧循环误清
    expect(onHandback).not.toHaveBeenCalled(); // 新回合的队列不被旧循环抢走交还
  });
});

describe('runSteeringTurnLoop · 僵尸回合防线（token 收口 concludeTurn/循环起点）', () => {
  it('runTurn ok 晚到（Esc 后新回合已起）：僵尸轮不消费新回合队列、不清其闸', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '旧'));
    const persistConsumed = vi.fn(async () => {});
    const runTurn = vi.fn(async () => {
      // 流式已完成、尾部 await 期间：Esc 清闸 → 新回合起 → 新回合时代又排队一条
      await q.drainUnconsumedOnAbort(key);
      await q.enqueueOrStart(key, user('b', '新回合'));
      await q.enqueueOrStart(key, user('c', '新回合的排队消息'));
      return 'ok' as const;
    });
    await runSteeringTurnLoop({ key, token, firstText: '旧', queue: q, runTurn, persistConsumed, onHandback: noop });
    expect(runTurn).toHaveBeenCalledTimes(1); // 不带着偷来的批续跑
    expect(persistConsumed).not.toHaveBeenCalled();
    expect(q.pendingCount(key)).toBe(1); // 新回合的排队消息原样
    expect(q.isRunning(key)).toBe(true); // 新回合的闸存活
  });

  it('循环起点归属校验：起循环前闸已被 Esc 清 → 不跑任何一轮、返回 aborted', async () => {
    const q = createSteeringQueue(seqGen());
    const key = steeringKey('twin', 'c1');
    const token = await startTurn(q, key, user('a', '首条'));
    await q.drainUnconsumedOnAbort(key); // 入口 await 间隙（如 appendMessage）用户 Esc
    const runTurn = vi.fn(async () => 'ok' as const);
    const acc = await runSteeringTurnLoop({ key, token, firstText: '首条', queue: q, runTurn, persistConsumed: async () => {}, onHandback: noop });
    expect(acc).toBe('aborted');
    expect(runTurn).not.toHaveBeenCalled(); // Esc 不被静默击败
  });
});
