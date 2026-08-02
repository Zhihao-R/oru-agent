/**
 * 随手评点浮层——状态机（overlayMachine.ts）的 React 薄壳，App 根部挂一份（单例）。
 *
 * 视觉按 hifi demo 的反色方案：头像 + 半透明反色气泡 + 安静输入框，没有卡片外壳、
 * 没有标题栏（docs/prototypes/2026-06-10-option-click-meta-comment-hifi-demo.html）。
 * 定位是 FileTreeContextMenu 的"点击坐标 + viewport clamp"模式，position: fixed。
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { ChatMessage } from '@shared/types';
import { TwinAvatar } from '@/components/TwinAvatar';
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { ASIDE_OVERLAY_ATTR } from './useAsideAltClick';
import {
  closeAsideOverlay,
  getAsideOverlayState,
  installAsideOverlayMachine,
  promoteAsideConversation,
  sendAsideMessage,
  subscribeAsideOverlay,
  type AsideOverlayState,
} from './overlayMachine';

const OVERLAY_WIDTH = 304;
/** 首帧定位用的估算高度（hifi demo 同值）；layout effect 量到真实尺寸后修正 */
const OVERLAY_EST_HEIGHT = 230;

/** 定位：点击坐标右下偏移 + 放不下翻到另一侧（hifi demo 的 movePop 口径） */
function placeOverlay(p: { x: number; y: number }, height: number): { top: number; left: number } {
  let left = p.x + 10;
  let top = p.y + 14;
  if (left + OVERLAY_WIDTH > window.innerWidth - 12) left = Math.max(12, p.x - OVERLAY_WIDTH - 10);
  if (top + height > window.innerHeight - 12) top = Math.max(12, p.y - height - 10);
  return { top, left };
}

export function AsideOverlay(): JSX.Element | null {
  const st = useSyncExternalStore(subscribeAsideOverlay, getAsideOverlayState);
  // 点击 handler 的注册与组件生命周期成对（卸载即注销，dispatch 恢复丢弃模式）
  useEffect(() => installAsideOverlayMachine(), []);
  // visible:false（换靶截图前的隐藏瞬间）藏而不卸：卸载会蒸发输入草稿、重挂又走入场动画
  // （deck 换靶是保留挂载的平移，主窗口换靶应同感）。隐藏交给内层的 CSS visibility——
  // hidden 不参与 paint，双 rAF 后截图照样干净，且不像 display:none 丢掉 transition 基准。
  if (st.phase === 'idle') return null;
  return <OverlayPanel st={st} />;
}

/** 浮层在场（phase ≠ idle）期间常挂的内层——换靶的隐藏瞬间靠 visibility 藏，草稿与平移动画延续 */
function OverlayPanel({ st }: { st: Exclude<AsideOverlayState, { phase: 'idle' }> }): JSX.Element {
  const { t } = useTranslation('aside');
  const rootRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  // 首开瞬时出现在点击处（demo movePop 的 instant 口径）：初始位置在首渲染就按估算
  // 高度算好，不给 transition 留下从 (0,0) 起播的基准；换靶时位置变更照常 300ms 平移
  const [pos, setPos] = useState(() => placeOverlay(st.position, OVERLAY_EST_HEIGHT));
  const [draft, setDraft] = useState('');

  const avatarPath =
    useAgentStore((s) => s.agents.find((a) => a.id === st.agentId)?.avatarPath) ?? null;
  const convId = st.phase === 'chatting' ? st.conversationId : null;
  const messages = useChatStore((s) => (convId ? s.conversations[convId] : undefined));
  const convPending = useChatStore((s) => (convId ? !!s.pendingByConv[convId] : false));
  const sendLocked = st.phase === 'probing' ? st.beginning : convPending;
  // 发出后到流式出字前显示等待气泡；首字一到（末条 assistant 有 text）即让位给真气泡
  const last = messages?.[messages.length - 1];
  const awaitingReply = convPending && (!last || last.role !== 'assistant' || !last.text);

  // 按真实高度修正定位（估算只在贴底翻面的临界场景偏差）；换靶时随 st.position 重算
  useLayoutEffect(() => {
    setPos(placeOverlay(st.position, rootRef.current?.offsetHeight || OVERLAY_EST_HEIGHT));
  }, [st.position]);

  // 外点（document 级 mousedown，FileTreeContextMenu 先例）+ ESC。
  // ⌥ 左键放行——那是换靶/追加指认，走 dispatch，不在这里双重处理。
  // 换靶截图的隐藏瞬间不响应：换靶是连续动作，浮层旋即在新位置重现，
  // 看不见的浮层不该被这一瞬的事件关掉（ESC 也不吃，留给底下的处理器）。
  useEffect(() => {
    const overlayHidden = (): boolean => {
      const now = getAsideOverlayState();
      return now.phase === 'idle' || !now.visible;
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (overlayHidden()) return;
      if (e.altKey && e.button === 0) return;
      const target = e.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      closeAsideOverlay();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || overlayHidden()) return;
      // stopPropagation 只拦后续节点，拦不住同在 document 冒泡层的其他监听——
      // deck 沉浸态 / ImagePreview 的 ESC 照样触发（FileTreeContextMenu 同病，接受现状）
      e.stopPropagation();
      closeAsideOverlay();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // 新消息 / 流式增量到达时贴底
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const send = (): void => {
    const text = draft.trim();
    if (!text || sendLocked) return;
    setDraft('');
    // begin 失败那句话不能无痕消失：放回输入框（期间用户新敲的字优先，不覆盖）
    void sendAsideMessage(text).then((delivered) => {
      if (!delivered) setDraft((cur) => cur || text);
    });
  };

  return (
    <div
      ref={rootRef}
      {...{ [ASIDE_OVERLAY_ATTR]: '' }}
      style={{
        top: pos.top,
        left: pos.left,
        width: OVERLAY_WIDTH,
        // 换靶截图的隐藏瞬间藏而不卸（见文件头注释）
        visibility: st.visible ? 'visible' : 'hidden',
      }}
      className="fixed z-[90] flex items-start gap-2 transition-[top,left] duration-300 ease-out"
    >
      <TwinAvatar size={30} avatarPath={avatarPath} className="aside-ava-in mt-px" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div ref={chatRef} className="flex max-h-[250px] flex-col gap-1.5 overflow-y-auto">
          {st.phase === 'probing' ? (
            <>
              {st.comment ? (
                <PopBubble side="ai" text={st.comment} />
              ) : st.commentError ? (
                // 短评位已 settle 成报错——开口/转正后这行随种子进对话，措辞同 PopMessage
                <PopErrorLine text={t('errReply', { error: st.commentError })} />
              ) : st.commentPending || st.beginning ? (
                // beginning：开口在途（短评已作废）——首句已离开输入框，等待位不能空着
                <PopLoadingBubble />
              ) : null}
              {st.beginError ? <PopErrorLine text={t('errBegin', { error: st.beginError })} /> : null}
            </>
          ) : (
            <>
              {(messages ?? []).map((m) => (
                <PopMessage key={m.id} message={m} />
              ))}
              {awaitingReply ? <PopLoadingBubble /> : null}
              {st.promoteError ? <PopErrorLine text={t('errPromote', { error: st.promoteError })} /> : null}
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center rounded-full bg-pop-bg px-3.5 opacity-60 transition-opacity focus-within:opacity-100 hover:opacity-100">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) send();
              }}
              placeholder={t('placeholder')}
              className="w-full border-none bg-transparent py-1.5 text-base text-pop-fg outline-none placeholder:text-pop-fg-dim"
            />
          </div>
          {/* 说话前后都在（probing 点击 = 先建会话再转正，状态机兜底） */}
          <button
            type="button"
            title={t('promoteTitle')}
            onClick={() => void promoteAsideConversation()}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-none bg-pop-bg text-pop-fg-dim opacity-60 transition-opacity hover:bg-accent hover:text-[color:var(--accent-fg)] hover:opacity-100"
          >
            <ExternalLink size={15} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 反色气泡：自带层次，无边框无阴影（blur 在动画下有矩形鬼影，demo 已验证不用） */
function PopBubble({ side, text }: { side: 'ai' | 'me'; text: string }): JSX.Element {
  return (
    <div className={side === 'me' ? 'flex justify-end' : 'flex'}>
      <div
        style={side === 'me' ? { color: 'var(--accent-fg)' } : undefined}
        className={`aside-rise-in max-w-[92%] select-text whitespace-pre-wrap rounded-lg px-3 py-2 text-base leading-relaxed ${
          side === 'me' ? 'bg-accent' : 'bg-pop-bg text-pop-fg'
        }`}
      >
        {text}
      </div>
    </div>
  );
}

function PopMessage({ message }: { message: ChatMessage }): JSX.Element | null {
  const { t } = useTranslation('aside');
  // 指代卡不进浮层：用户刚点完就在现场，卡是给归档/正式对话回看的（转正后照常展示）
  if (message.kind === 'aside-referent') return null;
  // 凡 error 必显示（二期 §7）：流式回了半截再失败，半截气泡照常渲染、错误行附在其下——
  // 一期只在 text 为空时才显示，半截场景 error 被丢弃不展示，正是真机「报错不显示」的洞。
  // 浮层没有 StreamStatusBar，这行 dim 字是唯一交代（不弹窗不打断）；重说一句话就是天然重试。
  const errorLine = message.error ? (
    <PopErrorLine text={t('errReply', { error: message.error.message })} />
  ) : null;
  if (!message.text) {
    // 流式刚起、还没字且无错：空气泡不渲染，等待态由 PopLoadingBubble 担
    return errorLine;
  }
  return (
    <>
      <PopBubble side={message.role === 'user' ? 'me' : 'ai'} text={message.text} />
      {errorLine}
    </>
  );
}

/** 报错行：dim 小字、不弹窗不打断——浮层内一切失败（短评/开口/转正/回话）的统一样式 */
function PopErrorLine({ text }: { text: string }): JSX.Element {
  return (
    <div className="aside-rise-in px-1 text-[12px] leading-relaxed text-pop-fg-dim">{text}</div>
  );
}

/** 等待气泡：短评/回复未到时的三点呼吸 */
function PopLoadingBubble(): JSX.Element {
  return (
    <div className="flex">
      <div className="aside-rise-in flex items-center gap-1 rounded-lg bg-pop-bg px-3 py-2.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="aside-dot h-1.5 w-1.5 rounded-full bg-pop-fg-dim"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </div>
    </div>
  );
}
