/**
 * listSessions 关键不变量：按 round_start / round_done 切分多 RoundSummary。
 *
 * 只测纯函数 parseRoundsFromText（不读 fs）。
 */
import { describe, it, expect } from 'vitest';
import { parseRoundsFromText } from '../../electron/main/debug/listSessions';
import type { DebugRecord } from '../../shared/debug/types';

function ndjson(records: DebugRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

function rec<T extends DebugRecord['type']>(
  type: T,
  roundId: string,
  ts: number,
  payload: Record<string, unknown>,
  seq: number,
): DebugRecord {
  return {
    ts,
    relMs: 0,
    roundId,
    conversationId: 'c1',
    ownerId: 'o',
    agentId: 'a',
    agentName: 'A',
    type,
    seq,
    payload: payload as never,
  } as DebugRecord;
}

describe('parseRoundsFromText — round 粒度切分', () => {
  it('一个文件多轮 round_start 切成多条 RoundSummary', () => {
    const text = ndjson([
      rec('round_start', 'r1', 1000, { source: 'main_chat', userText: '问 1' }, 0),
      rec('round_done', 'r1', 1500, {
        totalDurationMs: 500,
        llmCallCount: 1,
        toolCallCount: 0,
        hadError: false,
      }, 1),
      rec('round_start', 'r2', 2000, { source: 'main_chat', userText: '问 2' }, 0),
      rec('round_done', 'r2', 3000, {
        totalDurationMs: 1000,
        llmCallCount: 2,
        toolCallCount: 3,
        hadError: false,
        totalInputTokens: 1234,
        totalOutputTokens: 56,
        finalModel: 'glm-5.1',
      }, 1),
    ]);
    const rounds = parseRoundsFromText('2026-05-10', 'c1', text, 99_999);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].roundId).toBe('r1');
    expect(rounds[0].userText).toBe('问 1');
    expect(rounds[0].durationMs).toBe(500);
    expect(rounds[1].roundId).toBe('r2');
    expect(rounds[1].durationMs).toBe(1000);
    expect(rounds[1].hadError).toBe(false);
    expect(rounds[1].fileMtimeMs).toBe(99_999);
  });

  it('未收 round_done 的轮也作为独立条目入列表（durationMs / hadError 留 undefined）', () => {
    const text = ndjson([
      rec('round_start', 'r1', 1000, { source: 'main_chat', userText: '半轮' }, 0),
      // 没 round_done — 模拟 kill -9
    ]);
    const rounds = parseRoundsFromText('2026-05-10', 'c1', text, 99_999);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].durationMs).toBeUndefined();
    expect(rounds[0].hadError).toBeUndefined();
  });

  it('error event 把 message 写到 errorMessage', () => {
    const text = ndjson([
      rec('round_start', 'r1', 1000, { source: 'main_chat', userText: 'x' }, 0),
      rec('error', 'r1', 1100, { message: 'rate_limit_exceeded', phase: 'llm' }, 1),
      rec('round_done', 'r1', 1200, {
        totalDurationMs: 200,
        llmCallCount: 0,
        toolCallCount: 0,
        hadError: true,
      }, 2),
    ]);
    const rounds = parseRoundsFromText('2026-05-10', 'c1', text, 0);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].errorMessage).toBe('rate_limit_exceeded');
    expect(rounds[0].hadError).toBe(true);
  });

  it('坏行（截断 / 半行 JSON）跳过，仍能切出剩余轮次', () => {
    const goodLines = [
      JSON.stringify(rec('round_start', 'r1', 1000, { source: 'main_chat', userText: '正常' }, 0)),
      JSON.stringify(rec('round_done', 'r1', 1100, {
        totalDurationMs: 100, llmCallCount: 0, toolCallCount: 0, hadError: false,
      }, 1)),
    ];
    const text = goodLines.join('\n') + '\n{ "ts": 9999, "type": "round_st'; // 截断半行
    const rounds = parseRoundsFromText('2026-05-10', 'c1', text, 0);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].roundId).toBe('r1');
  });

  it('嵌套轮（主轮进行中插入 compress 子轮）各自正确收束，主轮 round_done 不被吞', () => {
    const text = ndjson([
      rec('round_start', 'main', 1000, { source: 'main_chat', userText: '主轮提问' }, 0),
      // 主轮中途触发压缩——同 conversationId 落同一文件
      rec('round_start', 'cmp', 1100, { source: 'compress', userText: '压缩 prompt' }, 0),
      rec('round_done', 'cmp', 1300, {
        totalDurationMs: 200, llmCallCount: 1, toolCallCount: 0, hadError: false,
      }, 1),
      rec('error', 'main', 1400, { message: 'main_failed', phase: 'llm' }, 1),
      rec('round_done', 'main', 1500, {
        totalDurationMs: 500, llmCallCount: 1, toolCallCount: 0, hadError: true,
      }, 2),
    ]);
    const rounds = parseRoundsFromText('2026-05-10', 'c1', text, 0);
    expect(rounds).toHaveLength(2);
    const main = rounds.find((r) => r.roundId === 'main')!;
    expect(main.durationMs).toBe(500);
    expect(main.hadError).toBe(true);
    expect(main.errorMessage).toBe('main_failed');
    const cmp = rounds.find((r) => r.roundId === 'cmp')!;
    expect(cmp.durationMs).toBe(200);
    expect(cmp.hadError).toBe(false);
  });

  it('交错并行轮（subagent 与主轮同文件）round_done / error 按 roundId 归属，不张冠李戴', () => {
    const text = ndjson([
      rec('round_start', 'a', 1000, { source: 'main_chat', userText: 'A' }, 0),
      rec('round_start', 'b', 1010, { source: 'subagent', userText: 'B' }, 0),
      rec('error', 'b', 1100, { message: 'b_error', phase: 'llm' }, 1),
      rec('round_done', 'a', 1200, {
        totalDurationMs: 200, llmCallCount: 1, toolCallCount: 0, hadError: false,
      }, 1),
      rec('round_done', 'b', 1300, {
        totalDurationMs: 290, llmCallCount: 1, toolCallCount: 0, hadError: true,
      }, 2),
    ]);
    const rounds = parseRoundsFromText('2026-05-10', 'c1', text, 0);
    expect(rounds).toHaveLength(2);
    const a = rounds.find((r) => r.roundId === 'a')!;
    expect(a.durationMs).toBe(200);
    expect(a.hadError).toBe(false);
    expect(a.errorMessage).toBeUndefined();
    const b = rounds.find((r) => r.roundId === 'b')!;
    expect(b.durationMs).toBe(290);
    expect(b.hadError).toBe(true);
    expect(b.errorMessage).toBe('b_error');
  });

  it('超长 userText 截断成列表预览（全文走 debug:read 详情页）', () => {
    const long = 'x'.repeat(5000);
    const text = ndjson([
      rec('round_start', 'r1', 1000, { source: 'compress', userText: long }, 0),
      rec('round_start', 'r2', 2000, { source: 'main_chat', userText: '短文本' }, 0),
      // 截断点落在 emoji（代理对）上不劈裂——按码点截
      rec('round_start', 'r3', 3000, { source: 'compress', userText: 'x'.repeat(199) + '😀😀' }, 0),
    ]);
    const rounds = parseRoundsFromText('2026-05-10', 'c1', text, 0);
    expect(rounds[0].userText).toBe('x'.repeat(200) + '…');
    expect(rounds[1].userText).toBe('短文本');
    expect(rounds[2].userText).toBe('x'.repeat(199) + '😀…');
  });

  it('source 跨多种值都能识别', () => {
    const sources = ['main_chat', 'comment', 'taskboard', 'background'] as const;
    const text = ndjson(
      sources.flatMap((s, i) => [
        rec('round_start', `r${i}`, 1000 + i, { source: s, userText: 'x' }, 0),
        rec('round_done', `r${i}`, 1500 + i, {
          totalDurationMs: 500, llmCallCount: 0, toolCallCount: 0, hadError: false,
        }, 1),
      ]),
    );
    const rounds = parseRoundsFromText('2026-05-10', 'c1', text, 0);
    expect(rounds.map((r) => r.source)).toEqual(sources);
  });
});
