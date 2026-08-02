/**
 * 换行单元格值 roundtrip 回归（Task 4 承重）——
 * 多行编辑（textarea + Shift+Enter）提交的值可能含 \n / \r\n / 引号，落盘经 serializeCsv
 * 裹引号转义、读回经 parseCsv 还原，必须严格等于原值，否则多行编辑的持久化就是坏的。
 *
 * serializeField 已对含 \n/\r/"/, 的值裹引号并把 " 转义为 ""；本测试钉住这条链路不回退。
 */
import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv } from '@shared/csv';

/** 把一个单表格值放进 headers+rows 走完整 serialize→parse，取回同一格。 */
function roundtripCell(value: string): string {
  const text = serializeCsv({ headers: ['h'], rows: [[value]] });
  const parsed = parseCsv(text);
  return parsed.rows[0]![0]!;
}

describe('换行单元格值 serializeCsv/parseCsv roundtrip', () => {
  it('值含 \\n：多行文本落盘读回不变', () => {
    const value = '第一行\n第二行';
    expect(roundtripCell(value)).toBe(value);
  });

  it('值含 \\r\\n：CRLF 段落落盘读回不变', () => {
    const value = '甲\r\n乙\r\n丙';
    expect(roundtripCell(value)).toBe(value);
  });

  it('值含 " 与 \\n 混合：双重转义（裹引号 + " → ""）后仍还原', () => {
    const value = '说 "hi"\n下一行 "bye"';
    expect(roundtripCell(value)).toBe(value);
  });

  it('值以换行开头/结尾：首尾换行不被吞', () => {
    const value = '\n中间\n';
    expect(roundtripCell(value)).toBe(value);
  });

  it('纯换行值：仅一个 \\n 也完整保留', () => {
    expect(roundtripCell('\n')).toBe('\n');
  });

  it('落盘文本确实裹了引号（含 \\n 的值不能裸写，否则会被当成换行分隔）', () => {
    const text = serializeCsv({ headers: ['h'], rows: [['两\n行']] });
    expect(text).toBe('h\n"两\n行"\n');
  });
});
