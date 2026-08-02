/**
 * 对话期 subagent 的 ask_twin 解析器（G72）——先问背景 Twin、答不上升级用户提问卡。
 *
 * 验三条：
 *  1. 背景 Twin 直接答上 → 返回 Twin 的答案，不弹提问卡（用户不受打扰）。
 *  2. 背景 Twin escalate → 经 askUserChoice 弹卡、阻塞等用户，用户答完回填其自由文本。
 *  3. 累计反问超上限 → 强制升级用户，不再空跑背景 Twin。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskUserChoiceQuestion } from '@shared/types';
import { __setRunBackgroundForTest } from '../../electron/main/agent/twinBackgroundQuery';
import { settleUserChoice } from '../../electron/main/proposals/pendingUserChoice';
import { makeSubagentAskTwinResolver } from '../../electron/main/agent/subagentChat/askTwinResolver';

afterEach(() => {
  vi.restoreAllMocks();
});

type EmittedAsk = { askId: string; questions: AskUserChoiceQuestion[] };

function makeResolver(emitted: EmittedAsk[], signal = new AbortController().signal, maxAsk?: number) {
  return makeSubagentAskTwinResolver({
    agentId: 'ag1',
    description: '整理测试目录',
    askUserChoice: async (req) => {
      emitted.push(req);
    },
    abortSignal: signal,
    maxAsk,
  });
}

describe('makeSubagentAskTwinResolver（G72）', () => {
  it('背景 Twin 直接答上 → 返回答案、不弹提问卡', async () => {
    const restore = __setRunBackgroundForTest(async () => ({ resultText: '用 vitest 跑', isError: false }));
    const emitted: EmittedAsk[] = [];
    const resolve = makeResolver(emitted);

    const answer = await resolve('task1', '用哪个测试框架？', []);

    expect(answer).toBe('用 vitest 跑');
    expect(emitted, '没升级用户就不该弹卡').toHaveLength(0);
    restore();
  });

  it('背景 Twin escalate → 弹提问卡、阻塞等用户，回填用户自由文本', async () => {
    // 背景 Twin 调 escalateHandler（转给用户）后自身返回
    const restore = __setRunBackgroundForTest(async ({ escalateHandler, taskId }) => {
      await escalateHandler?.(taskId ?? 'task1', '两个同名 config，改哪个？');
      return { resultText: '', isError: false };
    });
    const emitted: EmittedAsk[] = [];
    const resolve = makeResolver(emitted);

    const p = resolve('task1', '两个同名 config，改哪个？', ['a/config.ts', 'b/config.ts']);
    // 让 escalate 的 emit 落定
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0].questions[0].options, 'options 留空 → 卡片退化成纯自由文本').toEqual([]);

    // 用户作答（自由文本）
    const ok = settleUserChoice(emitted[0].askId, {
      answers: [{ questionIndex: 0, freeText: '改 a/config.ts' }],
    });
    expect(ok).toBe(true);

    await expect(p).resolves.toContain('改 a/config.ts');
    restore();
  });

  it('累计反问超上限 → 强制升级用户，不跑背景 Twin', async () => {
    let bgCalls = 0;
    const restore = __setRunBackgroundForTest(async () => {
      bgCalls += 1;
      return { resultText: 'ans', isError: false };
    });
    const emitted: EmittedAsk[] = [];
    const resolve = makeResolver(emitted, undefined, 1); // maxAsk=1

    // 第 1 次：正常走背景 Twin，直接答上
    await resolve('task1', 'q1', []);
    expect(bgCalls).toBe(1);
    expect(emitted).toHaveLength(0);

    // 第 2 次：超上限 → 强制升级用户，不再跑背景 Twin
    const p = resolve('task1', 'q2', []);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(bgCalls, '超上限不该再跑背景 Twin').toBe(1);
    settleUserChoice(emitted[0].askId, { answers: [{ questionIndex: 0, freeText: '你自己定' }] });
    await expect(p).resolves.toContain('你自己定');
    restore();
  });
});
