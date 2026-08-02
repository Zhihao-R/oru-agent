/**
 * organizeContext 两阶段整理内核（S16 G62/G63）
 *
 * - organizeThreshold(window) = floor(window/2)：既是触发线也是装载目标。
 * - 未到水位且非 force → null。
 * - 阶段一·折叠：折叠后 ≤ 水位 → stage:'fold'，不调摘要 LLM、不落卡。
 * - 阶段二·摘要：折叠后仍超 → 走 compressIfNeeded，stage:'summary'、落卡。
 * - user 轮数不足摘要但折叠可做 → 返回折叠所得（stage:'fold'）。
 *
 * mock 模式对齐 compress.test.ts：__setBackendFactoryForTest 替换摘要 backend，
 * 并计数 runOneShot 调用——fold-only 路径必须零调用（无损、不烧钱）。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend } from '@shared/agent/backend';
import type { ChatMessage, ToolCall } from '@shared/types';

if (!process.env.ORU_DIR) {
  process.env.ORU_DIR = mkdtempSync(join(tmpdir(), 'oru-organize-test-'));
}
const { organizeContext, organizeThreshold } = await import(
  '../../electron/main/agent/context/organize'
);
const { __setBackendFactoryForTest } = await import(
  '../../electron/main/agent/backends/factory'
);

const WINDOW = 10_000; // → threshold 5000

let summaryCalls = 0;
function installMockBackend(): void {
  summaryCalls = 0;
  const backend: AgentBackend = {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'mdl_summary',
    providerId: 'prv_summary',
    runConversation: () => {
      throw new Error('not used');
    },
    runOneShot: async () => {
      summaryCalls += 1;
      return { text: '这是压缩摘要' };
    },
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  };
  __setBackendFactoryForTest(async () => backend);
}

function bigTool(id: string, chars: number): ToolCall {
  return {
    id,
    name: 'read_file',
    input: {},
    status: 'completed',
    startedAt: 0,
    finishedAt: 1,
    result: { toolCallId: id, isError: false, summary: 's', detail: 'x'.repeat(chars) },
  };
}
function user(id: string): ChatMessage {
  return { id, conversationId: 'c1', role: 'user', text: 'hi', toolCalls: [], createdAt: 0, done: true };
}
function asst(id: string, tool: ToolCall): ChatMessage {
  return { id, conversationId: 'c1', role: 'assistant', text: '', toolCalls: [tool], createdAt: 0, done: true };
}

describe('organizeThreshold', () => {
  it('= floor(window / 2)', () => {
    expect(organizeThreshold(200_000)).toBe(100_000);
    expect(organizeThreshold(10_001)).toBe(5000);
  });
});

describe('organizeContext', () => {
  it('未到水位且非 force → null', async () => {
    installMockBackend();
    const history = [user('u1'), asst('a1', bigTool('t1', 100)), user('u2')];
    const r = await organizeContext({
      conversationId: 'c1',
      history,
      systemContext: '',
      contextWindow: WINDOW,
    });
    expect(r).toBeNull();
    expect(summaryCalls).toBe(0);
  });

  it('阶段一折叠即达标 → stage:fold，不调摘要 LLM、不落卡、水印落定', async () => {
    installMockBackend();
    // 5 轮，每个 assistant 工具 ~1400 token。未折叠 5×1400=7000 > 5000；
    // 折叠窗=3 → 折掉最老 2 轮工具，剩 3×1400=4200 < 5000 → 停在折叠。
    const history = [
      user('u1'), asst('a1', bigTool('t1', 5000)),
      user('u2'), asst('a2', bigTool('t2', 5000)),
      user('u3'), asst('a3', bigTool('t3', 5000)),
      user('u4'), asst('a4', bigTool('t4', 5000)),
      user('u5'),
    ];
    const r = await organizeContext({
      conversationId: 'c1',
      history,
      systemContext: '',
      contextWindow: WINDOW,
    });
    expect(r).not.toBeNull();
    expect(r!.stage).toBe('fold');
    expect(r!.notificationMessage).toBeUndefined();
    expect(r!.foldedBefore).toBe('u3'); // 折叠窗边界
    expect(summaryCalls).toBe(0); // 无损，绝不调摘要
    // a1/a2 已折成桩，a3/a4 原样
    expect(r!.trimmedHistory[1].toolCalls[0].result?.detail).toContain('已折叠');
    expect(r!.trimmedHistory[5].toolCalls[0].result?.detail).toBe('x'.repeat(5000));
  });

  it('折叠后仍超水位 → 阶段二摘要，stage:summary、落卡、调摘要 LLM', async () => {
    installMockBackend();
    // 7 轮；工具各 ~5600 token（20000 chars）。折叠窗=3 保留最近 3 轮（u5/u6/u7），
    // 其中未折叠工具 a5/a6 = 2×5600 = 11200 > 5000 → 折叠打不住、进摘要。
    const history = [
      user('u1'), asst('a1', bigTool('t1', 20000)),
      user('u2'), asst('a2', bigTool('t2', 20000)),
      user('u3'), asst('a3', bigTool('t3', 20000)),
      user('u4'), asst('a4', bigTool('t4', 20000)),
      user('u5'), asst('a5', bigTool('t5', 20000)),
      user('u6'), asst('a6', bigTool('t6', 20000)),
      user('u7'),
    ];
    const r = await organizeContext({
      conversationId: 'c1',
      history,
      systemContext: '',
      contextWindow: WINDOW,
    });
    expect(r).not.toBeNull();
    expect(r!.stage).toBe('summary');
    expect(r!.notificationMessage).toBeDefined();
    expect(r!.notificationMessage!.kind).toBe('context-compressed');
    expect(summaryCalls).toBeGreaterThanOrEqual(1);
  });

  it('extraTokens（in-flight 产出）把总量推过水位 → 触发整理；不含 extra 则不触发', async () => {
    installMockBackend();
    // 6 轮，工具各 ~1400 token。折叠窗=3 → 折掉最老 3 轮，剩最近 2 个工具 ~2800 < 5000 水位。
    const history = [
      user('u1'), asst('a1', bigTool('t1', 5000)),
      user('u2'), asst('a2', bigTool('t2', 5000)),
      user('u3'), asst('a3', bigTool('t3', 5000)),
      user('u4'), asst('a4', bigTool('t4', 5000)),
      user('u5'), asst('a5', bigTool('t5', 5000)),
      user('u6'),
    ];
    // 不含 extra：折叠后 ~2800 < 5000 → 停在折叠、不进摘要
    const without = await organizeContext({
      conversationId: 'c1', history, systemContext: '', contextWindow: WINDOW,
    });
    expect(without?.stage).not.toBe('summary');
    // 含 in-flight extra（2500 token）：折叠后 2800 + 2500 > 5000 → 折叠打不住、进摘要
    // （threshold−extra=2500 仍 > 摘要预算，compress 递减到能装下）
    const withExtra = await organizeContext({
      conversationId: 'c1', history, systemContext: '', contextWindow: WINDOW, extraTokens: 2500,
    });
    expect(withExtra).not.toBeNull();
    expect(withExtra!.stage).toBe('summary');
  });

  it('历史含单条超水位大消息（compress 会抛 overflow）→ 不抛、返回折叠所得（照发、真撞墙交兜底）', async () => {
    installMockBackend();
    // 6 轮，其中 u3 是超大 user 文本（~7000 token > 5000 水位），无工具回执故折叠不掉；
    // compress 保留 5 轮必含 u3、装不下 → firstN=null 抛 PostCompressOverflowError。
    // organize 应捕获、返回折叠所得（stage:'fold'），不把异常抛给续发检查点炸回合。
    const huge = 'z'.repeat(25000);
    const history = [
      user('u1'), asst('a1', bigTool('t1', 200)),
      user('u2'), asst('a2', bigTool('t2', 200)),
      user('u3'), asst('a3', bigTool('t3', 200)),
      user('u4'), asst('a4', bigTool('t4', 200)),
      user('u5'), asst('a5', bigTool('t5', 200)),
      // 末轮 user 超大（~7000 token > 5000 水位）——compress 恒保末轮、装不下 → firstN=null 抛
      { id: 'u6', conversationId: 'c1', role: 'user' as const, text: huge, toolCalls: [], createdAt: 0, done: true },
    ];
    // 断言：不抛异常
    const r = await organizeContext({
      conversationId: 'c1', history, systemContext: '', contextWindow: WINDOW,
    });
    // 返回折叠所得（stage:'fold'）或 null，绝不抛 PostCompressOverflowError
    if (r !== null) expect(r.stage).toBe('fold');
  });
});

// ─── 整理 → read_file 去重失效（上下文代际）────────────────────────────────
// 现象：模型在会话里打出 "Let me force re-read the file:"，随后 edit_file 连环失配。
// 根因：dedup 的前提「上次读到的内容还在模型上下文里」在压缩/折叠之后不成立，dedup 自己
// 察觉不到——只回一句"参考上次读取的内容"，模型既拿不到内容也没有强制重读的口子。
describe('整理推进上下文代际 → read_file 的 dedup 失效', () => {
  const READ_PATH = '/tmp/oru-organize-dedup-fixture.csv';
  const seedRead = async (convId: string) => {
    const { recordRead } = await import('../../electron/main/agent/conversationFileState');
    recordRead(convId, READ_PATH, { mtime: 111, content: 'a,b\n1,2', isPartialView: false });
  };
  const canSkip = async (convId: string) => {
    const { canSkipReread } = await import('../../electron/main/agent/conversationFileState');
    return canSkipReread(convId, READ_PATH, 111, undefined, undefined);
  };

  it('未触发整理（返回 null）→ 代际不动，dedup 照常生效', async () => {
    installMockBackend();
    await seedRead('c-noop');
    expect(await canSkip('c-noop')).toBe(true);
    const r = await organizeContext({
      conversationId: 'c-noop',
      history: [user('u1'), asst('a1', bigTool('t1', 100)), user('u2')],
      systemContext: '',
      contextWindow: WINDOW,
    });
    expect(r).toBeNull();
    expect(await canSkip('c-noop')).toBe(true);
  });

  it('折叠真折走内容 → 代际 +1，同一次读取不再算"还在上下文里"', async () => {
    installMockBackend();
    await seedRead('c-fold');
    const r = await organizeContext({
      conversationId: 'c-fold',
      history: [
        user('u1'), asst('a1', bigTool('t1', 5000)),
        user('u2'), asst('a2', bigTool('t2', 5000)),
        user('u3'), asst('a3', bigTool('t3', 5000)),
        user('u4'), asst('a4', bigTool('t4', 5000)),
        user('u5'),
      ],
      systemContext: '',
      contextWindow: WINDOW,
    });
    expect(r!.stage).toBe('fold');
    expect(await canSkip('c-fold')).toBe(false);
  });

  it('摘要压掉老消息 → 代际 +1', async () => {
    installMockBackend();
    await seedRead('c-sum');
    const r = await organizeContext({
      conversationId: 'c-sum',
      history: [
        user('u1'), asst('a1', bigTool('t1', 20000)),
        user('u2'), asst('a2', bigTool('t2', 20000)),
        user('u3'), asst('a3', bigTool('t3', 20000)),
        user('u4'), asst('a4', bigTool('t4', 20000)),
        user('u5'), asst('a5', bigTool('t5', 20000)),
        user('u6'), asst('a6', bigTool('t6', 20000)),
        user('u7'),
      ],
      systemContext: '',
      contextWindow: WINDOW,
    });
    expect(r!.stage).toBe('summary');
    expect(await canSkip('c-sum')).toBe(false);
  });

  it('整理之后重新读一遍 → dedup 恢复（记录带上新代际）', async () => {
    installMockBackend();
    await seedRead('c-again');
    await organizeContext({
      conversationId: 'c-again',
      history: [
        user('u1'), asst('a1', bigTool('t1', 5000)),
        user('u2'), asst('a2', bigTool('t2', 5000)),
        user('u3'), asst('a3', bigTool('t3', 5000)),
        user('u4'), asst('a4', bigTool('t4', 5000)),
        user('u5'),
      ],
      systemContext: '',
      contextWindow: WINDOW,
    });
    expect(await canSkip('c-again')).toBe(false);
    await seedRead('c-again');
    expect(await canSkip('c-again')).toBe(true);
  });
});
