import { describe, it, expect } from 'vitest';
import type { ChecklistItem, ChecklistEdit } from '@shared/types';
import { applyChecklistEdit } from '../../electron/main/loop/checklistEdit';

function item(over: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return {
    id: over.id,
    statement: over.statement ?? `项 ${over.id}`,
    status: over.status ?? 'pending',
    verdict: over.verdict,
  };
}

const ctx = { newId: () => 'new1' };

describe('applyChecklistEdit · add', () => {
  it('加一项：新 id、pending', () => {
    const edit: ChecklistEdit = { op: 'add', item: { statement: '参考文献格式统一' } };
    const out = applyChecklistEdit([item({ id: 'a' })], edit, ctx);
    expect(out).toHaveLength(2);
    expect(out.find((it) => it.id === 'new1')).toMatchObject({ statement: '参考文献格式统一', status: 'pending' });
  });
});

describe('applyChecklistEdit · remove', () => {
  it('划掉一项', () => {
    const out = applyChecklistEdit([item({ id: 'a' }), item({ id: 'b' })], { op: 'remove', id: 'a' }, ctx);
    expect(out.map((it) => it.id)).toEqual(['b']);
  });
});

describe('applyChecklistEdit · revise', () => {
  it('改标准 → 原 satisfied 项解锁回 pending、清 verdict', () => {
    const before = [item({ id: 'a', status: 'satisfied', verdict: { reason: '旧' } })];
    const out = applyChecklistEdit(before, { op: 'revise', id: 'a', statement: '新标准' }, ctx);
    expect(out.find((it) => it.id === 'a')).toMatchObject({ statement: '新标准', status: 'pending' });
    expect(out.find((it) => it.id === 'a')?.verdict).toBeUndefined();
  });

  it('改不存在的 id → 原样返回（幂等、不抛）', () => {
    const before = [item({ id: 'a' })];
    const out = applyChecklistEdit(before, { op: 'revise', id: 'zzz', statement: 'x' }, ctx);
    expect(out.map((it) => it.id)).toEqual(['a']);
  });
});
