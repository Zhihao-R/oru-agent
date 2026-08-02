/**
 * 随手评点浮层的状态机——纯模块、不碰 React（壳是 AsideOverlay.tsx，仿 T10 的
 * installAsideAltClick 拆法：jsdom 测试不经 React 渲染直接驱动）。
 *
 * 两个阶段（技术方案 §2/§6）：
 * - probing：⌥ 点即现。先截后挂（~300ms 预算，超时/失败无图降级，浮层无条件出现）、
 *   截图画标记点、并行发 aside.comment（短评异步飘入，竞态一律静默丢弃）。
 *   外点 / ESC → 全部蒸发——零痕迹由结构保证（无对话、零落盘）。
 * - chatting：首次开口经 aside.begin 出生即归档的 kind:'aside' 对话；消息走既有
 *   chat.send 管线（自带 convId，不借 chatStore.send——它锚定 active conversation）。
 *   再 ⌥ 点 → 指认进 pendingReferents 队列。外点 / ESC → 只关浮层。
 *
 * 点击处理串行化（chain）：连点时指认顺序 = 点击顺序（队列卡序的前提），
 * 隐浮层→截图→再现的时序也不交叠。竞态守卫用点击令牌（clickSeq）：
 * 短评回包对不上令牌（已换靶 / 已开口）或浮层已不在 probing（已关）→ 扔掉，不做 abort 管线。
 */
import type { AsideReferent } from '@shared/types';
import type { AsideBeginResultEvent, AsideCaptureResultEvent, AsideCommentResultEvent } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore, attachNetworkErrorToLast } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { setAsideClickHandler, type AsideClick } from './dispatch';
import { markClickOnScreenshot } from './markShot';
import { enqueueAsideReferent } from './pendingReferents';
import { asideOriginField } from './origin';

/** 先截后挂的体感预算：正常几十毫秒返回；到点截图还没回来就无图降级，浮层照常出现 */
const CAPTURE_BUDGET_MS = 300;

/**
 * 连点 last-wins 窗口（二期 §6）：chatting 态短时间内连点多处，以最后一次为准——
 * 前面几次视为改指 / 误点，有意丢弃（不产生截图与 addReferent）。
 * 双击节奏量级起步，真机手感定稿（PRD 待定项）；不做设置项。
 * 只管 chatting 的指代递进：probing 换靶本就是令牌制的无窗口 last-wins，零变化；
 * 浮层的移位是即时层（「浮层立刻出现」是硬承诺），不归本窗口管。
 */
export const ASIDE_LASTWINS_WINDOW_MS = 400;

export type AsideOverlayState =
  | { phase: 'idle' }
  | {
      phase: 'probing';
      /** 换靶截图期间短暂为 false（截图里不能有旧浮层）；壳按它渲染/隐藏 */
      visible: boolean;
      position: { x: number; y: number };
      agentId: string;
      referent: AsideReferent;
      /** 已画标记的截图 PNG base64（不带 data: 前缀）；截图失败则缺省 */
      screenshot?: string;
      /** 已飘到的短评；undefined = 还没到 */
      comment?: string;
      /** 短评失败的原因（与 comment 互斥）——壳显示报错行；开口/转正时随种子进对话 */
      commentError?: string;
      /** 短评在途——壳据此显示等待气泡；settle（成功/失败/作废）后归位 */
      commentPending: boolean;
      /** aside.begin 在途——锁输入框防重复开口 */
      beginning: boolean;
      /** begin 失败的原因——壳显示报错行；下次尝试时清掉 */
      beginError?: string;
    }
  | {
      phase: 'chatting';
      visible: boolean;
      position: { x: number; y: number };
      agentId: string;
      conversationId: string;
      /** 转正失败的原因——壳显示报错行；再点 ↗ 就是重试 */
      promoteError?: string;
    };

let state: AsideOverlayState = { phase: 'idle' };
const listeners = new Set<() => void>();
/** 点击令牌：每次 ⌥ 点与每次开口都使之前的在途短评作废 */
let clickSeq = 0;
/** 点击处理链——串行保证指认顺序与截图时序 */
let chain: Promise<void> = Promise.resolve();

function setState(next: AsideOverlayState): void {
  state = next;
  for (const l of listeners) l();
}

export function getAsideOverlayState(): AsideOverlayState {
  return state;
}

export function subscribeAsideOverlay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 壳挂载时注册唯一点击 handler；返回的清理与注册成对（useEffect 直接 return 它） */
export function installAsideOverlayMachine(): () => void {
  setAsideClickHandler(handleAsideClick);
  return () => setAsideClickHandler(null);
}

/** 仅测试用：等当前点击处理链排空 */
export function awaitAsideClickChain(): Promise<void> {
  return chain;
}

/** 仅测试用：状态机归零（不动 pendingReferents——那是另一个模块的生命周期） */
export function resetAsideOverlayMachineForTest(): void {
  state = { phase: 'idle' };
  chain = Promise.resolve();
  clearTimeout(lastWinsTimer);
  lastWinsTimer = undefined;
  pendingChatClick = null;
}

function handleAsideClick(click: AsideClick): void {
  const token = ++clickSeq;
  chain = chain
    .then(() => processClick(click, token))
    .catch((err) => console.warn('[aside] 点击处理失败：', (err as Error).message));
}

/** 双 rAF 等隐藏真正上屏——第一帧提交渲染、第二帧确保合成器画完，截图里才没有旧浮层 */
function waitPaintCommitted(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** 主窗口截图，带体感预算；race 输家的 reject 已接住（catch 先挂），超时计时器成对清理 */
async function captureWithBudget(): Promise<string | undefined> {
  const req = wsClient
    .request<AsideCaptureResultEvent>({ type: 'aside.capture' })
    .then((r) => r.screenshot)
    .catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), CAPTURE_BUDGET_MS);
  });
  try {
    return await Promise.race([req, budget]);
  } finally {
    clearTimeout(timer);
  }
}

async function processClick(click: AsideClick, token: number): Promise<void> {
  // chatting 中的点击归属该场对话（指认一经做出就属于它，处理期间关浮层也照常入队）
  const chatting = state.phase === 'chatting' ? state : null;
  const agentId = chatting?.agentId ?? useAgentStore.getState().activeAgentId;
  if (!agentId) return; // 没有 agent 就没有"这个 Oru"，丢弃

  if (chatting) {
    // 浮层移位即时响应（不许为 debounce 垫延迟）；截图 + 递进进 trailing 窗口（二期 §6）
    setState({ ...chatting, visible: true, position: click.position });
    scheduleChatReferent({
      agentId,
      conversationId: chatting.conversationId,
      referent: click.referent,
      position: click.position,
      deckShot: click.screenshot,
    });
    return;
  }

  // ── probing / 新起：截图（带标记）──
  let screenshot: string | undefined;
  if (click.screenshot) {
    // deck 点击自带截图（坐标已是截图坐标系）；webview 截不到 host DOM，浮层天然不入画
    screenshot = await markClickOnScreenshot(
      click.screenshot.base64,
      click.screenshot.x,
      click.screenshot.y,
    );
  } else {
    // 主窗口点击：浮层在场则先隐、等 paint 提交再截（首次点击浮层未挂出，跳过隐藏）
    if (state.phase !== 'idle' && state.visible) {
      setState({ ...state, visible: false });
      await waitPaintCommitted();
    }
    const captured = await captureWithBudget();
    // 主窗口截图已归一逻辑像素：窗口坐标即截图坐标
    if (captured) {
      screenshot = await markClickOnScreenshot(captured, click.position.x, click.position.y);
    }
  }

  // 后点为准——处理期间又来新点击则本次作废（截图与短评全丢）
  if (token !== clickSeq) return;
  setState({
    phase: 'probing',
    visible: true,
    position: click.position,
    agentId,
    referent: click.referent,
    screenshot,
    commentPending: true,
    beginning: false,
  });
  // 短评与浮层挂出并行；竞态（换靶/开口/关浮层）静默丢弃，失败显示报错行
  void fireComment(token, agentId, click.referent, screenshot);
}

// ─── chatting 态指代递进的 last-wins 窗口（二期 §6）─────────────────

type PendingChatClick = {
  agentId: string;
  conversationId: string;
  referent: AsideReferent;
  /** 点击的窗口坐标——主窗口截图已归一逻辑像素，标记直接用它 */
  position: { x: number; y: number };
  /** deck 点击自带的截图（坐标已是截图坐标系）；主窗口点击缺省，收口时现截 */
  deckShot?: AsideClick['screenshot'];
};

/** 窗口内未收口的最后一次点击；timer 与之成对（resetAsideOverlayMachineForTest 一并清理） */
let pendingChatClick: PendingChatClick | null = null;
let lastWinsTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 登记一次 chatting 态指认并重置窗口：窗口内的新点击替换未发出的上一次——
 * 改指语义就是丢弃，被替换的点击不产生截图与 addReferent（§9 专门测试点）。
 * 截图推迟到收口才做：debounce 期间不截，丢弃的点击零残留。
 *
 * pendingReferents 队列层刻意不做同窗口替换（方案 §6 提到的那层）：入队只发生在
 * 窗口收口瞬间，凡同窗口点击必在收口前就被这里替换掉——队列里结构上不可能出现
 * 同窗口两张卡，「队列同窗口只留最后一次」由本层独自保证。
 */
function scheduleChatReferent(item: PendingChatClick): void {
  pendingChatClick = item;
  clearTimeout(lastWinsTimer);
  lastWinsTimer = setTimeout(() => {
    lastWinsTimer = undefined;
    // 进链执行：与点击处理串行，截图的「隐浮层→paint→截」时序不与其他任务交叠
    chain = chain
      .then(commitChatReferent)
      .catch((err) => console.warn('[aside] 指认收口失败：', (err as Error).message));
  }, ASIDE_LASTWINS_WINDOW_MS);
}

/** 窗口收口：给幸存的那次点击截图、入 pendingReferents 队列（关浮层不蒸发——队列与浮层解耦） */
async function commitChatReferent(): Promise<void> {
  const item = pendingChatClick;
  pendingChatClick = null;
  if (!item) return;

  let screenshot: string | undefined;
  if (item.deckShot) {
    screenshot = await markClickOnScreenshot(item.deckShot.base64, item.deckShot.x, item.deckShot.y);
  } else {
    // 浮层在场则先隐再截（与 probing 路径同一时序）；截完恢复可见
    let hid = false;
    if (state.phase !== 'idle' && state.visible) {
      hid = true;
      setState({ ...state, visible: false });
      await waitPaintCommitted();
    }
    const captured = await captureWithBudget();
    if (captured) {
      screenshot = await markClickOnScreenshot(captured, item.position.x, item.position.y);
    }
    if (hid && state.phase !== 'idle') {
      setState({ ...state, visible: true });
    }
  }

  enqueueAsideReferent({
    agentId: item.agentId,
    conversationId: item.conversationId,
    referent: item.referent,
    screenshot,
  });
}

async function fireComment(
  token: number,
  agentId: string,
  referent: AsideReferent,
  screenshot: string | undefined,
): Promise<void> {
  let text: string | undefined;
  let error: string | undefined;
  try {
    const res = await wsClient.request<AsideCommentResultEvent>({
      type: 'aside.comment',
      agentId,
      referent,
      screenshot,
      ...asideOriginField(),
    });
    text = res.text;
  } catch (err) {
    // 失败不再沉默（凡 error 必显示）：等待气泡让位给报错行；开口/转正时随种子进对话
    error = (err as Error).message;
  }
  // 回包时已换靶 / 已开口（令牌不符）或已关（不在 probing）→ 静默丢弃
  if (token !== clickSeq || state.phase !== 'probing') return;
  setState({ ...state, comment: text, commentError: error, commentPending: false });
}

/**
 * 浮层输入框的统一发送入口：probing 首次开口走 begin，chatting 走既有管线。
 * 返回这句话是否已进入消息流——false 只在 begin 失败时出现（对话没建起来，话没去处，
 * 壳应把草稿放回输入框）；chatting 路径的发送失败已有错误气泡挂进消息流，算有去处。
 */
export async function sendAsideMessage(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (state.phase === 'probing') return beginChat(trimmed);
  if (state.phase === 'chatting') {
    await sendIntoConversation(state.agentId, state.conversationId, trimmed);
    return true;
  }
  return false;
}

/**
 * aside.begin：建会话（指认/截图/短评为种子）并进 chatting——首次开口与说话前转正共用。
 * 发起即作废在途短评（不再飘入、也不进 begin 的种子）——等待气泡一并收掉。
 * 返回会话标识；期间换靶/关浮层也返回（会话已创建，不随浮层蒸发），只是不进 chatting。
 * 失败返回 null。
 */
async function beginConversation(): Promise<{ agentId: string; conversationId: string } | null> {
  if (state.phase !== 'probing' || state.beginning) return null;
  const { agentId, referent, screenshot, comment, commentError } = state;
  const myToken = ++clickSeq;
  setState({ ...state, beginning: true, commentPending: false, beginError: undefined });
  try {
    const res = await wsClient.request<AsideBeginResultEvent>({
      type: 'aside.begin',
      agentId,
      referent,
      screenshot,
      comment,
      commentError,
      ...asideOriginField(),
    });
    // 注册进 byId——不注册则 chat 事件路由走 2s buffer，浮层流式开头卡顿
    useConversationStore.getState().registerConversation(res.conversation);
    // 种子灌桶：桶从此与落盘历史一致（ChatArea 只在桶空时拉历史——转正后开头完整的前提）
    useChatStore.getState().loadHistory(res.conversation.id, res.messages);
    // 期间没换靶、没关浮层才进 chatting
    if (clickSeq === myToken && state.phase === 'probing') {
      setState({
        phase: 'chatting',
        visible: state.visible,
        position: state.position,
        agentId,
        conversationId: res.conversation.id,
      });
    }
    return { agentId, conversationId: res.conversation.id };
  } catch (err) {
    console.warn('[aside] 开口失败：', (err as Error).message);
    if (clickSeq === myToken && state.phase === 'probing') {
      setState({ ...state, beginning: false, beginError: (err as Error).message });
    }
    return null;
  }
}

async function beginChat(text: string): Promise<boolean> {
  const conv = await beginConversation();
  // 对话没建起来，这句话没去处——壳把草稿放回输入框
  if (!conv) return false;
  // 对话已创建，首句照发（期间换靶/关浮层也发——话已出口，不随浮层蒸发）
  await sendIntoConversation(conv.agentId, conv.conversationId, text);
  return true;
}

/**
 * 与 chatStore.send 的本地行为同构：先乐观 append + 置 pending 再发 chat.send。
 * pending 在发送瞬间闭合（不等 chat.started）——否则到 started 之间有空窗，连按 Enter 双发，
 * 第二发吃 AGENT_BUSY 被当网络错误挂气泡。失败把错误挂进消息流并解锁；
 * 成功路径的解锁由 chat.done → markDone 负责（与 chatStore.send 同源）。
 */
async function sendIntoConversation(
  agentId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  if (useChatStore.getState().pendingByConv[conversationId]) return; // 上一发未结，拒绝双发
  useChatStore.getState().appendUserMessage(conversationId, text);
  useChatStore.setState((s) => ({
    pendingByConv: { ...s.pendingByConv, [conversationId]: true },
  }));
  try {
    await wsClient.request({ type: 'chat.send', agentId, conversationId, text });
  } catch (err) {
    useChatStore.setState((s) => ({
      conversations: attachNetworkErrorToLast(s.conversations, conversationId, (err as Error).message),
      pendingByConv: { ...s.pendingByConv, [conversationId]: false },
    }));
  }
}

let promoteNavigator: ((agentId: string, conversationId: string) => void) | null = null;

/**
 * 注册"promote 成功后切主视图到该对话 + 光标入输入框"的导航动作
 * （实现在 promoteNavigation.ts，App 挂载时注册——页面切换是 App 的局部 state）。
 * 未注册时 promote 只关浮层（对话已在主列表浮现，用户自己能点过去）。
 */
export function setAsidePromoteNavigator(
  fn: ((agentId: string, conversationId: string) => void) | null,
): void {
  promoteNavigator = fn;
}

/** ↗ 去对话：rekind aside→sub；成功后关浮层（pending 队列与浮层解耦，照常 flush） */
export async function promoteAsideConversation(): Promise<void> {
  // 说话前（probing）也可转正：先建会话（指认/短评为种子），落进 chatting 再走同一条转正路。
  // begin 期间换靶/关浮层 → 不进 chatting，下方守卫直接退出（会话留在 aside 归档，不抢视线）。
  if (state.phase === 'probing') await beginConversation();
  if (state.phase !== 'chatting') return;
  const { agentId, conversationId } = state;
  try {
    await wsClient.request({ type: 'aside.promote', agentId, conversationId, ...asideOriginField() });
  } catch (err) {
    console.warn('[aside] 转正失败：', (err as Error).message);
    // 报错行留在浮层（再点 ↗ 就是重试）；请求期间关了浮层就不复活它
    if (state.phase === 'chatting' && state.conversationId === conversationId) {
      setState({ ...state, promoteError: (err as Error).message });
    }
    return;
  }
  // 只关本场 chatting：请求期间用户已关浮层/另起新评点 → 不误关新浮层、不抢视线
  // （对话已转正，主列表里已浮现，用户自己能点过去）
  if (state.phase === 'chatting' && state.conversationId === conversationId) {
    setState({ phase: 'idle' });
    promoteNavigator?.(agentId, conversationId);
  }
}

/**
 * 外点 / ESC 关浮层。probing：全部蒸发（无对话、零落盘，未到的短评由 phase 守卫丢弃）；
 * chatting：只关浮层（对话出生即归档；pending 队列照常 flush）。
 */
export function closeAsideOverlay(): void {
  if (state.phase === 'idle') return;
  setState({ phase: 'idle' });
}
