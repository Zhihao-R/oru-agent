/**
 * 服务端 steering 队列（地基）—— 承重不变量与并发/attacker/regression 回归。
 *
 * 承重不变量（对抗审查定）：
 *  1. enqueueOrStart 在 per-conv 锁内原子裁决「起回合 vs 入队」——杜绝并发回合（TOCTOU 根除）。
 *  2. 消费 = pullSteering 锁内「落盘先于投递」：persist 成功才清队列；persist 失败整批留队列重试。
 *  3. 消费前可撤、消费后不可：withdraw 与 pull 同锁串行，先到先裁。
 *  4. Esc 退回未消费、保留已消费：drainUnconsumedOnAbort 只取仍在队列的。
 *  5. 多 conv 隔离：队列/running 按 conv 分桶。
 *
 * S08 扩展（G11/G12/G13/G14）：
 *  - 触发类型 trigger 是队列项一等字段；pullSteering 只取 user 项、机器项留队（G12）。
 *  - beginDirectTurn 闸外回合占闸（G11）；handBackIfRunning 故障/远程刹车按 token 归属交还（G13/G14）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createSteeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';

// 确定性 serverId 生成器
function seqGen() {
  let n = 0;
  return () => `s${(n += 1)}`;
}

// 便捷：起回合发一条用户消息
const user = (clientMsgId: string, text: string) => ({ clientMsgId, text, trigger: 'user' as const });

describe('steeringQueue · 起回合 vs 入队（不变量 1）', () => {
  it('空闲首发 → started + 归属 token，无 serverId', async () => {
    const q = createSteeringQueue(seqGen());
    const r = await q.enqueueOrStart('c1', user('a', '首条'));
    expect(r).toEqual({ action: 'started', token: 1 });
    expect(q.isRunning('c1')).toBe(true);
    expect(q.pendingCount('c1')).toBe(0);
  });

  it('忙时再发 → enqueued + serverId；不另起回合', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('a', '首条'));
    const r = await q.enqueueOrStart('c1', user('b', '补一句'));
    expect(r).toEqual({ action: 'enqueued', serverId: 's1' });
    expect(q.pendingCount('c1')).toBe(1);
  });

  it('【并发回归·原 TOCTOU】起回合瞬间再发：恰好一个 started、一个 enqueued', async () => {
    const q = createSteeringQueue(seqGen());
    const [r1, r2] = await Promise.all([
      q.enqueueOrStart('c1', user('a', 'A')),
      q.enqueueOrStart('c1', user('b', 'B')),
    ]);
    const actions = [r1.action, r2.action].sort();
    expect(actions).toEqual(['enqueued', 'started']);
    // 绝不出现两个并发回合：running 只 true 一次，队列里恰好 1 条
    expect(q.isRunning('c1')).toBe(true);
    expect(q.pendingCount('c1')).toBe(1);
  });

  it('快速连发 N 条（attacker）：1 started + (N-1) enqueued，无并发回合', async () => {
    const q = createSteeringQueue(seqGen());
    const sends = Array.from({ length: 20 }, (_, i) => q.enqueueOrStart('c1', user(`m${i}`, `t${i}`)));
    const results = await Promise.all(sends);
    const started = results.filter((r) => r.action === 'started');
    expect(started).toHaveLength(1);
    expect(q.pendingCount('c1')).toBe(19);
  });
});

describe('steeringQueue · beginDirectTurn 闸外回合占闸（G11）', () => {
  it('空闲时占闸 → token 且 running；再占 → null（不双跑）', async () => {
    const q = createSteeringQueue(seqGen());
    expect(await q.beginDirectTurn('c1')).toBe(1);
    expect(q.isRunning('c1')).toBe(true);
    expect(await q.beginDirectTurn('c1')).toBeNull();
  });

  it('占闸后 chat.send 忙时入队、不撞并发回合（G11 核心）', async () => {
    const q = createSteeringQueue(seqGen());
    await q.beginDirectTurn('c1'); // 播报轮/审批续跑占闸
    const r = await q.enqueueOrStart('c1', user('u', '用户消息'));
    expect(r).toEqual({ action: 'enqueued', serverId: 's1' }); // 排队而非报错起第二回合
    expect(q.pendingCount('c1')).toBe(1);
  });

  it('【并发原子】beginDirectTurn 与 enqueueOrStart 抢锁：只有一个占到闸', async () => {
    const q = createSteeringQueue(seqGen());
    const [direct, send] = await Promise.all([
      q.beginDirectTurn('c1'),
      q.enqueueOrStart('c1', user('u', 'U')),
    ]);
    // 二者只有一个真正起回合：direct=true 则 send 入队；direct=false 则 send started
    if (direct) {
      expect(send).toEqual({ action: 'enqueued', serverId: 's1' });
    } else {
      expect(send).toEqual({ action: 'started', token: 1 });
    }
    expect(q.isRunning('c1')).toBe(true);
  });
});

describe('steeringQueue · 分型取出 pullSteering 只取 user（G12）', () => {
  it('pullSteering 只取 user 项、保序；机器项留队', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合')); // started
    await q.enqueueOrStart('c1', user('u1', 'U1'));
    await q.enqueueOrStart('c1', { clientMsgId: 'm1', text: '定时1', trigger: 'scheduled' });
    await q.enqueueOrStart('c1', user('u2', 'U2'));
    const persisted: string[][] = [];
    const pulled = await q.pullSteering('c1', q.runToken('c1'), async (msgs) => {
      persisted.push(msgs.map((m) => m.text));
    });
    expect(pulled.map((m) => m.text)).toEqual(['U1', 'U2']); // 只 user、保序
    expect(persisted).toEqual([['U1', 'U2']]);
    expect(q.pendingCount('c1')).toBe(1); // 机器项留队
    expect(q.pendingUserCount('c1')).toBe(0);
  });

  it('纯机器项队列：pullSteering 返回 []、不调 persist、机器项不动', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', { clientMsgId: 'm1', text: '定时', trigger: 'scheduled' });
    const persist = vi.fn(async () => {});
    const pulled = await q.pullSteering('c1', q.runToken('c1'), persist);
    expect(pulled).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(q.pendingCount('c1')).toBe(1);
    expect(q.pendingUserCount('c1')).toBe(0);
  });

  it('concludeTurn 取全部（含机器项）、按到达序', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', user('u1', 'U1'));
    await q.enqueueOrStart('c1', { clientMsgId: 'm1', text: '定时', trigger: 'scheduled' });
    const persisted: string[] = [];
    const r = await q.concludeTurn('c1', q.runToken('c1'), async (msgs) => {
      persisted.push(...msgs.map((m) => m.text));
    });
    expect('restart' in r && r.restart.map((m) => m.text)).toEqual(['U1', '定时']); // 全部、按到达序
    expect(persisted).toEqual(['U1', '定时']);
  });

  it('pull 取 user 后盘记收窄到剩余机器项（不整清）', async () => {
    const saved: unknown[][] = [];
    const backup = { save: vi.fn(async (_k: string, pending: unknown[]) => { saved.push(pending.slice()); }) };
    const q = createSteeringQueue(seqGen(), backup);
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', user('u1', 'U1')); // save: [U1]
    await q.enqueueOrStart('c1', { clientMsgId: 'm1', text: '定时', trigger: 'scheduled' }); // save: [U1,定时]
    await q.pullSteering('c1', q.runToken('c1'), async () => {}); // 取 U1 → 盘记收窄到 [定时]
    const last = saved[saved.length - 1] as { text: string }[];
    expect(last.map((m) => m.text)).toEqual(['定时']);
  });
});

describe('steeringQueue · 消费 = 落盘先于投递（不变量 2）', () => {
  it('pullSteering 取走当时全部 user、persist 后清队列', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', user('a', 'A'));
    await q.enqueueOrStart('c1', user('b', 'B'));
    await q.enqueueOrStart('c1', user('c', 'C'));
    const persisted: string[][] = [];
    const pulled = await q.pullSteering('c1', q.runToken('c1'), async (msgs) => {
      persisted.push(msgs.map((m) => m.text));
    });
    expect(pulled.map((m) => m.text)).toEqual(['A', 'B', 'C']);
    expect(persisted).toEqual([['A', 'B', 'C']]);
    expect(q.pendingCount('c1')).toBe(0);
  });

  it('队列空时 pullSteering 返回 []，不调 persist（不落空轮）', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('a', 'A'));
    const persist = vi.fn(async () => {});
    const pulled = await q.pullSteering('c1', q.runToken('c1'), persist);
    expect(pulled).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });

  it('persist 失败 → 整批留队列、抛出、下次可重取（不丢、不半消费）', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', user('a', 'A'));
    await q.enqueueOrStart('c1', user('b', 'B'));
    await expect(
      q.pullSteering('c1', q.runToken('c1'), async () => {
        throw new Error('落盘失败');
      }),
    ).rejects.toThrow('落盘失败');
    expect(q.pendingCount('c1')).toBe(2);
    const ok: string[] = [];
    const pulled = await q.pullSteering('c1', q.runToken('c1'), async (msgs) => {
      ok.push(...msgs.map((m) => m.text));
    });
    expect(pulled.map((m) => m.text)).toEqual(['A', 'B']);
    expect(ok).toEqual(['A', 'B']);
    expect(q.pendingCount('c1')).toBe(0);
  });
});

describe('steeringQueue · attachments 透传（G14 放行经队列/盘记全程带引用）', () => {
  it('带 attachments 的项经入队 / pull / concludeTurn 全程原样透传', async () => {
    const q = createSteeringQueue(seqGen());
    const att = [{ kind: 'image' as const, relPath: 'x.png', mediaType: 'image/png' as const, bytes: 1, filename: 'x.png' }];
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', { clientMsgId: 'u1', text: '看图', trigger: 'user', attachments: att });
    const pulled = await q.pullSteering('c1', q.runToken('c1'), async () => {});
    expect(pulled[0].attachments).toEqual(att);
  });
});

describe('steeringQueue · 撤回（不变量 3）', () => {
  it('撤回仍在队列的 → removed，后续 pull 不含它', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', user('a', 'A'));
    await q.enqueueOrStart('c1', user('b', 'B'));
    expect(await q.withdraw('c1', 'a')).toBe('removed');
    const pulled = await q.pullSteering('c1', q.runToken('c1'), async () => {});
    expect(pulled.map((m) => m.clientMsgId)).toEqual(['b']);
  });

  it('撤回已消费的 → alreadyConsumed（不抛、不误删）', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', user('b', 'B'));
    await q.pullSteering('c1', q.runToken('c1'), async () => {});
    expect(await q.withdraw('c1', 'b')).toBe('alreadyConsumed');
  });

  it('撤回回合发起消息（从不入队）→ alreadyConsumed', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    expect(await q.withdraw('c1', 'starter')).toBe('alreadyConsumed');
  });

  it('【并发回归】撤回与消费抢锁：先到先裁，不会两头生效', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', user('a', 'A'));
    const [w, pulled] = await Promise.all([
      q.withdraw('c1', 'a'),
      q.pullSteering('c1', q.runToken('c1'), async () => {}),
    ]);
    if (w === 'removed') {
      expect(pulled.map((m) => m.clientMsgId)).not.toContain('a');
    } else {
      expect(w).toBe('alreadyConsumed');
      expect(pulled.map((m) => m.clientMsgId)).toContain('a');
    }
    expect(q.pendingCount('c1')).toBe(0);
  });
});

describe('steeringQueue · 回合收尾 concludeTurn', () => {
  it('队列空 → idle，running 置 false', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('a', 'A'));
    const r = await q.concludeTurn('c1', q.runToken('c1'), async () => {});
    expect(r).toEqual({ idle: true });
    expect(q.isRunning('c1')).toBe(false);
  });

  it('有 leftover → restart（持续 running），落盘后清队列（回合末读）', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('a', 'A'));
    await q.enqueueOrStart('c1', user('b', 'B'));
    const persisted: string[] = [];
    const r = await q.concludeTurn('c1', q.runToken('c1'), async (msgs) => {
      persisted.push(...msgs.map((m) => m.text));
    });
    expect(r).toEqual({ restart: expect.any(Array) });
    if ('restart' in r) expect(r.restart.map((m) => m.text)).toEqual(['B']);
    expect(persisted).toEqual(['B']);
    expect(q.isRunning('c1')).toBe(true);
    expect(q.pendingCount('c1')).toBe(0);
  });
});

describe('steeringQueue · handBackIfRunning 故障/远程刹车交还（G13/G14）', () => {
  it('running 时取走全部 + 置 idle + 返回批次', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', { clientMsgId: 'm1', text: '定时', trigger: 'scheduled' });
    const batch = await q.handBackIfRunning('c1', q.runToken('c1'));
    expect(batch?.map((m) => m.text)).toEqual(['定时']);
    expect(q.isRunning('c1')).toBe(false);
    expect(q.pendingCount('c1')).toBe(0);
  });

  it('已被交还（idle）时返回 null（幂等，不误清）', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('a', 'A'));
    const token = q.runToken('c1');
    await q.drainUnconsumedOnAbort('c1'); // Esc 抢先交还，running=false
    expect(await q.handBackIfRunning('c1', token)).toBeNull();
  });

  it('【TOCTOU 回归】handBackIfRunning 与 drainUnconsumedOnAbort 并发：只有一方拿到批次', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('starter', '起回合'));
    await q.enqueueOrStart('c1', user('a', 'A'));
    const token = q.runToken('c1');
    const [hb, drained] = await Promise.all([
      q.handBackIfRunning('c1', token),
      q.drainUnconsumedOnAbort('c1'),
    ]);
    // 恰好一方非空：谁先入链谁拿到 A，另一方拿空/null
    const hbGot = (hb ?? []).map((m) => m.text);
    const drGot = drained.map((m) => m.text);
    expect([...hbGot, ...drGot]).toEqual(['A']);
    expect(q.isRunning('c1')).toBe(false);
  });

  it('【并发回归】token 失配：旧回合的 handBackIfRunning 不误清新回合的 running', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('a', 'A')); // 回合1
    const oldToken = q.runToken('c1');
    await q.drainUnconsumedOnAbort('c1'); // Esc 交还回合1，running=false
    await q.enqueueOrStart('c1', user('b', 'B')); // 回合2 起，running=true，token 自增
    // 回合1 的旧循环此刻才处置 aborted：带旧 token 去交还
    const r = await q.handBackIfRunning('c1', oldToken);
    expect(r).toBeNull(); // 旧 token 失配 → 不碰
    expect(q.isRunning('c1')).toBe(true); // 回合2 存活
  });
});

describe('steeringQueue · Esc 退回未消费（不变量 4）', () => {
  it('drainUnconsumedOnAbort 取走仍在队列的、清空、running 置 false', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('a', 'A'));
    await q.enqueueOrStart('c1', user('b', '草稿1'));
    await q.enqueueOrStart('c1', user('c', '草稿2'));
    const drained = await q.drainUnconsumedOnAbort('c1');
    expect(drained.map((m) => m.text)).toEqual(['草稿1', '草稿2']);
    expect(q.pendingCount('c1')).toBe(0);
    expect(q.isRunning('c1')).toBe(false);
  });

  it('已消费的不退回（已落盘留历史）', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('c1', user('a', 'A'));
    await q.enqueueOrStart('c1', user('b', 'B'));
    await q.pullSteering('c1', q.runToken('c1'), async () => {});
    const drained = await q.drainUnconsumedOnAbort('c1');
    expect(drained).toEqual([]);
  });
});

describe('steeringQueue · 多 conv 隔离（不变量 5）', () => {
  it('A 的队列不串 B；各自 running 独立', async () => {
    const q = createSteeringQueue(seqGen());
    await q.enqueueOrStart('A', user('a1', 'A首'));
    await q.enqueueOrStart('A', user('a2', 'A补'));
    const rb = await q.enqueueOrStart('B', user('b1', 'B首'));
    expect(rb).toEqual({ action: 'started', token: 1 });
    expect(q.pendingCount('A')).toBe(1);
    expect(q.pendingCount('B')).toBe(0);
    const pulledB = await q.pullSteering('B', q.runToken('B'), async () => {});
    expect(pulledB).toEqual([]);
    expect(q.pendingCount('A')).toBe(1);
  });
});

describe('steeringQueue · steeringKey', () => {
  it('按 agentId:conversationId 组键', () => {
    expect(steeringKey('twin', 'c1')).toBe('twin:c1');
  });
});

describe('steeringQueue · 占闸即发归属凭据（§6 token 线程化）', () => {
  it('enqueueOrStart started 带 token、beginDirectTurn 返回 token；忙时 null', async () => {
    const q = createSteeringQueue(seqGen());
    const d = await q.enqueueOrStart('c1', user('a', 'A'));
    expect(d.action).toBe('started');
    expect((d as { action: 'started'; token: number }).token).toBe(q.runToken('c1'));
    await q.drainUnconsumedOnAbort('c1');
    const t = await q.beginDirectTurn('c1');
    expect(t).toBe(q.runToken('c1'));
    expect(await q.beginDirectTurn('c1')).toBeNull(); // 忙时占不到
  });
});

describe('steeringQueue · concludeTurn/pullSteering 按 token 归属（僵尸回合防线）', () => {
  it('concludeTurn 带过期 token → 无副作用 idle：不清新回合的闸、不偷其队列', async () => {
    const q = createSteeringQueue(seqGen());
    const d = await q.enqueueOrStart('c1', user('a', '旧'));
    const stale = (d as { action: 'started'; token: number }).token;
    await q.drainUnconsumedOnAbort('c1'); // Esc
    await q.enqueueOrStart('c1', user('b', '新回合')); // token 翻新
    await q.enqueueOrStart('c1', user('c', '新回合的排队消息'));
    const persist = vi.fn(async () => {});
    const r = await q.concludeTurn('c1', stale, persist);
    expect(r).toEqual({ idle: true }); // 僵尸轮就此停转
    expect(persist).not.toHaveBeenCalled(); // 不偷新回合的批
    expect(q.pendingCount('c1')).toBe(1); // 队列原样
    expect(q.isRunning('c1')).toBe(true); // 新回合的闸不被清
  });

  it('pullSteering 带过期 token → 返回空、不动队列', async () => {
    const q = createSteeringQueue(seqGen());
    const d = await q.enqueueOrStart('c1', user('a', '旧'));
    const stale = (d as { action: 'started'; token: number }).token;
    await q.drainUnconsumedOnAbort('c1');
    await q.enqueueOrStart('c1', user('b', '新回合'));
    await q.enqueueOrStart('c1', user('c', 'U'));
    const persist = vi.fn(async () => {});
    expect(await q.pullSteering('c1', stale, persist)).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(q.pendingUserCount('c1')).toBe(1);
  });
});

describe('steeringQueue · 连发撤起三态裁决（S1：idle / busy-enqueue / busy-restartIfClean）', () => {
  // 在飞回合可撤性探针：真实判定数据由装配层在事件流上打标（liveTurnMark），队列只读——
  // 测试注入 fake 探针，只验「裁决三态 + token 归属」，打标本身在 liveTurnMark.test.ts 验。
  const restartable = { isRestartable: () => true };
  const established = { isRestartable: () => false };

  it('忙 + 可撤（窗口内无产出）+ 用户消息 → restart + token 翻新，消息不入队', async () => {
    const q = createSteeringQueue(seqGen(), undefined, restartable);
    const d1 = await q.enqueueOrStart('c1', user('a', '在'));
    expect(d1).toEqual({ action: 'started', token: 1 });
    const d2 = await q.enqueueOrStart('c1', user('b', '吗'));
    expect(d2).toEqual({ action: 'restart', token: 2 });
    expect(q.pendingCount('c1')).toBe(0); // 不排队——由入口落盘后带更全历史重起
    expect(q.isRunning('c1')).toBe(true); // 闸不换手的连续持有
  });

  it('忙 + 不可撤（已有产出 / 窗口外）→ 走现状入队', async () => {
    const q = createSteeringQueue(seqGen(), undefined, established);
    await q.enqueueOrStart('c1', user('a', '在'));
    const d2 = await q.enqueueOrStart('c1', user('b', '吗'));
    expect(d2).toEqual({ action: 'enqueued', serverId: 's1' });
    expect(q.pendingCount('c1')).toBe(1);
  });

  it('可撤也不接：机器触发（scheduled / task-completed）与模式指令（/loop）照走排队', async () => {
    const q = createSteeringQueue(seqGen(), undefined, restartable);
    await q.enqueueOrStart('c1', user('a', '在'));
    expect(await q.enqueueOrStart('c1', { clientMsgId: 'm1', text: '定时', trigger: 'scheduled' }))
      .toEqual({ action: 'enqueued', serverId: 's1' });
    expect(await q.enqueueOrStart('c1', { clientMsgId: 'm2', text: '播报', trigger: 'task-completed' }))
      .toEqual({ action: 'enqueued', serverId: 's2' });
    expect(await q.enqueueOrStart('c1', { clientMsgId: 'm3', text: '/loop 查完为止', trigger: 'user', modeCommand: 'loop' }))
      .toEqual({ action: 'enqueued', serverId: 's3' });
    expect(q.pendingCount('c1')).toBe(3);
    expect(q.runToken('c1')).toBe(1); // 闸未被任何一条翻新
  });

  it('连发 N 条（探针恒可撤）：1 started + (N-1) restart，token 逐条翻新', async () => {
    const q = createSteeringQueue(seqGen(), undefined, restartable);
    const first = await q.enqueueOrStart('c1', user('m0', '在'));
    const rest = [];
    for (let i = 1; i <= 3; i += 1) rest.push(await q.enqueueOrStart('c1', user(`m${i}`, `t${i}`)));
    expect(first).toEqual({ action: 'started', token: 1 });
    expect(rest).toEqual([
      { action: 'restart', token: 2 },
      { action: 'restart', token: 3 },
      { action: 'restart', token: 4 },
    ]);
    expect(q.pendingCount('c1')).toBe(0);
  });

  it('【撤起不交手还】restart 翻新 token 后，被撤回合的队列操作全部失效', async () => {
    const q = createSteeringQueue(seqGen(), undefined, restartable);
    const d1 = await q.enqueueOrStart('c1', user('a', '在'));
    const oldToken = (d1 as { action: 'started'; token: number }).token;
    await q.enqueueOrStart('c1', user('b', '吗')); // restart，token 翻新
    // 被撤回合收尾路径带旧 token 回来：交还 / drain / 收尾全部失配 no-op——不触发 handback、
    // 不清新回合的闸（runSteeringTurnLoop 的 aborted 分支据此静默停转）。
    expect(await q.handBackIfRunning('c1', oldToken)).toBeNull();
    expect(await q.pullSteering('c1', oldToken, async () => {})).toEqual([]);
    expect(await q.concludeTurn('c1', oldToken, async () => {})).toEqual({ idle: true });
    expect(q.isRunning('c1')).toBe(true);
    expect(q.runToken('c1')).toBe(2);
  });

  it('restart 决策不打盘记（消息未入队，无「待消费」可镜像）', async () => {
    const saved: string[][] = [];
    const backup = { save: async (_key: string, pending: { text: string }[]) => { saved.push(pending.map((m) => m.text)); } };
    const q = createSteeringQueue(seqGen(), backup, restartable);
    await q.enqueueOrStart('c1', user('a', '在'));
    await q.enqueueOrStart('c1', user('b', '吗')); // restart
    expect(saved).toEqual([]); // started 本就无盘记；restart 同样零队列变更
  });
});
