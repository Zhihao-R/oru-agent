/**
 * /loop 忙时排队（loop 去特殊化 T2）——模式指令分型的回归：
 * 入队不触发编排、不被插话消费（pullSteering 跳过）、不计 pendingUserCount（不引发 claude-code
 * interrupt 死循环）；concludeTurn 在 /loop 项处切批保序；Esc 按用户项交还（退回输入框）；
 * 崩溃盘记镜像带 modeCommand 标记（恢复不变形）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createSteeringQueue,
  steeringKey,
  type SteeringMsg,
  type SteeringBackup,
} from '../../electron/main/agent/steeringQueue';
import { runSteeringTurnLoop } from '../../electron/main/agent/steeringTurnLoop';
import { handbackForm } from '@shared/agent/handback';

function counterQueue(backup?: SteeringBackup) {
  let n = 0;
  return createSteeringQueue(() => `sid-${(n += 1)}`, backup);
}

const LOOP_MSG = { clientMsgId: 'loop-1', text: '/loop 把报告打磨到能交付', trigger: 'user' as const, modeCommand: 'loop' as const };

describe('/loop 忙时入队 · 消费面隔离', () => {
  it('忙时入队成功，但不被 pullSteering 消费、不计 pendingUserCount', async () => {
    const q = counterQueue();
    const key = steeringKey('ag', 'conv');
    const token = (await q.beginDirectTurn(key))!;

    const r = await q.enqueueOrStart(key, LOOP_MSG);
    expect(r.action).toBe('enqueued');

    // 不计入待读入——否则 claude-code 在工具边界为它反复 interrupt 却拉不走（死循环）
    expect(q.pendingUserCount(key)).toBe(0);

    // 不作插话——pullSteering 跳过它、留在队列
    const pulled = await q.pullSteering(key, token, async () => {});
    expect(pulled).toEqual([]);
    expect(q.pendingCount(key)).toBe(1);

    // 普通用户消息不受影响：照常插话消费
    await q.enqueueOrStart(key, { clientMsgId: 'm1', text: '顺便改下标题', trigger: 'user' });
    expect(q.pendingUserCount(key)).toBe(1);
    const pulled2 = await q.pullSteering(key, token, async () => {});
    expect(pulled2.map((m) => m.text)).toEqual(['顺便改下标题']);
    expect(q.pendingCount(key)).toBe(1); // /loop 仍留队
  });

  it('混批 [普通, /loop, 普通]：切批保序——前段续跑、/loop 转投、后段留队交还', async () => {
    const q = counterQueue();
    const key = steeringKey('ag', 'conv2');
    const token = (await q.beginDirectTurn(key))!;
    await q.enqueueOrStart(key, { clientMsgId: 'a', text: '先回我上一个问题', trigger: 'user' });
    await q.enqueueOrStart(key, LOOP_MSG);
    await q.enqueueOrStart(key, { clientMsgId: 'b', text: '循环里注意格式', trigger: 'user' });

    // 第一次收尾：只续跑 /loop 之前的普通段，/loop 及其后留队
    const persisted: string[][] = [];
    const persist = async (ms: SteeringMsg[]) => {
      persisted.push(ms.map((m) => m.text));
    };
    const r1 = await q.concludeTurn(key, token, persist);
    expect('restart' in r1 && r1.restart.map((m) => m.text)).toEqual(['先回我上一个问题']);
    expect(q.pendingCount(key)).toBe(2);

    // 第二次收尾：队首是 /loop → startLoop（已落盘出队），闸保持 running 同 token
    const r2 = await q.concludeTurn(key, token, persist);
    expect('startLoop' in r2 && r2.startLoop.text).toBe('/loop 把报告打磨到能交付');
    expect(persisted).toEqual([['先回我上一个问题'], ['/loop 把报告打磨到能交付']]);
    expect(q.isRunning(key)).toBe(true);
    expect(q.runToken(key)).toBe(token);

    // /loop 之后的普通消息仍在队——编排期间可被插话消费，编排结束 handBackIfRunning 交还
    const handed = await q.handBackIfRunning(key, token);
    expect(handed?.map((m) => m.text)).toEqual(['循环里注意格式']);
    expect(q.isRunning(key)).toBe(false);
  });

  it('Esc 交还：/loop 项按用户项分流（退回输入框草稿，不落 pending-item）', async () => {
    const q = counterQueue();
    const key = steeringKey('ag', 'conv3');
    await q.beginDirectTurn(key);
    await q.enqueueOrStart(key, LOOP_MSG);

    const drained = await q.drainUnconsumedOnAbort(key);
    expect(drained.map((m) => m.text)).toEqual(['/loop 把报告打磨到能交付']);
    // handbackForm 只看 trigger/origin 两轴：模式指令仍是用户亲手打的字 → draft
    expect(handbackForm(drained[0])).toBe('draft');
  });

  it('崩溃盘记镜像带 modeCommand（恢复不变形）', async () => {
    const saved: SteeringMsg[][] = [];
    const backup: SteeringBackup = {
      save: async (_key, pending) => {
        saved.push(pending.map((m) => ({ ...m })));
      },
    };
    const q = counterQueue(backup);
    const key = steeringKey('ag', 'conv4');
    await q.beginDirectTurn(key);
    await q.enqueueOrStart(key, LOOP_MSG);
    expect(saved.at(-1)?.[0]).toMatchObject({ text: '/loop 把报告打磨到能交付', modeCommand: 'loop' });
  });
});

describe('steeringTurnLoop · startLoop 转投', () => {
  it('回合结束队首是 /loop → 调 startLoop 回调后收工（闸所有权移交，循环不再续跑）', async () => {
    const q = counterQueue();
    const key = steeringKey('ag', 'conv5');
    const token = (await q.beginDirectTurn(key))!;
    await q.enqueueOrStart(key, LOOP_MSG);

    const startLoop = vi.fn(async (item: SteeringMsg) => {
      // 编排负责最终释闸（同 token）
      await q.handBackIfRunning(key, token);
      expect(item.modeCommand).toBe('loop');
    });
    const runTurn = vi.fn(async () => 'ok' as const);

    const outcome = await runSteeringTurnLoop({
      key,
      token,
      firstText: '普通首轮',
      queue: q,
      runTurn,
      persistConsumed: async () => {},
      onHandback: () => {},
      startLoop,
    });

    expect(outcome).toBe('ok');
    expect(runTurn).toHaveBeenCalledTimes(1); // /loop 不作为普通轮续跑
    expect(startLoop).toHaveBeenCalledTimes(1);
    expect(q.isRunning(key)).toBe(false); // 编排收尾已释闸
  });
});
