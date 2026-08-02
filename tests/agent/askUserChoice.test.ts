/**
 * ask_user_choice 工具单测（技术设计 §测试）：
 *  - schema 校验：questions 0 / >4、options <2 / >5 → isError
 *  - 回给模型的文本拼接：单选 / 多选 / 我自己说 / 单题跳过 / 全跳过
 *  - ctx.askUserChoice 缺失 → isError（背景 Twin / subagent 优雅拒绝）
 *  - abort → ctx.askUserChoice reject 透传（execute 抛 → 现有中断回合落盘接住）
 *
 * round-trip 接线 + 并发两 ask 不互覆 在集成 smoke 里验，这里只覆盖工具本体与纯函数。
 */
import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@shared/agent/backend';
import type { AskUserChoiceQuestion } from '@shared/types';
import {
  makeAskUserChoiceTool,
  validateAskUserChoiceInput,
  formatAnswersForModel,
} from '../../electron/main/agent/agentTools/askUserChoice';
import { settleUserChoice } from '../../electron/main/proposals/pendingUserChoice';
import { makeToolContext } from '../helpers/toolContext';

/** 等一个微任务，让 execute 注册 waiter + 调 askUserChoice 回调拿到 askId */
const tick = () => new Promise((r) => setTimeout(r, 0));

const ctx = (extras?: Partial<ToolContext>): ToolContext =>
  makeToolContext({ conversationId: 'conv-1', agentId: 'agent-1', ownerId: 'owner-1', ...extras });

const Q = (over?: Partial<AskUserChoiceQuestion>): AskUserChoiceQuestion => ({
  question: '主线放哪？',
  header: '叙事重心',
  options: [{ label: '自然人文' }, { label: '纯人文' }],
  ...over,
});

describe('validateAskUserChoiceInput', () => {
  it('questions 必须 1..4', () => {
    expect('error' in validateAskUserChoiceInput({ questions: [] })).toBe(true);
    expect('error' in validateAskUserChoiceInput({ questions: undefined })).toBe(true);
    expect('error' in validateAskUserChoiceInput({ questions: [Q(), Q(), Q(), Q(), Q()] })).toBe(true);
    expect('error' in validateAskUserChoiceInput({ questions: [Q()] })).toBe(false);
  });

  it('每题 options 必须 2..5', () => {
    const one = validateAskUserChoiceInput({ questions: [Q({ options: [{ label: 'a' }] })] });
    expect('error' in one).toBe(true);
    const six = validateAskUserChoiceInput({
      questions: [Q({ options: Array.from({ length: 6 }, (_, i) => ({ label: `o${i}` })) })],
    });
    expect('error' in six).toBe(true);
  });

  it('缺 question / header / 选项 label → 报错', () => {
    expect('error' in validateAskUserChoiceInput({ questions: [Q({ question: '  ' })] })).toBe(true);
    expect('error' in validateAskUserChoiceInput({ questions: [Q({ header: '' })] })).toBe(true);
    expect(
      'error' in validateAskUserChoiceInput({ questions: [Q({ options: [{ label: 'a' }, { label: '' }] })] }),
    ).toBe(true);
  });
});

describe('formatAnswersForModel', () => {
  const questions = [Q(), Q({ header: '视觉', question: '走哪种气质？', multiSelect: true })];

  it('单选 → header：label', () => {
    const t = formatAnswersForModel([Q()], { answers: [{ questionIndex: 0, selectedLabels: ['纯人文'] }] });
    expect(t).toBe('叙事重心：纯人文');
  });

  it('多选 → 逗号分隔', () => {
    const t = formatAnswersForModel(questions, {
      answers: [
        { questionIndex: 0, selectedLabels: ['自然人文'] },
        { questionIndex: 1, selectedLabels: ['极简', '暖厚'] },
      ],
    });
    expect(t).toBe('叙事重心：自然人文\n视觉：极简，暖厚');
  });

  it('我自己说 → （我自己说）freeText，优先于 selectedLabels', () => {
    const t = formatAnswersForModel([Q()], {
      answers: [{ questionIndex: 0, freeText: '想更暖一点', selectedLabels: ['纯人文'] }],
    });
    expect(t).toBe('叙事重心：（我自己说）想更暖一点');
  });

  it('单题跳过（没选 / 显式 skipped）→ 用户跳过', () => {
    const t = formatAnswersForModel(questions, {
      answers: [{ questionIndex: 0, selectedLabels: ['自然人文'] }, { questionIndex: 1, skipped: true }],
    });
    expect(t).toBe('叙事重心：自然人文\n视觉：用户跳过');
  });

  it('全跳过（含多选 0 项）→ 统一提示', () => {
    const t = formatAnswersForModel(questions, {
      answers: [{ questionIndex: 0, skipped: true }, { questionIndex: 1, selectedLabels: [] }],
    });
    expect(t).toBe('用户跳过了选择，请你自行判断。');
  });
});

describe('makeAskUserChoiceTool().execute', () => {
  it('入参非法 → isError，不弹卡', async () => {
    const tool = makeAskUserChoiceTool();
    let emitted = false;
    const r = await tool.execute(
      { questions: [] },
      ctx({ askUserChoice: async () => { emitted = true; } }),
    );
    expect(r.isError).toBe(true);
    expect(emitted).toBe(false);
  });

  it('ctx.askUserChoice 缺失 → isError（优雅拒绝）', async () => {
    const tool = makeAskUserChoiceTool();
    const r = await tool.execute({ questions: [Q()] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('不支持');
  });

  it('正常作答 → settle 唤醒 → 拼回文本 + structured 带回答', async () => {
    const tool = makeAskUserChoiceTool();
    let askId = '';
    const p = tool.execute(
      { questions: [Q()] },
      ctx({ askUserChoice: async (req) => { askId = req.askId; } }),
    );
    await tick();
    expect(askId).toMatch(/^ask_/);
    expect(settleUserChoice(askId, { answers: [{ questionIndex: 0, selectedLabels: ['纯人文'] }] })).toBe(true);
    const r = await p;
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('叙事重心：纯人文');
    expect(r.structured).toEqual({ answers: [{ questionIndex: 0, selectedLabels: ['纯人文'] }] });
  });

  it('并发两个 ask → 各自唯一 askId、各自 resolve、互不覆盖', async () => {
    const tool = makeAskUserChoiceTool();
    const ids: string[] = [];
    const mk = () =>
      tool.execute({ questions: [Q()] }, ctx({ askUserChoice: async (req) => { ids.push(req.askId); } }));
    const p1 = mk();
    const p2 = mk();
    await tick();
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    // 乱序 settle，验证按 askId 精确命中
    settleUserChoice(ids[1], { answers: [{ questionIndex: 0, selectedLabels: ['B'] }] });
    settleUserChoice(ids[0], { answers: [{ questionIndex: 0, selectedLabels: ['A'] }] });
    expect((await p1).text).toBe('叙事重心：A');
    expect((await p2).text).toBe('叙事重心：B');
  });

  it('abort → ctx.abortSignal 触发 waiter reject → execute 抛', async () => {
    const tool = makeAskUserChoiceTool();
    const ac = new AbortController();
    const p = tool.execute(
      { questions: [Q()] },
      ctx({ abortSignal: ac.signal, askUserChoice: async () => {} }),
    );
    await tick();
    ac.abort();
    await expect(p).rejects.toThrow();
  });

  it('弹卡回调抛错 → isError（dispatch 失败兜底）', async () => {
    const tool = makeAskUserChoiceTool();
    const r = await tool.execute(
      { questions: [Q()] },
      ctx({ askUserChoice: async () => Promise.reject(new Error('broadcast 挂了')) }),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain('弹出提问卡失败');
  });
});
