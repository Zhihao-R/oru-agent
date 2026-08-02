/**
 * HTML 制品 profile 声明式能力表
 *
 * profile 由 deckPreview.ts 探针根据 class=slide 块数量判定（不挑标签 section/div/article）：
 *   deck  — 探到 ≥1 个 .slide 块 → 定尺 letterbox + 翻页 + 底部大纲条
 *   plain — 探不到分页 → webview 铺满、原生滚动、无翻页无大纲条
 *
 * 所有 if(profile==='deck') 分支必须通过 PROFILE_CAPS 查表驱动，
 * 不允许在组件里散落 profile 字符串比较。
 */

export type Profile = 'deck' | 'plain';

export type ProfileCaps = {
  /** 是否支持翻页（‹ N/M › 控件 + 左右键） */
  paging: boolean;
  /** 是否显示底部大纲条 */
  outline: boolean;
  /** 是否启用定尺缩放（letterbox + body transform: scale） */
  fixedScale: boolean;
};

export const PROFILE_CAPS: Record<Profile, ProfileCaps> = {
  deck:  { paging: true,  outline: true,  fixedScale: true  },
  plain: { paging: false, outline: false, fixedScale: false },
};
