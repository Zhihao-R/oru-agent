/**
 * instrumentOneShot / RoundLogger oneShot 路径的落盘回归。
 *
 * 对抗审查发现该路径曾零覆盖（既有 debug 测试只盖 deriver / 列表 / 静态闸门）——
 * 这里读真实落盘的 ndjson 逐字段断言三条路径：
 *   1. 成功：round_start → prompt_built → llm_call_start → llm_call_done(带 usage) → final_answer → round_done(计数 1)
 *   2. 抛错：error 后由 done() 补 llm_call_done 收口，round_done 计数仍如实为 1
 *   3. 关闭态：NoOp，零落盘
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, globSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DebugRecord } from '../../shared/debug/types';

const tmp = mkdtempSync(join(tmpdir(), 'oru-oneshot-debug-'));
process.env.ORU_DIR = tmp;

// runtime/paths.ts 在模块加载时固化 ORU_DIR——必须先设环境变量再动态 import
const { debugLogger } = await import('../../electron/main/debug/logger');
const { instrumentOneShot } = await import('../../electron/main/debug/instrument');

const BACKEND = { backendType: 'openai-compatible' as const, modelId: 'm1', providerId: 'p1' };

function meta(roundId: string, conversationId: string) {
  return { roundId, conversationId, ownerId: 'owner1', source: 'compress' as const, userText: '测试输入' };
}

function readRecords(conversationId: string): DebugRecord[] {
  const files = globSync(join(tmp, '**', `conversation-${conversationId}.ndjson`));
  expect(files).toHaveLength(1);
  return readFileSync(files[0], 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as DebugRecord);
}

afterAll(() => {
  debugLogger.setEnabled(false);
  rmSync(tmp, { recursive: true, force: true });
});

describe('instrumentOneShot 落盘', () => {
  it('成功路径：三条 LLM 记录齐全，usage 进 llm_call_done，round_done 计数 1', async () => {
    debugLogger.setEnabled(true);
    const text = await instrumentOneShot(
      BACKEND,
      meta('r-ok', 'conv-ok'),
      async () => ({
        text: '答案全文',
        usage: {
          inputTokens: 123,
          outputTokens: 45,
          actualModel: 'm-actual',
          // cacheReadTokens 故意给 0：三态语义里 0 = "真未命中"，必须保留而非被丢弃
          extended: { cacheReadTokens: 0, reasoningTokens: 7 },
        },
      }),
      'SYS',
    );
    expect(text).toBe('答案全文');
    await debugLogger.flushForTest();

    const recs = readRecords('conv-ok');
    expect(recs.map((r) => r.type)).toEqual([
      'round_start',
      'prompt_built',
      'llm_call_start',
      'llm_call_done',
      'final_answer',
      'round_done',
    ]);
    // seq 严格递增
    expect(recs.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);

    const start = recs[2].payload as Record<string, unknown>;
    expect(start).toMatchObject({ callIndex: 1, model: 'm1', providerId: 'p1', backendType: 'openai-compatible' });

    const done = recs[3].payload as Record<string, unknown>;
    expect(done).toMatchObject({
      callIndex: 1,
      outputText: '答案全文',
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 0,
      reasoningTokens: 7,
    });
    // oneShot 一次性返回，没有"首 token"概念——字段必须缺席而非 0
    expect('firstTokenMs' in done).toBe(false);
    // llm_call_start 在 run() 前落盘
    expect(recs[2].ts).toBeLessThanOrEqual(recs[3].ts);

    expect(recs[4].payload).toMatchObject({
      text: '答案全文',
      aborted: false,
      totalInputTokens: 123,
      totalOutputTokens: 45,
      finalModel: 'm-actual',
    });
    expect(recs[5].payload).toMatchObject({
      llmCallCount: 1,
      toolCallCount: 0,
      hadError: false,
      totalInputTokens: 123,
      totalOutputTokens: 45,
      finalModel: 'm-actual',
    });
  });

  it('抛错路径：error 后补 llm_call_done 收口，round_done 计数如实为 1', async () => {
    debugLogger.setEnabled(true);
    await expect(
      instrumentOneShot(BACKEND, meta('r-err', 'conv-err'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await debugLogger.flushForTest();

    const recs = readRecords('conv-err');
    expect(recs.map((r) => r.type)).toEqual([
      'round_start',
      'llm_call_start',
      'error',
      'llm_call_done',
      'round_done',
    ]);
    expect(recs[2].payload).toMatchObject({ message: 'boom', phase: 'llm' });
    const done = recs[3].payload as Record<string, unknown>;
    expect(done).toMatchObject({ callIndex: 1, outputText: '' });
    expect('inputTokens' in done).toBe(false); // 抛错拿不到 usage，留空
    expect(recs[4].payload).toMatchObject({ llmCallCount: 1, hadError: true });
  });

  it('关闭态：NoOp 路径正常返回且零落盘', async () => {
    debugLogger.setEnabled(false);
    const text = await instrumentOneShot(BACKEND, meta('r-off', 'conv-off'), async () => ({ text: '直通' }));
    expect(text).toBe('直通');
    expect(globSync(join(tmp, '**', 'conversation-conv-off.ndjson'))).toHaveLength(0);
  });
});
