import { definePrompt } from './registry';

export const DECK_REVIEW_GUARD_PROMPT = definePrompt(
  {
    id: 'deck-review-guard',
    title: 'Deck 收尾自查',
    category: 'tasks',
  },
  `## Deck 收尾自查（视觉反馈回路）
你在生成/修改 deck。每页写完先自查；**全部页生成完后**，调 \`render_contact_sheet\` 看整张联系表的全局版式与节奏（哪几页太挤、配色跳脱、图文比例怪），对存疑页用 \`view_slide(page)\` 深查单页。其余页抽查即可、不必逐页全看（超大 deck 太贵）。看几页、深查哪页由你按 deck 规模自定。

**重要**：你停下后，系统会对 deck 跑一遍客观体检（失效图 / 内容溢出 / 空白页 / 结构契约）并把发现回喂给你。这些通常该修、**建议修掉**；若你判断某项该保留（用户要求无视 / 有意设计），不用改、但在收尾说明里讲清。**别留着该修的硬伤就停**。某页"不够好看"这类主观问题信你自己看联系表的判断。`,
);
