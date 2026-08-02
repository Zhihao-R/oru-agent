import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChecklistEdit } from '@shared/types';
import {
  registerLoop,
  unregisterLoop,
  stopLoop,
  editLoopChecklist,
  isLoopActive,
  type LoopControl,
} from '../../electron/main/loop/registry';

function makeControl(loopId: string): {
  control: LoopControl;
  stop: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn();
  const edit = vi.fn();
  return {
    control: { loopId, conversationId: 'conv', stop, requestChecklistEdit: edit },
    stop,
    edit,
  };
}

beforeEach(() => {
  ['l1', 'l2'].forEach(unregisterLoop);
});

describe('loop registry（控制句柄）', () => {
  it('注册后 isLoopActive、stopLoop 命中并触发 stop', () => {
    const { control, stop } = makeControl('l1');
    registerLoop(control);
    expect(isLoopActive('l1')).toBe(true);
    expect(stopLoop('l1')).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('停不存在的 loopId → false，不抛', () => {
    expect(stopLoop('nope')).toBe(false);
  });

  it('editLoopChecklist 路由到对应回调', () => {
    const { control, edit } = makeControl('l1');
    registerLoop(control);
    const e: ChecklistEdit = { op: 'remove', id: 'x' };
    expect(editLoopChecklist('l1', e)).toBe(true);
    expect(edit).toHaveBeenCalledWith(e);
  });

  it('未命中的 edit → false', () => {
    expect(editLoopChecklist('nope', { op: 'remove', id: 'x' })).toBe(false);
  });

  it('unregisterLoop 后不再命中（收敛/中止 finally 清理）', () => {
    const { control } = makeControl('l1');
    registerLoop(control);
    unregisterLoop('l1');
    expect(isLoopActive('l1')).toBe(false);
    expect(stopLoop('l1')).toBe(false);
  });
});
