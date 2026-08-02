/** @vitest-environment jsdom */
/**
 * 浮层状态机（src/aside/overlayMachine.ts）——技术方案 §4/§5.2/§6 与 §10 对应条目：
 * 先截后挂的预算降级、换靶的"先隐→双 rAF→再截"时序、短评竞态的静默丢弃、
 * begin 链路（注册 byId + 种子灌桶 + chat.send）、probing 蒸发零痕迹 / chatting 只关浮层。
 * 不经 React 渲染，直接驱动状态机（与 altClick.test 同一拆法）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { Conversation, ChatMessage } from '@shared/types';

// ws mock：impl 可逐测试替换；log 记全部出站请求（"零痕迹"断言靠它）
const ws = vi.hoisted(() => ({
  log: [] as ClientRequestPayload[],
  impl: (async (_p: ClientRequestPayload): Promise<ServerEventPayload> => {
    throw new Error('ws.impl 未配置');
  }) as (p: ClientRequestPayload) => Promise<ServerEventPayload>,
}));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> => {
      ws.log.push(payload);
      return (await ws.impl(payload)) as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

// 标记画图走 canvas（jsdom 无）：mock 成可断言坐标的字符串
vi.mock('@/aside/markShot', () => ({
  markClickOnScreenshot: vi.fn(
    async (b64: string, x: number, y: number) => `marked(${b64}@${x},${y})`,
  ),
}));

import { dispatchAsideClick, setAsideClickHandler, type AsideClick } from '@/aside/dispatch';
import {
  ASIDE_LASTWINS_WINDOW_MS,
  awaitAsideClickChain,
  closeAsideOverlay,
  getAsideOverlayState,
  installAsideOverlayMachine,
  promoteAsideConversation,
  resetAsideOverlayMachineForTest,
  sendAsideMessage,
  setAsidePromoteNavigator,
  subscribeAsideOverlay,
} from '@/aside/overlayMachine';
import { resetAsideReferentQueueForTest } from '@/aside/pendingReferents';
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';

/** last-wins 用例的 fake timers：只接管 setTimeout/clearTimeout——vitest 默认还会
 * fake requestAnimationFrame，盖掉 beforeEach 的同步 rAF mock，waitPaintCommitted 挂死 */
function useTimeoutOnlyFakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

/** 排空微任务链（deferred → impl → request 的多级 then 需要不止一个 tick） */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

function click(x: number, y: number, screenshot?: AsideClick['screenshot']): AsideClick {
  return { referent: { type: 'blank', label: '一处空白' }, position: { x, y }, screenshot };
}

/** capture / comment 都即回的默认 impl */
function happyImpl(screenshot = 'shot', commentText = '短评'): (p: ClientRequestPayload) => Promise<ServerEventPayload> {
  return async (p) => {
    if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot };
    if (p.type === 'aside.comment') return { type: 'aside.comment.result', text: commentText };
    throw new Error(`未预期的请求：${p.type}`);
  };
}

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

function seedMsg(id: string, role: ChatMessage['role'], text: string): ChatMessage {
  return { id, conversationId: conv.id, role, text, toolCalls: [], createdAt: 1, done: true };
}

/** 进入 chatting 的捷径：probing → begin 即回 → 开口 */
async function enterChatting(seeds: ChatMessage[] = [seedMsg('s1', 'user', '指代卡')]): Promise<void> {
  ws.impl = async (p) => {
    if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
    if (p.type === 'aside.comment') return new Promise(() => {}); // 挂起，不参与
    if (p.type === 'aside.begin') return { type: 'aside.begin.result', conversation: conv, messages: seeds };
    if (p.type === 'chat.send') return { type: 'ack' } as ServerEventPayload;
    throw new Error(`未预期的请求：${p.type}`);
  };
  dispatchAsideClick(click(10, 10));
  await awaitAsideClickChain();
  await sendAsideMessage('第一句');
  expect(getAsideOverlayState().phase).toBe('chatting');
}

let uninstall: () => void;
let rafOriginal: typeof window.requestAnimationFrame;

beforeEach(() => {
  ws.log = [];
  ws.impl = happyImpl();
  rafOriginal = window.requestAnimationFrame;
  // rAF 同步回调：时序断言可控（真实环境是异步帧，这里只关心相对顺序）
  window.requestAnimationFrame = (cb) => {
    cb(0);
    return 0;
  };
  useAgentStore.setState({ activeAgentId: 'a1' });
  useChatStore.setState({ conversations: {}, streamingMessageIdByConv: {}, pendingByConv: {} });
  useConversationStore.setState({ byId: {}, byAgent: {}, activeByAgent: {} });
  resetAsideOverlayMachineForTest();
  resetAsideReferentQueueForTest();
  uninstall = installAsideOverlayMachine();
});

afterEach(() => {
  uninstall();
  setAsideClickHandler(null);
  window.requestAnimationFrame = rafOriginal;
  vi.useRealTimers();
});

describe('probing：先截后挂与降级', () => {
  it('截图成功：浮层挂出带标记截图，aside.comment 带图并行发出', async () => {
    dispatchAsideClick(click(12, 34));
    await awaitAsideClickChain();
    const st = getAsideOverlayState();
    expect(st).toMatchObject({
      phase: 'probing',
      visible: true,
      position: { x: 12, y: 34 },
      screenshot: 'marked(shot@12,34)', // 主窗口截图已归一：窗口坐标即截图坐标
    });
    const comment = ws.log.find((p) => p.type === 'aside.comment');
    expect(comment).toMatchObject({ agentId: 'a1', screenshot: 'marked(shot@12,34)' });
  });

  it('截图失败：浮层照常挂出，短评无图降级', async () => {
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') throw new Error('capture 崩了');
      if (p.type === 'aside.comment') return { type: 'aside.comment.result', text: '无图短评' };
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(5, 6));
    await awaitAsideClickChain();
    expect(getAsideOverlayState()).toMatchObject({ phase: 'probing', visible: true });
    const comment = ws.log.find((p) => p.type === 'aside.comment');
    expect(comment).toMatchObject({ screenshot: undefined });
  });

  it('截图超时（>300ms 预算）：浮层照常挂出、无图降级，race 输家不致崩', async () => {
    vi.useFakeTimers();
    const never = deferred<ServerEventPayload>();
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return never.promise;
      if (p.type === 'aside.comment') return { type: 'aside.comment.result', text: 'x' };
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(1, 2));
    await vi.advanceTimersByTimeAsync(300);
    await awaitAsideClickChain();
    expect(getAsideOverlayState()).toMatchObject({ phase: 'probing', visible: true });
    expect(ws.log.find((p) => p.type === 'aside.comment')).toMatchObject({ screenshot: undefined });
    // 超时后截图迟到 reject：catch 已先挂，不产生 unhandled rejection
    never.reject(new Error('迟到的失败'));
    await vi.runAllTimersAsync();
  });

  it('deck 点击：不调 aside.capture，标记画在 deck 截图坐标系（position 是窗口坐标，仅定位用）', async () => {
    dispatchAsideClick(click(500, 400, { base64: 'deckshot', x: 50, y: 60 }));
    await awaitAsideClickChain();
    expect(ws.log.some((p) => p.type === 'aside.capture')).toBe(false);
    expect(getAsideOverlayState()).toMatchObject({
      phase: 'probing',
      position: { x: 500, y: 400 },
      screenshot: 'marked(deckshot@50,60)',
    });
  });

  it('短评飘入：回包写进 probing 状态', async () => {
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    await Promise.resolve(); // 让 fireComment 的微任务收尾
    expect(getAsideOverlayState()).toMatchObject({
      phase: 'probing',
      comment: '短评',
      commentPending: false,
    });
  });

  it('短评在途 commentPending=true（等待气泡的状态源）；失败也收掉，不挂死', async () => {
    const d = deferred<ServerEventPayload>();
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 's' };
      if (p.type === 'aside.comment') return d.promise;
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    expect(getAsideOverlayState()).toMatchObject({ phase: 'probing', commentPending: true });
    d.reject(new Error('短评超时'));
    await flushAsync();
    // 失败：等待位收掉（气泡不能转一辈子），报错行顶上（凡 error 必显示）
    const st = getAsideOverlayState();
    expect(st).toMatchObject({ phase: 'probing', commentPending: false, commentError: '短评超时' });
    expect((st as { comment?: string }).comment).toBeUndefined();
  });
});

describe('换靶的截图时序', () => {
  it('probing 可见时再 ⌥点：先隐浮层 → 双 rAF → 再发 capture，新位置出现', async () => {
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();

    const seq: string[] = [];
    const unsub = subscribeAsideOverlay(() => {
      const st = getAsideOverlayState();
      if (st.phase !== 'idle' && !st.visible) seq.push('hide');
    });
    const prevRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      seq.push('raf');
      cb(0);
      return 0;
    };
    const baseImpl = ws.impl;
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') seq.push('capture');
      return baseImpl(p);
    };

    dispatchAsideClick(click(99, 88));
    await awaitAsideClickChain();
    unsub();
    window.requestAnimationFrame = prevRaf;

    // 隐藏必须发生在 capture 请求前，且经双 rAF 等 paint 提交
    expect(seq.slice(0, 4)).toEqual(['hide', 'raf', 'raf', 'capture']);
    expect(getAsideOverlayState()).toMatchObject({
      phase: 'probing',
      visible: true,
      position: { x: 99, y: 88 },
    });
  });

  it('deck 路径天然免疫：换靶不隐浮层、不发 capture', async () => {
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    const hidden: boolean[] = [];
    const unsub = subscribeAsideOverlay(() => {
      const st = getAsideOverlayState();
      if (st.phase !== 'idle') hidden.push(!st.visible);
    });
    ws.log = [];
    dispatchAsideClick(click(2, 2, { base64: 'd', x: 3, y: 4 }));
    await awaitAsideClickChain();
    unsub();
    expect(hidden).not.toContain(true);
    expect(ws.log.some((p) => p.type === 'aside.capture')).toBe(false);
  });
});

describe('短评竞态：一律静默丢弃', () => {
  it('回包时已换靶：旧短评丢弃，新靶短评照常飘入', async () => {
    const first = deferred<ServerEventPayload>();
    const second = deferred<ServerEventPayload>();
    const pendings = [first, second];
    let i = 0;
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 's' };
      if (p.type === 'aside.comment') return pendings[i++].promise;
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    dispatchAsideClick(click(2, 2)); // 换靶
    await awaitAsideClickChain();
    first.resolve({ type: 'aside.comment.result', text: '旧靶的迟到短评' });
    await flushAsync();
    const st = getAsideOverlayState();
    expect(st.phase).toBe('probing');
    expect((st as { comment?: string }).comment).toBeUndefined();
    second.resolve({ type: 'aside.comment.result', text: '新靶短评' });
    await flushAsync();
    expect(getAsideOverlayState()).toMatchObject({ comment: '新靶短评' });
  });

  it('回包时浮层已关：丢弃不渲染', async () => {
    const d = deferred<ServerEventPayload>();
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 's' };
      if (p.type === 'aside.comment') return d.promise;
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    closeAsideOverlay();
    d.resolve({ type: 'aside.comment.result', text: '迟到' });
    await flushAsync();
    expect(getAsideOverlayState()).toEqual({ phase: 'idle' });
  });

  it('回包时用户已开口：丢弃，且 begin 不带 comment（不再补自评）', async () => {
    const comment = deferred<ServerEventPayload>();
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 's' };
      if (p.type === 'aside.comment') return comment.promise;
      if (p.type === 'aside.begin')
        return { type: 'aside.begin.result', conversation: conv, messages: [seedMsg('s1', 'user', '卡')] };
      if (p.type === 'chat.send') return { type: 'ack' } as ServerEventPayload;
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    await sendAsideMessage('抢话了');
    comment.resolve({ type: 'aside.comment.result', text: '迟到短评' });
    await flushAsync();
    const begin = ws.log.find((p) => p.type === 'aside.begin');
    expect(begin).toMatchObject({ comment: undefined });
    // 已进 chatting，迟到短评没有落进任何状态
    const st = getAsideOverlayState();
    expect(st.phase).toBe('chatting');
    expect(useChatStore.getState().conversations[conv.id]?.some((m) => m.text === '迟到短评')).toBe(false);
  });
});

describe('短评失败：报错可见并随种子进对话', () => {
  it('aside.comment 失败：commentError 落进状态、等待气泡收掉（不再沉默）', async () => {
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 's' };
      if (p.type === 'aside.comment') throw new Error('网络断了');
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    await flushAsync();
    expect(getAsideOverlayState()).toMatchObject({
      phase: 'probing',
      comment: undefined,
      commentError: '网络断了',
      commentPending: false,
    });
  });

  it('短评失败后开口：begin 带 commentError（报错随种子进对话）', async () => {
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 's' };
      if (p.type === 'aside.comment') throw new Error('网络断了');
      if (p.type === 'aside.begin')
        return { type: 'aside.begin.result', conversation: conv, messages: [] };
      if (p.type === 'chat.send') return { type: 'ack' } as ServerEventPayload;
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    await flushAsync();
    await sendAsideMessage('开口');
    expect(ws.log.find((p) => p.type === 'aside.begin')).toMatchObject({
      comment: undefined,
      commentError: '网络断了',
    });
  });
});

describe('begin 链路（首次开口）', () => {
  it('响应注册 byId + 种子灌桶 + 随后 chat.send 带 aside convId 并本地 append', async () => {
    const seeds = [seedMsg('s1', 'user', '指代卡'), seedMsg('s2', 'assistant', '短评种子')];
    await enterChatting(seeds);

    // byId 注册（不注册则 chat 事件路由走 2s buffer）
    expect(useConversationStore.getState().byId[conv.id]).toMatchObject({ id: conv.id, kind: 'aside' });
    // 种子 + 本地 append 的首句
    const bucket = useChatStore.getState().conversations[conv.id];
    expect(bucket.map((m) => m.text)).toEqual(['指代卡', '短评种子', '第一句']);
    // chat.send 自带 convId（不借 chatStore.send——它锚定 active conversation）
    expect(ws.log.find((p) => p.type === 'chat.send')).toMatchObject({
      agentId: 'a1',
      conversationId: conv.id,
      text: '第一句',
    });
    // begin 在 chat.send 之前
    expect(ws.log.findIndex((p) => p.type === 'aside.begin')).toBeLessThan(
      ws.log.findIndex((p) => p.type === 'chat.send'),
    );
  });

  it('短评已飘到再开口：begin 带 comment', async () => {
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    await Promise.resolve(); // 短评（happyImpl 即回）落进状态
    expect(getAsideOverlayState()).toMatchObject({ comment: '短评' });
    ws.impl = async (p) => {
      if (p.type === 'aside.begin')
        return { type: 'aside.begin.result', conversation: conv, messages: [] };
      if (p.type === 'chat.send') return { type: 'ack' } as ServerEventPayload;
      throw new Error(`未预期的请求：${p.type}`);
    };
    await sendAsideMessage('开口');
    expect(ws.log.find((p) => p.type === 'aside.begin')).toMatchObject({ comment: '短评' });
  });
});

describe('说话前转正（probing 点 ↗）', () => {
  afterEach(() => setAsidePromoteNavigator(null));

  it('短评还在途也能转正：begin（无 comment 种子）→ promote → 关浮层 + 导航，全程无 chat.send', async () => {
    const navigate = vi.fn();
    setAsidePromoteNavigator(navigate);
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
      if (p.type === 'aside.comment') return new Promise(() => {}); // 在途——正是真机按钮缺席的状态
      if (p.type === 'aside.begin') return { type: 'aside.begin.result', conversation: conv, messages: [] };
      if (p.type === 'aside.promote') return { type: 'ack' } as ServerEventPayload;
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(10, 10));
    await awaitAsideClickChain();
    expect(getAsideOverlayState().phase).toBe('probing');

    await promoteAsideConversation();

    // begin 先建会话，promote 紧随；没说过话就没有 chat.send
    expect(ws.log.findIndex((p) => p.type === 'aside.begin')).toBeLessThan(
      ws.log.findIndex((p) => p.type === 'aside.promote'),
    );
    expect(ws.log.find((p) => p.type === 'aside.begin')).toMatchObject({ comment: undefined });
    expect(ws.log.some((p) => p.type === 'chat.send')).toBe(false);
    expect(getAsideOverlayState().phase).toBe('idle');
    expect(navigate).toHaveBeenCalledWith('a1', conv.id);
    // 会话照常注册进 byId（导航过去要能路由 chat 事件）
    expect(useConversationStore.getState().byId[conv.id]).toMatchObject({ id: conv.id });
  });

  it('短评已飘到再转正：begin 带 comment 种子', async () => {
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    await Promise.resolve(); // 短评（happyImpl 即回）落进状态
    ws.impl = async (p) => {
      if (p.type === 'aside.begin') return { type: 'aside.begin.result', conversation: conv, messages: [] };
      if (p.type === 'aside.promote') return { type: 'ack' } as ServerEventPayload;
      throw new Error(`未预期的请求：${p.type}`);
    };
    await promoteAsideConversation();
    expect(ws.log.find((p) => p.type === 'aside.begin')).toMatchObject({ comment: '短评' });
    expect(getAsideOverlayState().phase).toBe('idle');
  });

  it('begin 期间关浮层：不发 promote、不导航，会话留在 aside 归档', async () => {
    const navigate = vi.fn();
    setAsidePromoteNavigator(navigate);
    const begin = deferred<ServerEventPayload>();
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
      if (p.type === 'aside.comment') return new Promise(() => {});
      if (p.type === 'aside.begin') return begin.promise;
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(10, 10));
    await awaitAsideClickChain();

    const promoting = promoteAsideConversation();
    // begin 在途：输入锁上、在途短评作废（等待气泡收掉）
    expect(getAsideOverlayState()).toMatchObject({
      phase: 'probing',
      beginning: true,
      commentPending: false,
    });
    closeAsideOverlay();
    begin.resolve({ type: 'aside.begin.result', conversation: conv, messages: [] });
    await promoting;

    expect(getAsideOverlayState().phase).toBe('idle');
    expect(ws.log.some((p) => p.type === 'aside.promote')).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    // 会话已创建不蒸发——留在 aside 归档（byId 照常注册）
    expect(useConversationStore.getState().byId[conv.id]).toMatchObject({ kind: 'aside' });
  });

  it('begin 期间换靶：不进 chatting、不发 promote，新 probing 不被抢走', async () => {
    const navigate = vi.fn();
    setAsidePromoteNavigator(navigate);
    const begin = deferred<ServerEventPayload>();
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
      if (p.type === 'aside.comment') return new Promise(() => {});
      if (p.type === 'aside.begin') return begin.promise;
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(10, 10));
    await awaitAsideClickChain();

    const promoting = promoteAsideConversation();
    dispatchAsideClick(click(99, 99)); // 换靶（令牌作废 begin 的 chatting 迁移）
    await awaitAsideClickChain();
    begin.resolve({ type: 'aside.begin.result', conversation: conv, messages: [] });
    await promoting;

    expect(getAsideOverlayState()).toMatchObject({ phase: 'probing', position: { x: 99, y: 99 } });
    expect(ws.log.some((p) => p.type === 'aside.promote')).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('begin 成功但 promote 失败：停在 chatting（浮层不关、不导航），可重试', async () => {
    const navigate = vi.fn();
    setAsidePromoteNavigator(navigate);
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 'shot' };
      if (p.type === 'aside.comment') return new Promise(() => {});
      if (p.type === 'aside.begin') return { type: 'aside.begin.result', conversation: conv, messages: [] };
      if (p.type === 'aside.promote') throw new Error('网络断了');
      throw new Error(`未预期的请求：${p.type}`);
    };
    dispatchAsideClick(click(10, 10));
    await awaitAsideClickChain();

    await promoteAsideConversation();

    expect(getAsideOverlayState()).toMatchObject({
      phase: 'chatting',
      conversationId: conv.id,
      promoteError: '网络断了', // 报错行可见——再点 ↗ 就是重试
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('promote 在途时关浮层、另起新评点：成功回包不误关新浮层、不导航', async () => {
    const navigate = vi.fn();
    setAsidePromoteNavigator(navigate);
    await enterChatting();
    const promote = deferred<ServerEventPayload>();
    ws.impl = async (p) => {
      if (p.type === 'aside.capture') return { type: 'aside.capture.result', screenshot: 's' };
      if (p.type === 'aside.comment') return new Promise(() => {});
      if (p.type === 'aside.promote') return promote.promise;
      throw new Error(`未预期的请求：${p.type}`);
    };

    const promoting = promoteAsideConversation();
    closeAsideOverlay();
    dispatchAsideClick(click(77, 77)); // 另起新评点
    await awaitAsideClickChain();
    promote.resolve({ type: 'ack' } as ServerEventPayload);
    await promoting;

    expect(getAsideOverlayState()).toMatchObject({ phase: 'probing', position: { x: 77, y: 77 } });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('begin 失败：浮层留在 probing、输入解锁，不发 promote', async () => {
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    ws.impl = async (p) => {
      if (p.type === 'aside.begin') throw new Error('网络断了');
      throw new Error(`未预期的请求：${p.type}`);
    };
    await promoteAsideConversation();
    expect(getAsideOverlayState()).toMatchObject({
      phase: 'probing',
      beginning: false,
      beginError: '网络断了', // 报错行可见
    });
    expect(ws.log.some((p) => p.type === 'aside.promote')).toBe(false);

    // 重试：再次尝试时旧报错先清掉（beginning 在途期间不残留）
    const begin = deferred<ServerEventPayload>();
    ws.impl = async (p) => {
      if (p.type === 'aside.begin') return begin.promise;
      if (p.type === 'aside.promote') return { type: 'ack' } as ServerEventPayload;
      throw new Error(`未预期的请求：${p.type}`);
    };
    const retrying = promoteAsideConversation();
    expect(getAsideOverlayState()).toMatchObject({ beginning: true, beginError: undefined });
    begin.resolve({ type: 'aside.begin.result', conversation: conv, messages: [] });
    await retrying;
    expect(getAsideOverlayState().phase).toBe('idle');
  });
});

describe('发送锁：chat.send 到 chat.started 之间无空窗', () => {
  it('pending 期间第二次发送被拒：不重复 append、不重复 chat.send', async () => {
    await enterChatting();
    // 首句发出即闭锁（chat.started 还没到——这正是曾经可双发的空窗）
    expect(useChatStore.getState().pendingByConv[conv.id]).toBe(true);
    ws.log = [];
    await sendAsideMessage('连按 Enter 的第二发');
    expect(ws.log.some((p) => p.type === 'chat.send')).toBe(false);
    expect(
      useChatStore.getState().conversations[conv.id].map((m) => m.text),
    ).not.toContain('连按 Enter 的第二发');
  });

  it('chat.send 失败：解锁（pending 复位），错误挂进消息流，可以重发', async () => {
    await enterChatting();
    useChatStore.getState().markDone(conv.id, 'none'); // 上一轮收尾，锁打开
    ws.impl = async (p) => {
      if (p.type === 'chat.send') throw new Error('网络断了');
      throw new Error(`未预期的请求：${p.type}`);
    };
    await sendAsideMessage('会失败的一句');
    expect(useChatStore.getState().pendingByConv[conv.id]).toBe(false);
    const bucket = useChatStore.getState().conversations[conv.id];
    expect(bucket.some((m) => m.error)).toBe(true);
  });
});

describe('chatting 中再 ⌥点（指认入队）', () => {
  function chattingImpl(): (p: ClientRequestPayload) => Promise<ServerEventPayload> {
    const base = happyImpl();
    return async (p) => {
      // 与主进程同形态：响应带已落盘的指代卡（渲染端拿它灌桶）
      if (p.type === 'aside.addReferent') {
        return {
          type: 'aside.addReferent.result',
          message: {
            id: `card-${ws.log.length}`,
            conversationId: p.conversationId,
            role: 'user',
            kind: 'aside-referent',
            asideReferent: p.referent,
            text: p.referent.label,
            toolCalls: [],
            createdAt: Date.now(),
            done: true,
          },
        };
      }
      return base(p);
    };
  }

  it('无流式轮：窗口收口后发 aside.addReferent（带标记截图），指代卡回流灌桶，浮层移到新位置', async () => {
    await enterChatting();
    ws.impl = chattingImpl();
    ws.log = [];
    useTimeoutOnlyFakeTimers();
    dispatchAsideClick(click(70, 80));
    await awaitAsideClickChain();
    await vi.advanceTimersByTimeAsync(ASIDE_LASTWINS_WINDOW_MS);
    await awaitAsideClickChain();
    vi.useRealTimers();
    await flushAsync();
    expect(ws.log.find((p) => p.type === 'aside.addReferent')).toMatchObject({
      agentId: 'a1',
      conversationId: conv.id,
      screenshot: 'marked(shot@70,80)',
    });
    // 桶开头完整：种子（begin 灌）→ 首句 → 回流的指代卡——promote 后 ChatArea
    // 桶非空不拉历史，这个顺序就是用户看到的开头
    const bucket = useChatStore.getState().conversations[conv.id];
    expect(bucket.map((m) => m.text)).toEqual(['指代卡', '第一句', '一处空白']);
    expect(bucket.at(-1)).toMatchObject({ role: 'user', kind: 'aside-referent' });
    expect(getAsideOverlayState()).toMatchObject({
      phase: 'chatting',
      visible: true,
      position: { x: 70, y: 80 },
    });
  });

  it('流式中：入队不发；轮结束 flush 且卡进桶；关浮层不影响 flush（指认不蒸发）', async () => {
    await enterChatting();
    ws.impl = chattingImpl();
    ws.log = [];
    useChatStore.getState().startAssistantMessage(conv.id, 'm1');
    useTimeoutOnlyFakeTimers();
    dispatchAsideClick(click(7, 8));
    await awaitAsideClickChain();
    await vi.advanceTimersByTimeAsync(ASIDE_LASTWINS_WINDOW_MS);
    await awaitAsideClickChain();
    vi.useRealTimers();
    expect(ws.log.some((p) => p.type === 'aside.addReferent')).toBe(false); // 流式中不发

    closeAsideOverlay(); // 关浮层——队列与浮层解耦
    useChatStore.getState().markDone(conv.id, 'm1');
    await flushAsync();
    expect(ws.log.find((p) => p.type === 'aside.addReferent')).toMatchObject({
      conversationId: conv.id,
    });
    // 浮层已关，卡照样回流进桶（指认不蒸发的完整语义：发出去 + 看得见）
    expect(useChatStore.getState().conversations[conv.id].at(-1)).toMatchObject({
      kind: 'aside-referent',
    });
  });
});

describe('连点 last-wins（二期 §6：chatting 态 trailing debounce）', () => {
  function chattingImpl(): (p: ClientRequestPayload) => Promise<ServerEventPayload> {
    const base = happyImpl();
    return async (p) => {
      if (p.type === 'aside.addReferent') {
        return {
          type: 'aside.addReferent.result',
          message: {
            id: `card-${ws.log.length}`,
            conversationId: p.conversationId,
            role: 'user',
            kind: 'aside-referent',
            asideReferent: p.referent,
            text: p.referent.label,
            toolCalls: [],
            createdAt: Date.now(),
            done: true,
          },
        };
      }
      return base(p);
    };
  }

  it('浮层移位即时：点击后立刻在新位置，无需等窗口', async () => {
    await enterChatting();
    ws.impl = chattingImpl();
    useTimeoutOnlyFakeTimers();
    dispatchAsideClick(click(70, 80));
    await awaitAsideClickChain();
    expect(getAsideOverlayState()).toMatchObject({
      phase: 'chatting',
      visible: true,
      position: { x: 70, y: 80 },
    });
    vi.useRealTimers();
  });

  it('窗口内连点两处：只有最后一次产生截图与 addReferent，前一次零痕迹', async () => {
    await enterChatting();
    ws.impl = chattingImpl();
    ws.log = [];
    useTimeoutOnlyFakeTimers();
    dispatchAsideClick(click(10, 20));
    await awaitAsideClickChain();
    await vi.advanceTimersByTimeAsync(ASIDE_LASTWINS_WINDOW_MS / 2);
    dispatchAsideClick(click(30, 40)); // 窗口内：替换前一次（改指语义就是丢弃）
    await awaitAsideClickChain();
    await vi.advanceTimersByTimeAsync(ASIDE_LASTWINS_WINDOW_MS);
    await awaitAsideClickChain();
    vi.useRealTimers();
    await flushAsync();

    // 被替换的点击不得产生 addReferent 请求与截图残留（§9 专门测试点）
    const captures = ws.log.filter((p) => p.type === 'aside.capture');
    const adds = ws.log.filter((p) => p.type === 'aside.addReferent');
    expect(captures).toHaveLength(1);
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ screenshot: 'marked(shot@30,40)' });
    // 浮层最终在最后一次点击的位置
    expect(getAsideOverlayState()).toMatchObject({ position: { x: 30, y: 40 } });
  });

  it('窗口外两次点击：各自递进（两次 addReferent，顺序 = 点击序）', async () => {
    await enterChatting();
    ws.impl = chattingImpl();
    ws.log = [];
    useTimeoutOnlyFakeTimers();
    dispatchAsideClick(click(10, 20));
    await awaitAsideClickChain();
    await vi.advanceTimersByTimeAsync(ASIDE_LASTWINS_WINDOW_MS);
    await awaitAsideClickChain();
    dispatchAsideClick(click(30, 40)); // 超出双击节奏：独立递进
    await awaitAsideClickChain();
    await vi.advanceTimersByTimeAsync(ASIDE_LASTWINS_WINDOW_MS);
    await awaitAsideClickChain();
    vi.useRealTimers();
    await flushAsync();

    const adds = ws.log.filter((p) => p.type === 'aside.addReferent');
    expect(adds).toHaveLength(2);
    expect(adds[0]).toMatchObject({ screenshot: 'marked(shot@10,20)' });
    expect(adds[1]).toMatchObject({ screenshot: 'marked(shot@30,40)' });
  });

  it('deck 点击的递进同样走窗口：替换后只用最后一次的 deck 截图', async () => {
    await enterChatting();
    ws.impl = chattingImpl();
    ws.log = [];
    useTimeoutOnlyFakeTimers();
    dispatchAsideClick(click(100, 100, { base64: 'd1', x: 1, y: 2 }));
    await awaitAsideClickChain();
    dispatchAsideClick(click(200, 200, { base64: 'd2', x: 3, y: 4 }));
    await awaitAsideClickChain();
    await vi.advanceTimersByTimeAsync(ASIDE_LASTWINS_WINDOW_MS);
    await awaitAsideClickChain();
    vi.useRealTimers();
    await flushAsync();

    const adds = ws.log.filter((p) => p.type === 'aside.addReferent');
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ screenshot: 'marked(d2@3,4)' });
    // deck 自带截图，不发 aside.capture
    expect(ws.log.some((p) => p.type === 'aside.capture')).toBe(false);
  });

  it('窗口期内关浮层：指认照旧不蒸发（窗口收口后仍递进）', async () => {
    await enterChatting();
    ws.impl = chattingImpl();
    ws.log = [];
    useTimeoutOnlyFakeTimers();
    dispatchAsideClick(click(10, 20));
    await awaitAsideClickChain();
    closeAsideOverlay();
    await vi.advanceTimersByTimeAsync(ASIDE_LASTWINS_WINDOW_MS);
    await awaitAsideClickChain();
    vi.useRealTimers();
    await flushAsync();
    expect(ws.log.filter((p) => p.type === 'aside.addReferent')).toHaveLength(1);
  });

  it('probing 不进窗口：连点换靶仍即时处理（零变化）', async () => {
    useTimeoutOnlyFakeTimers();
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    dispatchAsideClick(click(2, 2));
    await awaitAsideClickChain();
    // 不推时钟：换靶已完成、capture 已发两次（probing 的 last-wins 是令牌制，无窗口）
    expect(ws.log.filter((p) => p.type === 'aside.capture')).toHaveLength(2);
    expect(getAsideOverlayState()).toMatchObject({ phase: 'probing', position: { x: 2, y: 2 } });
    vi.useRealTimers();
  });
});

describe('关闭语义', () => {
  it('probing 蒸发零痕迹：除 capture/comment 外无任何 WS 调用，桶与 byId 无残留', async () => {
    dispatchAsideClick(click(1, 1));
    await awaitAsideClickChain();
    closeAsideOverlay();
    expect(getAsideOverlayState()).toEqual({ phase: 'idle' });
    expect(ws.log.map((p) => p.type)).toEqual(['aside.capture', 'aside.comment']);
    expect(useChatStore.getState().conversations).toEqual({});
    expect(useConversationStore.getState().byId).toEqual({});
  });

  it('chatting 外点只关浮层：对话桶保留（已落盘=归档）', async () => {
    await enterChatting();
    closeAsideOverlay();
    expect(getAsideOverlayState()).toEqual({ phase: 'idle' });
    expect(useChatStore.getState().conversations[conv.id]).toBeDefined();
    expect(useConversationStore.getState().byId[conv.id]).toBeDefined();
  });
});
