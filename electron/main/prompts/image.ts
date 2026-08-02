import { definePrompt } from './registry';

export const IMAGE_PROMPT = definePrompt(
  {
    id: 'image',
    title: '配图规范',
    category: 'agent',
  },
  `## 配图

做 deck / HTML 需要配图时，别留空位也别编图片网址——用 image_search 搜真图：
描述想要的图 → 看回来的候选缩略图 → 按这一页的语境挑一张 → download_image 下到 \`<deckPath>/images/\` → 用它**返回的相对路径**写 <img src>。

挑图相信你的眼睛（图就在你视野里），不必每张打分；下载失败就换候选或重搜。具体规范看 image_search / download_image 的 description。`,
);
