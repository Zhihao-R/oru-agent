/**
 * 系统信号注册表单测（S14 · G106/G127）——去重、广播节流、忽略/自愈、排序。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemSignalsEvent } from '../../shared/protocol';
import {
  raiseSystemSignal,
  clearSystemSignal,
  dismissSystemSignal,
  listSystemSignals,
  setSystemSignalBroadcaster,
  __resetSystemSignalsForTest,
} from '../../electron/main/notifications/systemSignals';

let broadcasts: SystemSignalsEvent[] = [];

beforeEach(() => {
  __resetSystemSignalsForTest();
  broadcasts = [];
  setSystemSignalBroadcaster((ev) => broadcasts.push(ev));
});

describe('raise / clear', () => {
  it('升起即入场并广播；同 id 同内容复发不重复广播', () => {
    raiseSystemSignal({ id: 'channel-offline:feishu', kind: 'channel-offline', severity: 'warning', params: { platform: 'feishu' } });
    expect(listSystemSignals().map((s) => s.id)).toEqual(['channel-offline:feishu']);
    expect(broadcasts).toHaveLength(1);

    raiseSystemSignal({ id: 'channel-offline:feishu', kind: 'channel-offline', severity: 'warning', params: { platform: 'feishu' } });
    expect(broadcasts).toHaveLength(1); // 内容等价，不刷屏
  });

  it('同 id 内容变化（detail 变）才重新广播', () => {
    raiseSystemSignal({ id: 'write-failed', kind: 'write-failed', severity: 'critical', detail: 'a.json: ENOSPC' });
    raiseSystemSignal({ id: 'write-failed', kind: 'write-failed', severity: 'critical', detail: 'b.json: ENOSPC' });
    expect(broadcasts).toHaveLength(2);
  });

  it('createdAt 复发不刷新（保持问题起点）', () => {
    raiseSystemSignal({ id: 'x', kind: 'scheduler-stalled', severity: 'warning', createdAt: 1000 });
    raiseSystemSignal({ id: 'x', kind: 'scheduler-stalled', severity: 'warning', detail: '变了', createdAt: 9999 });
    expect(listSystemSignals()[0].createdAt).toBe(1000);
  });

  it('clear 移除并广播', () => {
    raiseSystemSignal({ id: 'x', kind: 'scheduler-stalled', severity: 'warning' });
    broadcasts = [];
    clearSystemSignal('x');
    expect(listSystemSignals()).toEqual([]);
    expect(broadcasts).toHaveLength(1);
  });
});

describe('忽略 / 自愈', () => {
  it('忽略后从列表隐藏；同 id 再 raise 不复现；clear 自愈后重置、再 raise 才复现', () => {
    raiseSystemSignal({ id: 'storage-corruption:idx', kind: 'storage-corruption', severity: 'critical' });
    dismissSystemSignal('storage-corruption:idx');
    expect(listSystemSignals()).toEqual([]); // 已隐藏

    raiseSystemSignal({ id: 'storage-corruption:idx', kind: 'storage-corruption', severity: 'critical', detail: '又坏' });
    expect(listSystemSignals()).toEqual([]); // 忽略期不复现

    clearSystemSignal('storage-corruption:idx'); // 自愈：重置忽略
    raiseSystemSignal({ id: 'storage-corruption:idx', kind: 'storage-corruption', severity: 'critical' });
    expect(listSystemSignals().map((s) => s.id)).toEqual(['storage-corruption:idx']); // 新事件重新提示
  });
});

describe('排序', () => {
  it('critical 先于 warning，同级按时间', () => {
    raiseSystemSignal({ id: 'w', kind: 'channel-offline', severity: 'warning', createdAt: 1 });
    raiseSystemSignal({ id: 'c', kind: 'storage-corruption', severity: 'critical', createdAt: 2 });
    expect(listSystemSignals().map((s) => s.id)).toEqual(['c', 'w']);
  });
});
