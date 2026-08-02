import { describe, it, expect } from 'vitest';
import type { ChecklistItem } from '@shared/types';
import {
  buildReviewPrompt,
  parseReviewOutput,
  truncateTranscript,
  type ReviewTranscriptTurn,
} from '../../electron/main/loop/reviewer';

function item(over: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return {
    id: over.id,
    statement: over.statement ?? `项 ${over.id}`,
    status: over.status ?? 'pending',
    verdict: over.verdict,
  };
}

function turn(round: number, text: string, tools: { name: string; detail: string }[] = []): ReviewTranscriptTurn {
  return { round, text, toolCalls: tools };
}

describe('truncateTranscript · 超窗截断', () => {
  it('未超预算 → 原样返回、不标压缩', () => {
    const turns = [turn(1, 'a', [{ name: 'read_file', detail: 'x'.repeat(50) }]), turn(2, 'b')];
    const out = truncateTranscript(turns, 10_000);
    expect(out.compressed).toBe(false);
    expect(out.turns).toEqual(turns);
  });

  it('超预算 → 从最旧轮先掐工具 detail（留调用名与摘要），最近两轮永远全量', () => {
    const long = 'z'.repeat(200);
    const turns = [
      turn(1, 'r1', [{ name: 'read_file', detail: long }]),
      turn(2, 'r2', [{ name: 'grep', detail: long }]),
      turn(3, 'r3', [{ name: 'edit', detail: long }]),
      turn(4, 'r4', []),
    ];
    const out = truncateTranscript(turns, 500);
    expect(out.compressed).toBe(true);
    expect(out.turns[0].toolCalls[0].name).toBe('read_file');
    expect(out.turns[0].toolCalls[0].detail.length).toBeLessThan(long.length);
    // 最近两轮（r3/r4）全量：r3 的 detail 原样
    expect(out.turns[2].toolCalls[0].detail).toBe(long);
  });

  it('极窄预算 → 旧轮整轮降为主 agent 文本（丢工具调用），最近两轮仍全量', () => {
    const long = 'z'.repeat(200);
    const turns = [
      turn(1, 'r1', [{ name: 'read_file', detail: long }]),
      turn(2, 'r2', [{ name: 'grep', detail: long }]),
      turn(3, 'r3', [{ name: 'edit', detail: long }]),
      turn(4, 'r4', [{ name: 'edit', detail: long }]),
    ];
    const out = truncateTranscript(turns, 250);
    expect(out.compressed).toBe(true);
    expect(out.turns[0].toolCalls).toEqual([]);
    expect(out.turns[0].text).toBe('r1');
    // 最近两轮永远全量
    expect(out.turns[3].toolCalls[0].detail).toBe(long);
  });
});

describe('buildReviewPrompt · 读对话记录盲判', () => {
  const checklist = [item({ id: 'c1', statement: '有第三节案例' }), item({ id: 'c2', statement: '总结呼应开篇' })];
  const transcript = [turn(1, '我建了 report.md', [{ name: 'write_file', detail: '写入 report.md 完成' }])];

  it('含逐项验收标准（id + statement）与对话记录', () => {
    const p = buildReviewPrompt(checklist, transcript, false);
    expect(p).toContain('c1');
    expect(p).toContain('有第三节案例');
    expect(p).toContain('report.md');
  });

  it('含三条铁律：时间序覆盖 / 只认摊出的证据 / 证据不足判 pending', () => {
    const p = buildReviewPrompt(checklist, transcript, false);
    expect(p).toMatch(/时间序|后面.*覆盖|覆盖.*前面/);
    expect(p).toMatch(/口头|宣称|摊|证据/);
    expect(p).toMatch(/pending/);
  });

  it('压缩发生时 prompt 如实声明更早轮次已压缩', () => {
    expect(buildReviewPrompt(checklist, transcript, true)).toMatch(/压缩|更早/);
    expect(buildReviewPrompt(checklist, transcript, false)).not.toMatch(/更早轮次已压缩/);
  });
});

describe('parseReviewOutput · 逐项 verdict 容错', () => {
  const checklist = [item({ id: 'c1' }), item({ id: 'c2' })];

  it('satisfied / pending 逐项合并 + 理由', () => {
    const raw = JSON.stringify({
      verdicts: [
        { id: 'c1', verdict: 'satisfied', reason: '有证据' },
        { id: 'c2', verdict: 'pending', reason: '缺 X' },
      ],
    });
    const out = parseReviewOutput(raw, checklist);
    expect(out.find((i) => i.id === 'c1')).toMatchObject({ status: 'satisfied', verdict: { reason: '有证据' } });
    expect(out.find((i) => i.id === 'c2')).toMatchObject({ status: 'pending', verdict: { reason: '缺 X' } });
  });

  it('漏判的项 → pending（不冒充满足）', () => {
    const raw = JSON.stringify({ verdicts: [{ id: 'c1', verdict: 'satisfied', reason: 'ok' }] });
    const out = parseReviewOutput(raw, checklist);
    expect(out.find((i) => i.id === 'c2')?.status).toBe('pending');
  });

  it('未知 verdict 值 → pending（无 uncertain 出口）', () => {
    const raw = JSON.stringify({ verdicts: [{ id: 'c1', verdict: 'uncertain', reason: '?' }] });
    const out = parseReviewOutput(raw, checklist);
    expect(out.find((i) => i.id === 'c1')?.status).toBe('pending');
  });

  it('整段坏 JSON → 全部 pending，不抛', () => {
    const out = parseReviewOutput('这不是 JSON', checklist);
    expect(out.every((i) => i.status === 'pending')).toBe(true);
  });

  it('satisfied 项无理由时不带 verdict', () => {
    const raw = JSON.stringify({ verdicts: [{ id: 'c1', verdict: 'satisfied', reason: '' }] });
    const out = parseReviewOutput(raw, checklist);
    expect(out.find((i) => i.id === 'c1')).toMatchObject({ status: 'satisfied' });
    expect(out.find((i) => i.id === 'c1')?.verdict).toBeUndefined();
  });
});
