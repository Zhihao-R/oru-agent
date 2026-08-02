/**
 * G54 会话污染检测（backend 事件层）。
 *
 * detectSessionPoison 三条件一次判齐：resume 在用 + 本回合未产出 assistant + result isError 且文案
 * 匹配毒化模式 → 抛 SessionPoisonError（不 yield 该 result，避免被 stream 兜底成 delta）。
 * fail-closed 三面：已产出 assistant / 非 resume / 文案不匹配 → 照常 yield，普通报错不被吞。
 */
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../electron/main/engine/types';
import { detectSessionPoison } from '../../electron/main/agent/backends/claudeCode';
import {
  SessionPoisonError,
  isSessionPoisonText,
} from '../../electron/main/agent/backends/sessionPoison';

async function* stream(...evs: EngineEvent[]): AsyncGenerator<EngineEvent> {
  for (const e of evs) yield e;
}
async function drain(gen: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const poisonResult: EngineEvent = {
  type: 'result',
  resultText: 'API Error: text content blocks must be non-empty',
  isError: true,
};

describe('isSessionPoisonText', () => {
  it('命中空文本块 / 工具配对错误模式', () => {
    // 两条空块文案均为 2026-07-01 飞书事故实测浮出（docs/tech/2026-07-02-feishu-*）
    expect(isSessionPoisonText('API Error: 400 text content blocks must be non-empty')).toBe(true);
    expect(isSessionPoisonText('API Error: 400 cache_control cannot be set for empty text blocks')).toBe(true);
    expect(isSessionPoisonText('tool_use ids were found without tool_result blocks')).toBe(true);
  });
  it('fail-closed：普通报错不匹配', () => {
    expect(isSessionPoisonText('rate limit exceeded')).toBe(false);
    expect(isSessionPoisonText('')).toBe(false);
  });
});

describe('detectSessionPoison', () => {
  it('resume 在用 + 未产出 assistant + 毒化 result → 抛 SessionPoisonError', async () => {
    await expect(drain(detectSessionPoison(stream(poisonResult), true))).rejects.toBeInstanceOf(
      SessionPoisonError,
    );
  });

  it('fail-closed：非 resume → 照常浮出 result', async () => {
    const out = await drain(detectSessionPoison(stream(poisonResult), false));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('result');
  });

  it('fail-closed：已产出 assistant 内容 → 是中途错误、不当污染', async () => {
    const out = await drain(
      detectSessionPoison(stream({ type: 'assistant_text', text: '干活中' }, poisonResult), true),
    );
    expect(out).toHaveLength(2);
  });

  it('fail-closed：文案不匹配毒化模式 → 照常浮出', async () => {
    const benign: EngineEvent = { type: 'result', resultText: 'rate limit exceeded', isError: true };
    const out = await drain(detectSessionPoison(stream(benign), true));
    expect(out).toHaveLength(1);
  });

  it('工具调用也算本回合有产出（不当污染）', async () => {
    const out = await drain(
      detectSessionPoison(
        stream({ type: 'tool_use', id: 't1', name: 'bash', input: {} }, poisonResult),
        true,
      ),
    );
    expect(out).toHaveLength(2);
  });
});
