/**
 * Deck 客观校验器接口（任务 7 第一段提供实现）。
 *
 * 本任务（任务 6 视觉反馈回路）只**消费**这个窄接口：runner 收尾循环调 validateDeck，
 * 按返回的客观硬伤清单决定"驳回重喊一轮"还是"放行收工"。检查项细节（怎么判结构契约 /
 * 失效图 / 内容溢出 / 空白页）属任务 7，不在本文件。
 *
 * 任务 7 未就位时：impl 是返 [] 的 stub → runner 循环零额外轮次 → 行为与现状一模一样
 * （决策 5 第 4 条，不卡死不报错）。任务 7 落地时通过 setValidateDeckImpl 接入真实实现，
 * 这同时是 smoke 注入 mock 的缝（__setValidateDeckForTest）。
 */

export type DeckValidationErrorKind =
  | 'structure'
  | 'broken-image'
  | 'overflow'
  | 'blank'
  | 'unrecognized';

export type DeckValidationError = {
  /** 页号（1 起，对齐联系表页码徽标 / 用户语义）；`null` = deck 整体（结构级问题不属于任何一页） */
  page: number | null;
  kind: DeckValidationErrorKind;
  message: string;
};

/** signal：用户取消任务时透传进来，让逐页渲染量度尽快中止、不空转到自然超时。 */
export type DeckValidator = (deckPath: string, signal?: AbortSignal) => Promise<DeckValidationError[]>;

/** stub：任务 7 未就位时恒返空（循环零额外轮次 = 同现状） */
const STUB: DeckValidator = async () => [];

let impl: DeckValidator = STUB;

/** runner 循环调用：当前已接入的客观校验器（默认 stub）。 */
export function validateDeck(deckPath: string, signal?: AbortSignal): Promise<DeckValidationError[]> {
  return impl(deckPath, signal);
}

/** 任务 7 落地时接入真实校验器实现。 */
export function setValidateDeckImpl(fn: DeckValidator): void {
  impl = fn;
}

/** 仅测试用：临时替换校验器，返回 restore 函数。 */
export function __setValidateDeckForTest(fn: DeckValidator): () => void {
  const prev = impl;
  impl = fn;
  return () => {
    impl = prev;
  };
}
