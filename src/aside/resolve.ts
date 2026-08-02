/**
 * 主窗口 ⌥点的指代解析（技术方案 §3.2）——纯函数，useAsideAltClick 在 mousedown 时调用。
 *
 * 自上而下取首个命中：
 * 1. 选区：window 选区（mousedown capture 时读到的"点之前"那份）；为空再问编辑器内部选区
 *    （CodeMirror，覆盖"编辑器里选中、⌥点编辑器外"——焦点移走后原生选区未必还能读到）。
 * 2. 消息：target.closest('[data-message-id]')。消息数据从 chatStore 内存取——含流式中的
 *    半截文本，快照语义天然成立。一期"点具体东西"主窗口侧只有消息这一类（文件树行刻意
 *    不注册，落 blank 档——避免"被认成具体东西却没有原文"的中间态）。同理，特殊 kind
 *    消息卡（memory-record / task-report / proposal 卡等 ChatArea 独立渲染的根）也未挂
 *    data-message-id，⌥点它们落控件/空白档——这是一期"元素识别允许粗"的有意收缩
 *    （PRD 第七节：一期先覆盖对话消息与 deck 页，二期铺满），不是缺口。
 * 3. 控件：button / [role=button] / input / select / a。
 * 4. 空白：点在对话区内（[data-chat-area]，ChatArea 根节点挂）时 context 带最近几条消息。
 *
 * 每档 label 都是人话——归档标题与指代卡直接展示它。
 * deck 页的对应翻译在 deckClick.ts（webview 内的点主窗口收不到，两条路各自解析、同一个 dispatch）。
 */
import type { AsideReferent, ChatMessage } from '@shared/types';
import { ASIDE_REGION_ATTR, isAsideRegionId, type AsideRegionId } from '@shared/asideRegions';
import { clipLabel } from './label';
// 纯函数（mousedown 时同步调用），拿不到 useTranslation hook，直调 i18n 单例。
// 仅 label 走 t——label **不进 AI prompt**（buildAsideCommentPrompt 拼 text/context/surround/outline/
// caption 但不拼 label），只用于指代卡/归档标题（纯 UI 展示），故纯 UI 翻译、随界面语言。
// context/surround/speakerOf（用户/Oru/系统、前文/后文）才是喂 AI 的 class③，不翻。
import i18n from '@/lib/i18n';

/** 上下文里单条消息的截断上限——前后文给模型"看个大概"，不搬全文（消息可能很长） */
const CONTEXT_ENTRY_MAX = 300;
/** 消息档前后文各取几条（技术方案：前后各 2 条） */
const NEIGHBOR_COUNT = 2;
/** blank 档"附近的对话"取最近几条——对话区贴底是常态，最近几条即屏上所见 */
const BLANK_TAIL_COUNT = 4;

export type AsideResolveArgs = {
  /** mousedown 的 e.target（非 Element 的极端事件形态传 null，按空白处理——点哪都有反应） */
  target: Element | null;
  /** mousedown capture 时读到的 window 选区文本（浏览器在 mousedown 默认行为里才清选区） */
  selectionText: string;
  /** 选区锚点所在元素——选区落在某条消息内时，surround 带上整条消息文本 */
  selectionAnchorEl: Element | null;
  /** 编辑器内部选区（与选段「加入对话」同一来源）——window 选区为空时的兜底 */
  getEditorSelection: () => string;
  /** 按 messageId 在 chatStore 内存里找消息及所在列表；找不到返回 null（落入下一档） */
  findMessage: (messageId: string) => { list: readonly ChatMessage[]; index: number } | null;
  /** active 对话的消息列表——blank 档"附近的对话"用 */
  getActiveMessages: () => readonly ChatMessage[];
};

/** 与 ChatMessage 组件的隐藏口径一致：系统旁白与中断标记用户看不见，不进指代上下文 */
function isUserVisibleText(m: ChatMessage): boolean {
  if (!m.text.trim()) return false;
  if (m.kind === 'turn-terminator') return false;
  if (m.role === 'user' && m.text.startsWith('（系统记：')) return false;
  return true;
}

function speakerOf(m: ChatMessage): string {
  return m.role === 'user' ? '用户' : m.role === 'assistant' ? 'Oru' : '系统';
}

/**
 * 把一组消息排成"谁：说了什么"的行——message 档的前后文与 blank 档的附近对话共用。
 * 不内置过滤：调用方先按 isUserVisibleText 过滤再切窗口，隐藏消息不占窗口名额
 * （否则旁白会把可见邻居挤出前后文，与 blank 档口径相反）。
 */
function messageLines(list: readonly ChatMessage[]): string[] {
  return list.map((m) => {
    const text = m.text.trim();
    const clipped = text.length > CONTEXT_ENTRY_MAX ? `${text.slice(0, CONTEXT_ENTRY_MAX)}…` : text;
    return `${speakerOf(m)}：${clipped}`;
  });
}

/** 选区落在某条消息内时取整条消息文本作 surround；拿不到就不带 */
function selectionSurround(
  anchorEl: Element | null,
  findMessage: AsideResolveArgs['findMessage'],
): string | undefined {
  const id = anchorEl?.closest('[data-message-id]')?.getAttribute('data-message-id');
  const found = id ? findMessage(id) : null;
  const text = found?.list[found.index]?.text.trim();
  return text || undefined;
}

/** 控件 caption 截断上限——a 元素可能套住大块内容，不截会把整块灌进指代 */
const CONTROL_CAPTION_MAX = 120;

/** 控件可见文案：可见文本 > aria-label > title > placeholder，全无则不带 */
function controlCaption(el: Element): string {
  // jsdom 无布局引擎 innerText 为 undefined，textContent 兜底（与 deckAsideExtract 同口径）
  const visible = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
  const raw =
    visible ||
    (
      el.getAttribute('aria-label') ??
      el.getAttribute('title') ??
      el.getAttribute('placeholder') ??
      ''
    ).trim();
  return raw.length > CONTROL_CAPTION_MAX ? `${raw.slice(0, CONTROL_CAPTION_MAX)}…` : raw;
}

/** 点击目标所在功能区（二期 §4 场所感）：锚点缺失 / 脏值 → undefined（宁缺毋错） */
function regionOf(target: Element | null): AsideRegionId | undefined {
  const raw = target?.closest(`[${ASIDE_REGION_ATTR}]`)?.getAttribute(ASIDE_REGION_ATTR);
  return isAsideRegionId(raw) ? raw : undefined;
}

export function resolveAsideReferent(args: AsideResolveArgs): AsideReferent {
  // 区域与内容档正交：每档 referent 都带（二期 §4）；点哪个档都该知道身在哪
  const region = regionOf(args.target);
  // 1. 选区——压过一切（用户特地选了字，指的就是那段字）
  const winSel = args.selectionText.trim();
  if (winSel) {
    return {
      type: 'selection',
      text: winSel,
      surround: selectionSurround(args.selectionAnchorEl, args.findMessage),
      label: `“${clipLabel(winSel)}”`,
      region,
    };
  }
  const editorSel = args.getEditorSelection().trim();
  if (editorSel) {
    return { type: 'selection', text: editorSel, label: `“${clipLabel(editorSel)}”`, region };
  }

  // 2. 消息
  const messageId = args.target
    ?.closest('[data-message-id]')
    ?.getAttribute('data-message-id');
  // DOM 有标识但 store 找不到（不应发生）→ 落入下一档，宁可降档也不给"没有原文"的指认
  const found = messageId ? args.findMessage(messageId) : null;
  if (messageId && found) {
    const msg = found.list[found.index];
    // 与 blank 档同口径：先过滤可见再切窗口，前后各取 NEIGHBOR_COUNT 条可见邻居
    const before = messageLines(
      found.list.slice(0, found.index).filter(isUserVisibleText).slice(-NEIGHBOR_COUNT),
    );
    const after = messageLines(
      found.list.slice(found.index + 1).filter(isUserVisibleText).slice(0, NEIGHBOR_COUNT),
    );
    const parts: string[] = [];
    if (before.length) parts.push(`前文：\n${before.join('\n')}`);
    if (after.length) parts.push(`后文：\n${after.join('\n')}`);
    const text = msg.text.trim();
    return {
      type: 'message',
      messageId,
      text: msg.text,
      context: parts.join('\n'),
      label: text ? `${i18n.t('aside:msgLabel')} · “${clipLabel(text)}”` : i18n.t('aside:aMessage'),
      region,
    };
  }

  // 3. 控件
  const control = args.target?.closest('button, [role="button"], input, select, a');
  if (control) {
    const caption = controlCaption(control);
    return {
      type: 'control',
      caption: caption || undefined,
      label: caption ? `${i18n.t('aside:controlLabel')} · ${clipLabel(caption)}` : i18n.t('aside:uiControl'),
      region,
    };
  }

  // 4. 空白
  if (args.target?.closest('[data-chat-area]')) {
    const tail = messageLines(
      args.getActiveMessages().filter(isUserVisibleText).slice(-BLANK_TAIL_COUNT),
    );
    return {
      type: 'blank',
      context: tail.length ? `附近的对话：\n${tail.join('\n')}` : undefined,
      label: i18n.t('aside:chatArea'),
      region,
    };
  }
  return { type: 'blank', label: i18n.t('aside:uiBlank'), region };
}
