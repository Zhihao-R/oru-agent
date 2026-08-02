/**
 * 反问终局的卡收场（loop 去特殊化 T1）：拆解回合只输出文本 → 反问落成主对话 assistant 消息
 * （chat.loopClarify 广播 + 落盘），伴随卡落 clarify 安静终态（非 failed 不翻红），loop 不开跑。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.ORU_DIR = `${process.env.TMPDIR ?? '/tmp'}/oru-test-loopclarify-${process.pid}`;
});

vi.mock('../../electron/main/agent/store/agents', () => ({
  getAgent: async () => ({ id: 'a1', name: 'oru', homePath: '/tmp' }),
}));
vi.mock('../../electron/main/agent/runner', () => ({ abortConversation: vi.fn() }));
vi.mock('../../electron/main/conversations/store', () => ({
  getConversation: async () => ({ id: 'c1', kind: 'sub' }),
  readHistory: async () => [],
  appendMessage: vi.fn(async () => {}),
}));
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: async () => ({ loopMaxRounds: 5, language: 'zh' }),
}));
vi.mock('../../electron/main/ws/handlers/mainTurnAssembly', () => ({
  buildMainTurnRunner: vi.fn(() => ({ runOneTurn: vi.fn() })),
}));
vi.mock('../../electron/main/loop/runLoop', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../electron/main/loop/runLoop')>();
  return { ...orig, runLoop: vi.fn() };
});
vi.mock('../../electron/main/loop/compileChecklist', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../electron/main/loop/compileChecklist')>();
  return {
    ...orig,
    compileChecklist: vi.fn(async () => ({ kind: 'clarify', text: '「筛一遍」指哪批名单？' })),
  };
});

import { runLoopOrchestration, runLoopOrchestrationAndRelease } from '../../electron/main/loop/orchestrate';
import { runLoop } from '../../electron/main/loop/runLoop';
import { compileChecklist } from '../../electron/main/loop/compileChecklist';
import { appendMessage } from '../../electron/main/conversations/store';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';
import type { ChatAttachment, ChatMessage } from '@shared/types';

describe('orchestrate · 拆解反问收场', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clarify：反问上屏 + 卡落 clarify 终态 + loop 不开跑', async () => {
    const events: Array<{ type: string; message?: ChatMessage }> = [];
    // 编排要求持闸起跑（await 后归属重检）——测试如实占闸
    const token = (await steeringQueue.beginDirectTurn(steeringKey('a1', 'c1')))!;
    await runLoopOrchestration({
      agentId: 'a1',
      conversationId: 'c1',
      goal: '看看名单',
      runToken: token,
      broadcast: (ev) => events.push(ev as (typeof events)[number]),
    });
    await steeringQueue.handBackIfRunning(steeringKey('a1', 'c1'), token);

    // 反问经 chat.loopClarify 广播为普通 assistant 消息
    const clarify = events.find((e) => e.type === 'chat.loopClarify');
    expect(clarify?.message).toMatchObject({ role: 'assistant', text: '「筛一遍」指哪批名单？', done: true });

    // 卡落 clarify 安静终态（done 非 failed，无 error）
    const cards = events.filter((e) => e.type === 'chat.loopCard');
    const final = cards.at(-1)?.message?.loopCard;
    expect(final).toMatchObject({ phase: 'done', stopReason: 'clarify' });
    expect(final?.error).toBeUndefined();

    // 反问消息与终态卡都落盘（与 finishCard 同路径）
    const persisted = vi.mocked(appendMessage).mock.calls.map((c) => c[2] as ChatMessage);
    expect(persisted.some((m) => m.text === '「筛一遍」指哪批名单？')).toBe(true);
    expect(persisted.some((m) => m.kind === 'loop-checklist' && m.loopCard?.stopReason === 'clarify')).toBe(true);

    // loop 内核没被启动
    expect(runLoop).not.toHaveBeenCalled();
  });

  it('归属重检：占闸后被 Esc 清闸（token 失配）→ 编排就此打住，不拆解、不落卡（review 修正回归）', async () => {
    const key = steeringKey('a1', 'c-esc');
    const token = (await steeringQueue.beginDirectTurn(key))!;
    await steeringQueue.drainUnconsumedOnAbort(key); // 模拟 Esc：无条件清闸

    const events: Array<{ type: string }> = [];
    await runLoopOrchestration({
      agentId: 'a1',
      conversationId: 'c-esc',
      goal: '看看名单',
      runToken: token,
      broadcast: (ev) => events.push(ev as (typeof events)[number]),
    });

    expect(compileChecklist).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(events).toEqual([]); // 连 compiling 卡都不广播——loop 从未起跑
  });

  it('runLoopOrchestrationAndRelease：编排收尾释闸 + 交还编排期间入队的消息（收尾三件套单源）', async () => {
    const key = steeringKey('a1', 'c-release');
    const token = (await steeringQueue.beginDirectTurn(key))!;
    // 编排期间入队一条用户消息（模式指令后到的普通话）——收尾应整批交还
    await steeringQueue.enqueueOrStart(key, { clientMsgId: 'q1', text: '补一句', trigger: 'user' });

    const events: Array<{ type: string; items?: Array<{ text: string }> }> = [];
    await runLoopOrchestrationAndRelease({
      agentId: 'a1',
      conversationId: 'c-release',
      goal: '看看名单',
      runToken: token,
      broadcast: (ev) => events.push(ev as (typeof events)[number]),
    });

    expect(steeringQueue.isRunning(key)).toBe(false); // 收尾已释闸
    const handback = events.find((e) => e.type === 'chat.queue.handback');
    expect(handback?.items?.map((m) => m.text)).toEqual(['补一句']);
  });

  it('/loop 带的图转交拆解回合（干活轮从历史自取，编排只管拆解这一程）', async () => {
    const img: ChatAttachment = {
      kind: 'image',
      relPath: 'attachments/m1/a.png',
      mediaType: 'image/png',
      bytes: 10,
      filename: 'a.png',
    };
    const token = (await steeringQueue.beginDirectTurn(steeringKey('a1', 'c-att')))!;
    await runLoopOrchestration({
      agentId: 'a1',
      conversationId: 'c-att',
      goal: '照这张图建表',
      runToken: token,
      broadcast: () => {},
      attachments: [img],
    });
    await steeringQueue.handBackIfRunning(steeringKey('a1', 'c-att'), token);

    expect(compileChecklist).toHaveBeenCalledWith(expect.objectContaining({ attachments: [img] }));
  });
});
