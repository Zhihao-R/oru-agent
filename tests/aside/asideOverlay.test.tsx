/** @vitest-environment jsdom */
/**
 * AsideOverlay 组件层——换靶截图的隐藏瞬间"藏而不卸"的挂载语义：
 * 输入草稿不蒸发、隐藏期间外点 / ESC 不响应（换靶是连续动作）、重现后一切照旧。
 * 状态机本体的时序断言在 overlayMachine.test.ts，这里只验 React 壳。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { ChatMessage, Conversation } from '@shared/types';

// ws mock：impl 可逐测试替换（与 overlayMachine.test 同一套路）
const ws = vi.hoisted(() => ({
  impl: (async (_p: ClientRequestPayload): Promise<ServerEventPayload> => {
    throw new Error('ws.impl 未配置');
  }) as (p: ClientRequestPayload) => Promise<ServerEventPayload>,
}));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> =>
      (await ws.impl(payload)) as T,
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

// 标记画图走 canvas（jsdom 无）：mock 掉
vi.mock('@/aside/markShot', () => ({
  markClickOnScreenshot: vi.fn(async (b64: string) => `marked(${b64})`),
}));

import { AsideOverlay } from '@/aside/AsideOverlay';
import { dispatchAsideClick, type AsideClick } from '@/aside/dispatch';
import {
  awaitAsideClickChain,
  getAsideOverlayState,
  resetAsideOverlayMachineForTest,
} from '@/aside/overlayMachine';
import { resetAsideReferentQueueForTest } from '@/aside/pendingReferents';
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';

function click(x: number, y: number): AsideClick {
  return { referent: { type: 'blank', label: '一处空白' }, position: { x, y } };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 排空微任务链（waitPaintCommitted → capture 的多级 then 需要不止一个 tick） */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const draftInput = (): HTMLInputElement => screen.getByPlaceholderText<HTMLInputElement>('接着聊…');

let rafOriginal: typeof window.requestAnimationFrame;

beforeEach(() => {
  ws.impl = async (p) => {
    if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
    if (p.type === 'aside.comment') return new Promise(() => {}); // 短评挂起，不参与
    throw new Error(`未预期的请求：${p.type}`);
  };
  rafOriginal = window.requestAnimationFrame;
  // rAF 同步回调：双 rAF 等 paint 在 jsdom 下没有真实帧，这里只要时序推进
  window.requestAnimationFrame = (cb) => {
    cb(0);
    return 0;
  };
  useAgentStore.setState({ agents: [], activeAgentId: 'a1' });
  useChatStore.setState({ conversations: {}, streamingMessageIdByConv: {}, pendingByConv: {} });
  useConversationStore.setState({ byId: {}, byAgent: {}, activeByAgent: {} });
  resetAsideOverlayMachineForTest();
  resetAsideReferentQueueForTest();
});

afterEach(() => {
  cleanup();
  window.requestAnimationFrame = rafOriginal;
});

/** 进入 probing 并敲半句草稿，然后发起换靶（capture 挂起 → 停在隐藏窗口），返回放行的 resolve */
async function enterHiddenWindowWithDraft(): Promise<{ release: () => Promise<void> }> {
  render(<AsideOverlay />);
  await act(async () => {
    dispatchAsideClick(click(10, 10));
    await awaitAsideClickChain();
  });
  fireEvent.change(draftInput(), { target: { value: '敲了半句' } });

  const capture = deferred<ServerEventPayload>();
  ws.impl = async (p) => {
    if (p.type === 'aside.capture') return capture.promise;
    if (p.type === 'aside.comment') return new Promise(() => {});
    throw new Error(`未预期的请求：${p.type}`);
  };
  await act(async () => {
    dispatchAsideClick(click(200, 150));
    await flushAsync();
  });
  expect(getAsideOverlayState()).toMatchObject({ phase: 'probing', visible: false });
  return {
    release: () =>
      act(async () => {
        capture.resolve({ type: 'aside.capture.result', screenshot: 'shot2' });
        await awaitAsideClickChain();
      }),
  };
}

describe('begin 失败：首句不蒸发', () => {
  it('aside.begin 失败 → 草稿放回输入框，浮层留在 probing 可重试', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AsideOverlay />);
    await act(async () => {
      dispatchAsideClick(click(10, 10));
      await awaitAsideClickChain();
    });
    ws.impl = async (p) => {
      if (p.type === 'aside.begin') throw new Error('网络断了');
      if (p.type === 'aside.comment') return new Promise(() => {});
      throw new Error(`未预期的请求：${p.type}`);
    };
    fireEvent.change(draftInput(), { target: { value: '这句不能丢' } });
    await act(async () => {
      fireEvent.keyDown(draftInput(), { key: 'Enter' });
      await flushAsync();
    });
    // 对话没建起来：草稿回到输入框（输入内容不丢），解锁后可直接重发
    expect(draftInput().value).toBe('这句不能丢');
    expect(getAsideOverlayState()).toMatchObject({ phase: 'probing', beginning: false });
    warn.mockRestore();
  });
});

describe('等待气泡与指代卡', () => {
  const conv: Conversation = {
    id: 'conv-aside-1',
    ownerId: 'local-user',
    agentId: 'a1',
    kind: 'aside',
    title: '一处空白',
    sdkSessionId: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const referentCard: ChatMessage = {
    id: 'card1',
    conversationId: conv.id,
    role: 'user',
    kind: 'aside-referent',
    asideReferent: { type: 'blank', label: '一处空白' },
    text: '用户按住 Option 点击了界面上的一处空白。',
    toolCalls: [],
    createdAt: 1,
    done: true,
  };

  it('probing：短评在途显示等待点；失败静默收掉，不挂死', async () => {
    const comment = deferred<ServerEventPayload>();
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
      if (p.type === 'aside.comment') return comment.promise;
      throw new Error(`未预期的请求：${p.type}`);
    };
    const { container } = render(<AsideOverlay />);
    await act(async () => {
      dispatchAsideClick(click(10, 10));
      await awaitAsideClickChain();
    });
    expect(container.querySelector('.aside-dot')).toBeTruthy();
    await act(async () => {
      comment.reject(new Error('短评超时'));
      await flushAsync();
    });
    expect(container.querySelector('.aside-dot')).toBeNull();
  });

  it('chatting：指代卡不进浮层；回复未出字时显示等待点，首字到了让位', async () => {
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
      if (p.type === 'aside.comment') return new Promise(() => {});
      if (p.type === 'aside.begin')
        return { type: 'aside.begin.result', conversation: conv, messages: [referentCard] };
      if (p.type === 'chat.send') return { type: 'ack' } as ServerEventPayload;
      throw new Error(`未预期的请求：${p.type}`);
    };
    const { container } = render(<AsideOverlay />);
    await act(async () => {
      dispatchAsideClick(click(10, 10));
      await awaitAsideClickChain();
    });
    fireEvent.change(draftInput(), { target: { value: '聊一句' } });
    await act(async () => {
      fireEvent.keyDown(draftInput(), { key: 'Enter' });
      await flushAsync();
    });
    expect(getAsideOverlayState().phase).toBe('chatting');
    // 指代卡（label 与缩略图）不进浮层——用户刚点完就在现场；用户气泡照常
    expect(screen.queryByText('一处空白')).toBeNull();
    expect(screen.getByText('聊一句')).toBeTruthy();
    // 发出后未出字：等待点在场
    expect(container.querySelector('.aside-dot')).toBeTruthy();
    // 流式首字到达（末条 assistant 有 text）：等待点让位给真气泡
    act(() => {
      useChatStore.setState((s) => ({
        conversations: {
          ...s.conversations,
          [conv.id]: [
            ...(s.conversations[conv.id] ?? []),
            { ...referentCard, id: 'a-1', role: 'assistant', kind: undefined, asideReferent: undefined, text: '回你一句' },
          ],
        },
      }));
    });
    expect(container.querySelector('.aside-dot')).toBeNull();
    expect(screen.getByText('回你一句')).toBeTruthy();
  });

  it('chatting：发送失败 → 等待点收掉，错误占位（text 空 + error）在浮层有交代', async () => {
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
      if (p.type === 'aside.comment') return new Promise(() => {});
      if (p.type === 'aside.begin')
        return { type: 'aside.begin.result', conversation: conv, messages: [referentCard] };
      if (p.type === 'chat.send') throw new Error('网络断了');
      throw new Error(`未预期的请求：${p.type}`);
    };
    const { container } = render(<AsideOverlay />);
    await act(async () => {
      dispatchAsideClick(click(10, 10));
      await awaitAsideClickChain();
    });
    fireEvent.change(draftInput(), { target: { value: '聊一句' } });
    await act(async () => {
      fireEvent.keyDown(draftInput(), { key: 'Enter' });
      await flushAsync();
    });
    // 失败不能无声蒸发：等待点收掉、错误行可见（浮层没有 StreamStatusBar，这是唯一交代）
    expect(container.querySelector('.aside-dot')).toBeNull();
    expect(screen.getByText(/没能回上话：网络断了/)).toBeTruthy();
  });

  it('流式半截后失败（二期 §7 真机洞回归）：半截文本与错误行同显', async () => {
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
      if (p.type === 'aside.comment') return new Promise(() => {});
      if (p.type === 'aside.begin')
        return { type: 'aside.begin.result', conversation: conv, messages: [referentCard] };
      if (p.type === 'chat.send') return { type: 'ack' } as ServerEventPayload;
      throw new Error(`未预期的请求：${p.type}`);
    };
    render(<AsideOverlay />);
    await act(async () => {
      dispatchAsideClick(click(10, 10));
      await awaitAsideClickChain();
    });
    fireEvent.change(draftInput(), { target: { value: '聊一句' } });
    await act(async () => {
      fireEvent.keyDown(draftInput(), { key: 'Enter' });
      await flushAsync();
    });
    // 流式回了半截再失败：text 非空 + error 同在一条消息上
    act(() => {
      useChatStore.setState((s) => ({
        conversations: {
          ...s.conversations,
          [conv.id]: [
            ...(s.conversations[conv.id] ?? []),
            {
              ...referentCard,
              id: 'a-half',
              role: 'assistant',
              kind: undefined,
              asideReferent: undefined,
              text: '我觉得这块',
              error: { message: '上游断流', retryable: true },
            } as ChatMessage,
          ],
        },
      }));
    });
    // 半截文本照常渲染，错误行附在其下——不再被丢弃不展示
    expect(screen.getByText('我觉得这块')).toBeTruthy();
    expect(screen.getByText(/没能回上话：上游断流/)).toBeTruthy();
  });
});

describe('换靶的隐藏瞬间：藏而不卸', () => {
  it('草稿不蒸发：隐藏期间输入框仍挂着（visibility 隐藏），重现后半句还在', async () => {
    const { release } = await enterHiddenWindowWithDraft();
    // 隐藏窗口期：组件没卸载，草稿还在，只是 CSS 不可见
    const input = draftInput();
    expect(input.value).toBe('敲了半句');
    expect(
      (input.closest('[data-aside-overlay]') as HTMLElement).style.visibility,
    ).toBe('hidden');

    await release();
    expect(getAsideOverlayState()).toMatchObject({ visible: true, position: { x: 200, y: 150 } });
    expect(draftInput().value).toBe('敲了半句');
  });

  it('隐藏期间外点 / ESC 不响应（换靶是连续动作）；重现后 ESC 照常关浮层', async () => {
    const { release } = await enterHiddenWindowWithDraft();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.mouseDown(document.body);
    });
    expect(getAsideOverlayState().phase).toBe('probing'); // 没被这一瞬的事件关掉

    await release();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(getAsideOverlayState()).toEqual({ phase: 'idle' });
  });
});
