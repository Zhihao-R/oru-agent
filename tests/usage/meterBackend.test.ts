/**
 * 用量计量代理单测（S13 · G110）——包 getBackendFor 返回的后端，观测 result / oneShot 的 usage
 * 按用途落账，事件原样透传，无 usage 不落账。走真账本（ORU_DIR 隔离）验端到端。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentBackend,
  ConversationEvent,
  ConversationHandle,
  OneShotResult,
} from '../../shared/agent/backend';

const ORU_DIR = join(tmpdir(), `oru-test-meter-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const OWNER = 'local-user';

let meterBackend!: typeof import('../../electron/main/agent/backends/meterBackend').meterBackend;
let L!: typeof import('../../electron/main/usage/ledger');

/** 造一个吐固定事件流 + oneShot 的假后端；events 记录被消费的次序供透传校验。 */
function fakeBackend(events: ConversationEvent[], oneShot?: OneShotResult): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic',
    modelId: 'test-model',
    providerId: 'test',
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: '' }),
    runConversation: (): ConversationHandle => ({
      events: (async function* () {
        for (const ev of events) yield ev;
      })(),
    }),
    runOneShot: async () => oneShot ?? { text: '' },
  };
}

async function drain(handle: ConversationHandle): Promise<ConversationEvent[]> {
  const out: ConversationEvent[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}

beforeAll(async () => {
  await fs.mkdir(join(ORU_DIR, 'users', OWNER), { recursive: true });
  ({ meterBackend } = await import('../../electron/main/agent/backends/meterBackend'));
  L = await import('../../electron/main/usage/ledger');
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(() => L.__resetUsageLedgerForTest());

describe('meterBackend', () => {
  it('runConversation 的 result.usage 按用途落账，事件原样透传', async () => {
    const events: ConversationEvent[] = [
      { type: 'assistant_text', text: 'hi' },
      { type: 'result', resultText: 'hi', isError: false, usage: { inputTokens: 200, outputTokens: 40 } },
    ];
    const metered = meterBackend(fakeBackend(events), 'twinMain');
    const seen = await drain(metered.runConversation({} as never));
    // 事件逐条透传，不增不减不改
    expect(seen).toEqual(events);

    // 落账 fire-and-forget，给微任务落定
    await new Promise((r) => setTimeout(r, 0));
    const days = await L.getUsageDays(OWNER);
    const { summarizeUsage } = await import('../../shared/usage/summarize');
    const sum = summarizeUsage(days, {});
    expect(sum.byPurpose).toEqual([
      { purpose: 'twinMain', inputTokens: 200, outputTokens: 40, calls: 1 },
    ]);
  });

  it('runOneShot 的 usage 按用途落账', async () => {
    const metered = meterBackend(
      fakeBackend([], { text: 'ok', usage: { inputTokens: 12, outputTokens: 3 } }),
      'memoryRecall',
    );
    const res = await metered.runOneShot({ prompt: 'x' });
    expect(res.text).toBe('ok');
    await new Promise((r) => setTimeout(r, 0));
    const days = await L.getUsageDays(OWNER);
    const { summarizeUsage } = await import('../../shared/usage/summarize');
    expect(summarizeUsage(days, {}).byPurpose[0]).toMatchObject({ purpose: 'memoryRecall', inputTokens: 12 });
  });

  it('无 usage 不落账（中止 / backend 没拿到用量）', async () => {
    const events: ConversationEvent[] = [
      { type: 'result', resultText: null, isError: false }, // 无 usage 字段
    ];
    const metered = meterBackend(fakeBackend(events), 'twinMain');
    await drain(metered.runConversation({} as never));
    await new Promise((r) => setTimeout(r, 0));
    const days = await L.getUsageDays(OWNER);
    const { summarizeUsage } = await import('../../shared/usage/summarize');
    expect(summarizeUsage(days, {}).total.calls).toBe(0);
  });
});
