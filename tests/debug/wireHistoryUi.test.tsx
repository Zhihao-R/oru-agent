/**
 * v0.5 wireHistory UI 入口可达性测试
 *
 * Reviewer 上一轮 C1 暴露了"代码加了 InferenceViewDetail.tsx 但前端时间线没接入"的问题。
 * 这份测试守住三个可达性环节，让"开应用手动验"之外的代码层有自动化兜底：
 *
 * 1. buildTimelineModel：inference_view 事件被识别为顶层节点（displayType='inference_view'）
 * 2. EventRow renderCells：inference_view 节点渲染出"真实入参"名字 + Eye 图标 + savings summary
 * 3. getWireHistoryDisplay：三态判定（present / resume / legacy）正确
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { DebugRecord } from '@shared/debug/types';
import type { NormalizedMessage } from '@shared/agent/normalizedMessage';
import { buildTimelineModel } from '@/lib/buildTimelineModel';
import { EventRow } from '@/components/debug/EventRow';
import { getWireHistoryDisplay } from '@/lib/debug/wireHistory';

afterEach(() => cleanup());

function mkRoundStart(seq = 0): DebugRecord<'round_start'> {
  return {
    ts: 0,
    relMs: 0,
    roundId: 'r1',
    conversationId: 'c1',
    ownerId: 'o',
    agentId: 'a',
    agentName: 'Twin',
    type: 'round_start',
    seq,
    payload: { source: 'main_chat', userText: 'hi' },
  };
}

function mkInferenceView(opts: {
  seq?: number;
  enabled?: boolean;
  adapterRan?: boolean;
  wireHistory?: NormalizedMessage[];
  systemFiltered?: number;
  persistedReplaced?: number;
  writeAckDeduped?: number;
}): DebugRecord<'inference_view'> {
  return {
    ts: 100,
    relMs: 100,
    roundId: 'r1',
    conversationId: 'c1',
    ownerId: 'o',
    agentId: 'a',
    agentName: 'Twin',
    type: 'inference_view',
    seq: opts.seq ?? 1,
    payload: {
      enabled: opts.enabled ?? true,
      adapterRan: opts.adapterRan,
      savings: {
        systemMessagesFiltered: opts.systemFiltered ?? 0,
        persistedReplaced: opts.persistedReplaced ?? 0,
        persistedCharsReduced: 0,
        writeAckDeduped: opts.writeAckDeduped ?? 0,
        writeAckCharsReduced: 0,
      },
      wireHistory: opts.wireHistory,
    },
  };
}

describe('buildTimelineModel：inference_view 节点可达', () => {
  it('inference_view 事件被识别为顶层节点', () => {
    const records: DebugRecord[] = [
      mkRoundStart(),
      mkInferenceView({ seq: 1, adapterRan: true, wireHistory: [] }),
    ];
    const model = buildTimelineModel(records);
    const inferenceNodes = model.nodes.filter(
      (n) => n.kind === 'event' && n.displayType === 'inference_view',
    );
    expect(inferenceNodes.length).toBe(1);
  });

  it('撞墙 retry 一轮多个 inference_view 全部出现', () => {
    const records: DebugRecord[] = [
      mkRoundStart(),
      mkInferenceView({ seq: 1, adapterRan: true, wireHistory: [] }),
      mkInferenceView({ seq: 2, adapterRan: true, wireHistory: [] }),
      mkInferenceView({ seq: 3, adapterRan: true, wireHistory: [] }),
    ];
    const model = buildTimelineModel(records);
    const inferenceNodes = model.nodes.filter(
      (n) => n.kind === 'event' && n.displayType === 'inference_view',
    );
    expect(inferenceNodes.length).toBe(3);
  });
});

describe('getWireHistoryDisplay：三态识别', () => {
  it('adapterRan=true + wireHistory 非空 → present', () => {
    const rec = mkInferenceView({
      adapterRan: true,
      wireHistory: [{ role: 'user', blocks: [{ type: 'text', text: 'q' }] }],
    });
    const r = getWireHistoryDisplay(rec);
    expect(r.kind).toBe('present');
    if (r.kind === 'present') expect(r.messages.length).toBe(1);
  });

  it('adapterRan=true + wireHistory 为 [] → 仍是 present（合法边界）', () => {
    const rec = mkInferenceView({ adapterRan: true, wireHistory: [] });
    expect(getWireHistoryDisplay(rec).kind).toBe('present');
  });

  it('adapterRan=false → resume', () => {
    const rec = mkInferenceView({ adapterRan: false, wireHistory: [] });
    expect(getWireHistoryDisplay(rec).kind).toBe('resume');
  });

  it('adapterRan 缺 → legacy', () => {
    const rec = mkInferenceView({ adapterRan: undefined, wireHistory: undefined });
    expect(getWireHistoryDisplay(rec).kind).toBe('legacy');
  });

  it('wireHistory 缺但 adapterRan=true → 仍是 legacy（旧 ndjson 半字段保护）', () => {
    const rec = mkInferenceView({ adapterRan: true, wireHistory: undefined });
    expect(getWireHistoryDisplay(rec).kind).toBe('legacy');
  });
});

describe('EventRow：inference_view 节点真的渲染到 DOM', () => {
  function renderInferenceRow(payload: {
    enabled: boolean;
    adapterRan?: boolean;
    systemFiltered?: number;
    persistedReplaced?: number;
    writeAckDeduped?: number;
  }) {
    const rec = mkInferenceView({
      ...payload,
      wireHistory: [],
    });
    const ev = {
      kind: 'event' as const,
      record: rec,
      displayType: 'inference_view' as const,
      id: 'inference_view-1',
      relMs: rec.relMs,
    };
    return render(<EventRow event={ev} selected={false} onClick={() => {}} />);
  }

  it('正常路径：显示"真实入参"名字', () => {
    const { container } = renderInferenceRow({ enabled: true, adapterRan: true });
    expect(container.textContent).toContain('真实入参');
  });

  it('启用且有裁剪：status 列含"裁 N 条"', () => {
    const { container } = renderInferenceRow({
      enabled: true,
      adapterRan: true,
      systemFiltered: 1,
      persistedReplaced: 2,
    });
    expect(container.textContent).toContain('裁 3 条');
  });

  it('启用但无裁剪：status 列显示"无裁剪"', () => {
    const { container } = renderInferenceRow({ enabled: true, adapterRan: true });
    expect(container.textContent).toContain('无裁剪');
  });

  it('未启用：status 列显示"未启用"', () => {
    const { container } = renderInferenceRow({ enabled: false, adapterRan: true });
    expect(container.textContent).toContain('未启用');
  });

  it('resume 路径：status 列显示"未跑（resume）"', () => {
    const { container } = renderInferenceRow({ enabled: true, adapterRan: false });
    expect(container.textContent).toContain('resume');
  });
});
