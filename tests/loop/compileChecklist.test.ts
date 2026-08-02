import { describe, it, expect, vi, afterEach } from 'vitest';

// compileChecklist 全链路不落盘（debugLogger 显式关、backend 走注入 mock），ORU_DIR 仅护栏——
// 用 vi.hoisted 保证在被 hoist 的模块求值之前生效（vitest 静态 import 提升陷阱）。
vi.hoisted(() => {
  process.env.ORU_DIR = `${process.env.TMPDIR ?? '/tmp'}/oru-test-loopcompile-${process.pid}`;
});

import type { AgentBackend, ConversationEvent, ConversationInput, ToolContext } from '@shared/agent/backend';
import type { ChatMessage } from '@shared/types';
import { __setBackendFactoryForTest } from '../../electron/main/agent/backends/factory';
import { debugLogger } from '../../electron/main/debug/logger';
import { t } from '../../electron/main/i18n/t';
import {
  buildCompilePrompt,
  projectContextTail,
  compileChecklist,
} from '../../electron/main/loop/compileChecklist';
import { makeSubmitChecklistTool, toChecklistItems } from '../../electron/main/loop/submitChecklistTool';

const GOAL = '把周报打磨到能发给投资人：开头三句要抓得住注意力，数据别出错';

describe('buildCompilePrompt', () => {
  it('目标进 prompt，要求提交可核验的验收标准、拆不出就反问', () => {
    const p = buildCompilePrompt(GOAL);
    expect(p).toContain(GOAL);
    expect(p).toContain('submit_checklist');
    expect(p).toMatch(/提问/);
  });

  it('带对话节选 → 节选在目标之前、标明只用于解指代', () => {
    const p = buildCompilePrompt(GOAL, '用户：上一轮筛到中型公司了');
    expect(p).toContain('上一轮筛到中型公司了');
    expect(p.indexOf('上一轮筛到中型公司了')).toBeLessThan(p.indexOf(GOAL));
    expect(p).toMatch(/指代/);
  });

  it('无节选 / 空白节选 → 不出现上下文段', () => {
    expect(buildCompilePrompt(GOAL)).not.toContain('对话节选');
    expect(buildCompilePrompt(GOAL, '  ')).not.toContain('对话节选');
  });
});

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: 0,
    done: true,
    ...over,
  };
}

describe('projectContextTail', () => {
  it('取有正文的 user/assistant 消息、带角色标签', () => {
    const tail = projectContextTail([
      msg({ role: 'user', text: '先筛小型公司' }),
      msg({ role: 'assistant', text: '筛好了，共 12 家' }),
    ]);
    expect(tail).toBe('用户：先筛小型公司\n助手：筛好了，共 12 家');
  });

  it('无正文消息（纯工具轮 / 伴随卡）与 system 消息被跳过', () => {
    const tail = projectContextTail([
      msg({ role: 'assistant', text: '' }),
      msg({ role: 'system', text: '系统提示' }),
      msg({ role: 'user', text: '继续' }),
    ]);
    expect(tail).toBe('用户：继续');
  });

  it('只留最近 6 条', () => {
    const many = Array.from({ length: 9 }, (_, i) => msg({ role: 'user', text: `第${i + 1}句` }));
    const tail = projectContextTail(many);
    expect(tail).not.toContain('第3句');
    expect(tail).toContain('第4句');
    expect(tail).toContain('第9句');
  });

  it('单条超长截断', () => {
    const tail = projectContextTail([msg({ role: 'user', text: 'x'.repeat(500) })]);
    expect(tail.length).toBeLessThan(450);
    expect(tail).toContain('……');
  });

  it('空历史 → 空串', () => {
    expect(projectContextTail([])).toBe('');
  });

  it('loop-checklist 终态卡投影成一行摘要（T3「发『继续』」的接续通道）', () => {
    const tail = projectContextTail([
      msg({ role: 'user', text: '/loop 把报告打磨到能交付' }),
      msg({
        role: 'assistant',
        text: '',
        kind: 'loop-checklist',
        loopCard: {
          loopId: 'lp', goal: '把报告打磨到能交付', phase: 'interrupted', round: 2, maxRounds: 5,
          checklist: [
            { id: 'c1', statement: '有第三节', status: 'satisfied' },
            { id: 'c2', statement: '数据口径一致', status: 'pending' },
          ],
        },
      }),
      msg({ role: 'user', text: '继续' }),
    ]);
    expect(tail).toContain('目标：把报告打磨到能交付');
    expect(tail).toContain('被打断（停在第 2 轮）');
    expect(tail).toContain('✓有第三节');
    expect(tail).toContain('✗数据口径一致');
  });

  it('运行中的 loop 卡（非终态）不投影', () => {
    const tail = projectContextTail([
      msg({
        role: 'assistant',
        text: '',
        kind: 'loop-checklist',
        loopCard: { loopId: 'lp', goal: 'g', phase: 'running', round: 1, maxRounds: 5, checklist: [] },
      }),
    ]);
    expect(tail).toBe('');
  });
});

// ─── submit_checklist 工具：校验语义承接旧 parseChecklistOutput ────────────

describe('toChecklistItems', () => {
  it('合法清单 → 赋 id（c1 起）、status=pending、保留 statement', () => {
    const out = toChecklistItems({
      items: [{ statement: '数据口径与上季一致' }, { statement: '开头三句抓得住注意' }],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'c1', statement: '数据口径与上季一致', status: 'pending' });
    expect(out[1].id).toBe('c2');
  });

  it('空 statement 项被剔除', () => {
    const out = toChecklistItems({ items: [{ statement: '  ' }, { statement: '真项' }] });
    expect(out).toHaveLength(1);
    expect(out[0].statement).toBe('真项');
  });

  it('缺 items / 空清单 / 全空项 → throw（校验失败要具体）', () => {
    expect(() => toChecklistItems({})).toThrow(/items/);
    expect(() => toChecklistItems({ items: [] })).toThrow(/空/);
    expect(() => toChecklistItems({ items: [{ statement: '' }] })).toThrow(/空/);
  });
});

function toolCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: 'c1',
    agentId: 'a1',
    ownerId: 'o1',
    usage: 'loopCompile',
    approvalMode: 'work',
    abortSignal: new AbortController().signal,
    ...over,
  };
}

describe('submit_checklist 工具回执', () => {
  const tool = makeSubmitChecklistTool();

  it('合法提交 → 经 onChecklistSubmit 交回清单、回执成功', async () => {
    let received: unknown = null;
    const r = await tool.execute(
      { items: [{ statement: '有第三节' }] },
      toolCtx({ onChecklistSubmit: (items) => (received = items) }),
    );
    expect(r.isError).toBeFalsy();
    expect(received).toMatchObject([{ id: 'c1', statement: '有第三节', status: 'pending' }]);
  });

  it('格式错 → isError 回执带具体原因（同回合自愈的抓手），不触发提交', async () => {
    let called = false;
    const r = await tool.execute(
      { items: [] },
      toolCtx({ onChecklistSubmit: () => (called = true) }),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/空/);
    expect(called).toBe(false);
  });

  it('拆解回合外被调到（无 onChecklistSubmit）→ isError，不静默吞', async () => {
    const r = await tool.execute({ items: [{ statement: 'x' }] }, toolCtx());
    expect(r.isError).toBe(true);
  });
});

// ─── compileChecklist 受限回合（回归 2026-07-27 现场 + 各终局）─────────────

/**
 * 事件流脚本化 mock backend：runConversation 按 script 依次吐事件；
 * 出现 { callTool: input } 步骤时同步调 toolContext 上挂的 submit_checklist 执行体
 * （模拟 backend 的工具 round-trip）。inputs 收集每次 ConversationInput 供断言。
 */
type ScriptStep =
  | { event: ConversationEvent }
  | { callTool: unknown }
  | { throw: string };

function makeBackend(script: ScriptStep[], inputs: ConversationInput[]): AgentBackend {
  const tool = makeSubmitChecklistTool();
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'mdl_test',
    providerId: 'prv_test',
    runConversation: (input: ConversationInput) => {
      inputs.push(input);
      async function* gen(): AsyncGenerator<ConversationEvent> {
        for (const step of script) {
          // 如实模拟 round-trip 内核的 abort 行为：轮顶 break、事件流正常收束（不抛、不补 result）
          if (input.abortController.signal.aborted) return;
          if ('throw' in step) throw new Error(step.throw);
          if ('callTool' in step) {
            yield { type: 'tool_use', id: 't1', name: 'submit_checklist', input: step.callTool as Record<string, unknown> };
            const r = await tool.execute(step.callTool, input.toolContext!);
            yield { type: 'tool_result', toolUseId: 't1', isError: !!r.isError, content: r.text };
          } else {
            yield step.event;
          }
        }
      }
      return { events: gen() };
    },
    runOneShot: async () => {
      throw new Error('not used');
    },
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  } satisfies AgentBackend;
}

describe('compileChecklist · 受限回合终局', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  const OPTS = {
    goal: '把中型和大型公司都筛一遍并录入',
    agentId: 'a1',
    conversationId: 'loop_t1_compile',
    agentName: 'oru',
    lang: 'zh' as const,
    cwd: process.cwd(),
  };
  const VALID = { items: [{ statement: '中型与大型公司均已录入表格' }] };

  it('调了 submit_checklist（合法）→ 返回清单开跑', async () => {
    debugLogger.setEnabled(false);
    const inputs: ConversationInput[] = [];
    restore = __setBackendFactoryForTest(async () =>
      makeBackend(
        [{ callTool: VALID }, { event: { type: 'result', resultText: null, isError: false } }],
        inputs,
      ),
    );
    const out = await compileChecklist(OPTS);
    expect(out.kind).toBe('checklist');
    if (out.kind === 'checklist') {
      expect(out.items[0]).toMatchObject({ id: 'c1', statement: '中型与大型公司均已录入表格', status: 'pending' });
    }
  });

  it('受限回合装配：restrictToolsTo 只放 submit_checklist、prompt 在 history 末尾 user 轮（userMessage 契约）', async () => {
    debugLogger.setEnabled(false);
    const inputs: ConversationInput[] = [];
    restore = __setBackendFactoryForTest(async () =>
      makeBackend(
        [{ callTool: VALID }, { event: { type: 'result', resultText: null, isError: false } }],
        inputs,
      ),
    );
    await compileChecklist(OPTS);
    const input = inputs[0];
    expect(input.restrictToolsTo).toEqual(['submit_checklist']);
    // userMessage 契约：anthropic / openaiCompatible 只 replay history，prompt 必须是末尾 user 轮
    const last = input.history?.at(-1);
    expect(last?.role).toBe('user');
    expect(last?.text).toBe(input.userMessage);
    expect(last?.text).toContain(OPTS.goal);
    expect(input.toolContext?.usage).toBe('loopCompile');
  });

  it('格式错 → 工具错误回执 → 同回合修正重交成功（2026-07-27 自建重试的替代路径）', async () => {
    debugLogger.setEnabled(false);
    const inputs: ConversationInput[] = [];
    restore = __setBackendFactoryForTest(async () =>
      makeBackend(
        [
          { callTool: { items: [] } }, // 首交空清单 → isError 回执
          { callTool: VALID }, // 模型看回执后修正重交
          { event: { type: 'result', resultText: null, isError: false } },
        ],
        inputs,
      ),
    );
    const out = await compileChecklist(OPTS);
    expect(out.kind).toBe('checklist');
  });

  it('只输出文本（没调工具）→ 视为澄清问题（clarify），loop 不开跑', async () => {
    debugLogger.setEnabled(false);
    restore = __setBackendFactoryForTest(async () =>
      makeBackend(
        [
          { event: { type: 'assistant_text', text: '「筛一遍」指哪批名单？' } },
          { event: { type: 'result', resultText: '「筛一遍」指哪批名单？', isError: false } },
        ],
        [],
      ),
    );
    const out = await compileChecklist(OPTS);
    expect(out).toEqual({ kind: 'clarify', text: '「筛一遍」指哪批名单？' });
  });

  it('backend 抛错 → 抛不归因中性文案（不怪目标、不错怪网络、内部黑话不上屏）', async () => {
    debugLogger.setEnabled(false);
    restore = __setBackendFactoryForTest(async () => makeBackend([{ throw: 'HTTP 500' }], []));
    const err = await compileChecklist(OPTS).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(t('main:loop.compileFailed', 'zh'));
    expect(err?.message).not.toContain('HTTP');
    expect(err?.message).not.toMatch(/具体|模糊/); // 「说得更具体」错误指导已消失
  });

  it('撞工具尝试封顶（反复无效提交不收手）→ 掐回合、抛同一份中性文案', async () => {
    debugLogger.setEnabled(false);
    // 6 次无效提交（> MAX_SUBMIT_ATTEMPTS=4）——超限即 abort，mock 感知 signal 后静默收束
    const flood: ScriptStep[] = Array.from({ length: 6 }, () => ({ callTool: { items: [] } }) as ScriptStep);
    restore = __setBackendFactoryForTest(async () => makeBackend(flood, []));
    const err = await compileChecklist(OPTS).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(t('main:loop.compileFailed', 'zh'));
  });

  it('撞封顶且失败尝试夹带说明文字 → 仍是中性文案，不把边角料误判成反问（review 修正回归）', async () => {
    debugLogger.setEnabled(false);
    // 模型每次失败提交前都说一句话（真实模型常态）——abort 后事件流静默收束，这些文字不得当 clarify
    const flood: ScriptStep[] = [];
    for (let i = 0; i < 6; i += 1) {
      flood.push({ event: { type: 'assistant_text', text: `我重新整理一下清单（第 ${i + 1} 次）：` } });
      flood.push({ callTool: { items: [] } });
    }
    restore = __setBackendFactoryForTest(async () => makeBackend(flood, []));
    const out = await compileChecklist(OPTS).then(
      (o) => o,
      (e: Error) => e,
    );
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toBe(t('main:loop.compileFailed', 'zh'));
  });

  it('空产出（无提交、无文本、正常收尾）→ 中性文案', async () => {
    debugLogger.setEnabled(false);
    restore = __setBackendFactoryForTest(async () =>
      makeBackend([{ event: { type: 'result', resultText: null, isError: false } }], []),
    );
    const err = await compileChecklist(OPTS).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(t('main:loop.compileFailed', 'zh'));
  });

  it('上游中止（用户停）→ 原样透传、不包人话', async () => {
    debugLogger.setEnabled(false);
    const ctl = new AbortController();
    ctl.abort();
    restore = __setBackendFactoryForTest(async () => makeBackend([{ throw: 'should not run' }], []));
    const err = await compileChecklist({ ...OPTS, signal: ctl.signal }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.message).not.toBe(t('main:loop.compileFailed', 'zh'));
  });
});
