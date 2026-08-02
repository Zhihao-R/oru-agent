/**
 * Deck 工作态中间区标签栏的主按钮文案——按"有没有真 slides"派生。
 *
 * slideCount===0 → 还没真 slides（空壳 stub），主按钮是「从文稿生成演示设计」（触发首次生成）；
 * 否则「更新演示设计」（据文稿手术式修订）。两态同位置、同控件、不同后端动作。
 *
 * 批注栏在文稿标签收起，由 App.tsx 直接按 `deckTab==='preview'` 判定（一句自明、无需经此）。
 */
export type DeckTab = 'preview' | 'narrative';

/** 主按钮动作：空壳 → 首次生成；有 slides → 据文稿更新。文案在视图层经 i18n 落地。 */
export type DeckPrimaryAction = 'generate' | 'update';

export type DeckTabChrome = {
  primaryAction: DeckPrimaryAction;
};

export function deckTabChrome({ slideCount }: { slideCount: number }): DeckTabChrome {
  return {
    primaryAction: slideCount === 0 ? 'generate' : 'update',
  };
}
