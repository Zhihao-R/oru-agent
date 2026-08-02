/**
 * §3.1 跨轮持闸回归（可行性审查 blocker①）——loop v3 的地基不变量：
 * loop 占对话闸后，轮与轮之间**不释闸**；间隙收到的用户消息落 steering 队列（不抢闸起新回合、
 * loop 不被静默跳过），由下一干活轮开工时 pullSteering 消费。释闸时机只有收敛/中止/用户停。
 *
 * 用真实 steeringQueue（无盘记后端）验这条不变量本身——它是编排层「跨轮持闸驱动可见干活轮」的支点。
 */
import { describe, it, expect } from 'vitest';
import { createSteeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';

function counterQueue() {
  let n = 0;
  return createSteeringQueue(() => `sid-${(n += 1)}`);
}

describe('§3.1 跨轮持闸', () => {
  it('持闸期间间隙用户消息入队（非起新回合），下一轮 pullSteering 交给持有者，闸仍不释放', async () => {
    const q = counterQueue();
    const key = steeringKey('ag', 'conv');

    // loop 占闸（beginDirectTurn，一次占、贯穿整个 loop）
    const token = await q.beginDirectTurn(key);
    expect(token).not.toBeNull();

    // 轮间隙：用户发消息 → 入队（不起新回合，闸仍归 loop），闸不因此翻新
    const r = await q.enqueueOrStart(key, { clientMsgId: 'm1', text: '换个方向', trigger: 'user' });
    expect(r.action).toBe('enqueued');
    expect(q.isRunning(key)).toBe(true);
    expect(q.runToken(key)).toBe(token);

    // 下一干活轮开工：持有者用自己的 token 消费插话
    const persisted: string[] = [];
    const pulled = await q.pullSteering(key, token!, async (msgs) => {
      persisted.push(...msgs.map((m) => m.text));
    });
    expect(pulled.map((m) => m.text)).toEqual(['换个方向']);
    expect(persisted).toEqual(['换个方向']);

    // 闸仍持有（只有收敛/中止/停才 handBackIfRunning 释放）
    expect(q.isRunning(key)).toBe(true);
  });

  it('对照：无人持闸时同一条消息起新回合（action=started）——证明「入队非起回合」确由持闸导致', async () => {
    const q = counterQueue();
    const r = await q.enqueueOrStart(steeringKey('ag', 'conv2'), { clientMsgId: 'm1', text: 'hi', trigger: 'user' });
    expect(r.action).toBe('started');
  });

  it('持有者显式 handBackIfRunning 才释闸，并交还未消费队列（收敛/中止/停的释闸口）', async () => {
    const q = counterQueue();
    const key = steeringKey('ag', 'conv3');
    const token = await q.beginDirectTurn(key);
    await q.enqueueOrStart(key, { clientMsgId: 'm2', text: '还没读到的插话', trigger: 'user' });

    const handed = await q.handBackIfRunning(key, token!);
    expect(handed?.map((m) => m.text)).toEqual(['还没读到的插话']);
    expect(q.isRunning(key)).toBe(false);
  });
});
