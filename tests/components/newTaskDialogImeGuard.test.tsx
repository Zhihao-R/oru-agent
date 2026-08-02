/** @vitest-environment jsdom */
/**
 * 新建任务对话框：输入法（IME）选词态回车不触发保存。
 * 拼音候选词按 Enter 选字会派发 keydown Enter，但 nativeEvent.isComposing 为真，
 * 此时不应发出 taskboard.create；仅正常回车（isComposing=false）才提交。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';

const ws = vi.hoisted(() => ({ calls: [] as ClientRequestPayload[] }));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> => {
      ws.calls.push(payload);
      return { type: 'ok' } as unknown as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { NewTaskDialog } from '@/components/taskboard/NewTaskDialog';

function createCalls() {
  return ws.calls.filter((p) => p.type === 'taskboard.create');
}

beforeEach(() => {
  ws.calls.length = 0;
});
afterEach(cleanup);

describe('新建任务对话框 IME 回车守卫', () => {
  it('选词态回车（isComposing）不触发保存', () => {
    render(<NewTaskDialog open onClose={() => {}} />);
    const title = screen.getByPlaceholderText('一句话说清楚要做什么');
    fireEvent.change(title, { target: { value: '写周报' } });

    fireEvent.keyDown(title, { key: 'Enter', isComposing: true });

    expect(createCalls()).toHaveLength(0);
  });

  it('正常回车（非选词态）触发保存', () => {
    render(<NewTaskDialog open onClose={() => {}} />);
    const title = screen.getByPlaceholderText('一句话说清楚要做什么');
    fireEvent.change(title, { target: { value: '写周报' } });

    fireEvent.keyDown(title, { key: 'Enter', isComposing: false });

    expect(createCalls()).toHaveLength(1);
  });
});
