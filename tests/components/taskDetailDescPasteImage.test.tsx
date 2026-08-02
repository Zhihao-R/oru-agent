/** @vitest-environment jsdom */
/**
 * 详情面板描述编辑框粘贴图片 → 发出 taskboard.setAttachments（回归：此前 DescriptionField
 * 没接 onPaste，粘贴走 textarea 默认行为、图片被静默丢弃；只有新建对话框接了）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { BoardTask } from '@shared/types';

const TASK: BoardTask = {
  id: 'bt_paste1',
  ownerId: 'local-user',
  title: '贴图任务',
  description: '已有描述',
  status: '待办',
  assignee: 'you',
  createdAt: 1000,
  updatedAt: 2000,
  commentCount: 0,
};

const ws = vi.hoisted(() => ({ calls: [] as ClientRequestPayload[] }));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> => {
      ws.calls.push(payload);
      if (payload.type === 'taskboard.get') {
        return { type: 'taskboard.get.result', task: TASK } as unknown as T;
      }
      if (payload.type === 'taskboard.setAttachments') {
        return { type: 'taskboard.setAttachments.result', task: TASK } as unknown as T;
      }
      return { type: 'ok' } as unknown as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { TaskDetailPanel } from '@/components/taskboard/TaskDetailPanel';

beforeEach(() => {
  ws.calls.length = 0;
  // jsdom 没有 createObjectURL：buildPendingAttachments 造临时预览 blob 用
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: () => 'blob:mock',
    revokeObjectURL: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pasteEventWith(file: File) {
  return {
    clipboardData: {
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
    },
  };
}

describe('详情面板描述粘贴图片', () => {
  it('编辑描述时粘贴 png → 发 taskboard.setAttachments 落盘', async () => {
    render(<TaskDetailPanel taskId={TASK.id} onClose={() => {}} />);
    const desc = await screen.findByText('已有描述');
    fireEvent.click(desc); // 进入编辑态

    const textarea = await screen.findByDisplayValue('已有描述');
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    fireEvent.paste(textarea, pasteEventWith(png));

    await waitFor(() => {
      expect(ws.calls.some((p) => p.type === 'taskboard.setAttachments')).toBe(true);
    });
    const call = ws.calls.find((p) => p.type === 'taskboard.setAttachments');
    expect(call).toMatchObject({ taskId: TASK.id });
  });
});
