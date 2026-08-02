/**
 * adaptEvents —— SDKMessage → EngineEvent 适配。
 *
 * 重点：claude-code 后端的整轮 token 从 result.modelUsage 聚合（修 in0/out0）；
 * 单步 token（per-call）有意不发——是 known limitation（见 2026-06-10 调查）。
 */
import { describe, it, expect } from 'vitest';
import { adaptEvents } from '../../electron/main/engine/claudeAgentSdk';
import type { EngineEvent } from '../../electron/main/engine/types';

// SDKMessage 类型庞大，测试只构造 adaptEvents 实际读取的字段，用 as 喂进去。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function adapt(msgs: any[], streaming = false): Promise<EngineEvent[]> {
  async function* gen() {
    for (const m of msgs) yield m;
  }
  const out: EngineEvent[] = [];
  for await (const e of adaptEvents(gen(), streaming)) out.push(e);
  return out;
}

// stream_event（SDKPartialAssistantMessage）的简写构造器——只填 adaptEvents 读取的字段
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const blockStart = (type: string): any => ({
  type: 'stream_event',
  session_id: 's',
  event: { type: 'content_block_start', index: 0, content_block: { type } },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const blockDelta = (delta: Record<string, unknown>): any => ({
  type: 'stream_event',
  session_id: 's',
  event: { type: 'content_block_delta', index: 0, delta },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const blockStop = (): any => ({
  type: 'stream_event',
  session_id: 's',
  event: { type: 'content_block_stop', index: 0 },
});

// ModelUsage 全字段，测试只关心 token，其余补 0
const mu = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 0,
});

describe('adaptEvents — result 整轮 token（modelUsage 聚合）', () => {
  it('单模型：求和即整轮总量，key 给 actualModel', async () => {
    const evs = await adapt([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        session_id: 's',
        modelUsage: { 'claude-opus-4': mu(300, 120) },
      },
    ]);
    expect(evs.find((e) => e.type === 'result')).toMatchObject({
      type: 'result',
      resultText: 'done',
      usage: { inputTokens: 300, outputTokens: 120, actualModel: 'claude-opus-4' },
    });
  });

  it('多模型：跨模型求和，actualModel 留空', async () => {
    const evs = await adapt([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        session_id: 's',
        modelUsage: { a: mu(100, 40), b: mu(200, 80) },
      },
    ]);
    const res = evs.find((e) => e.type === 'result') as Extract<EngineEvent, { type: 'result' }>;
    expect(res.usage).toEqual({ inputTokens: 300, outputTokens: 120, actualModel: undefined });
  });

  it('assistant message 不发 per-call llm_usage（claude-code 单步 token 是 known limitation）', async () => {
    const evs = await adapt([
      {
        type: 'assistant',
        session_id: 's',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);
    expect(evs).toContainEqual({ type: 'assistant_text', text: 'hi' });
    expect(evs.some((e) => e.type === 'llm_usage')).toBe(false);
  });
});
