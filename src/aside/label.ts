/**
 * AsideReferent.label 的统一截断口径——label 是归档标题与指代卡的展示文案，
 * 主窗口解析（resolve.ts）与 deck 翻译（deckClick.ts）共用，保持短、超长截断。
 */
const LABEL_TEXT_MAX = 24;

export function clipLabel(text: string): string {
  return text.length > LABEL_TEXT_MAX ? `${text.slice(0, LABEL_TEXT_MAX)}…` : text;
}
