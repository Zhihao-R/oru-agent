/**
 * Deck 路由提示——为什么 Oru 走 HTML deck 路线（第一性论证，从提示词正文迁出，给人看不给模型看）：
 *  - AI 生成网页演示稿渲染在内嵌预览面板；.pptx 路线在 LLM 训练语料里几乎不存在，
 *    视觉天花板被 PowerPoint 默认模板锁死。
 *  - HTML 路线让 LLM 拿到 Awwwards/Tailwind/CodePen 级别的设计样本——视觉表达力高一个量级。
 *  - 配套闭环：预览面板实时渲染、标 marker + 批注流改、版本历史、一键导出 PDF。
 *
 * narrative / auto_generate 的参数级用法在 proposeDeck.ts 工具 description 单源承载，
 * 这里只留跨工具仲裁（何时用哪个工具、何时绝不调）。
 */
import { definePrompt } from './registry';

export const DECK_ROUTING_HINT = definePrompt(
  {
    id: 'deck-routing',
    title: 'Deck 路由提示',
    category: 'agent',
  },
  `## 关于"做 deck / PPT / 演示稿"

用户要做 deck、PPT、演示稿、分享稿、汇报材料这类**一页页翻的视觉演示物**时——**必须用 \`propose_deck_create\` 工具**，不要用 \`Task\` 让子 agent 写 pptxgenjs 脚本，**也不要用 \`write_file\` 手写 index.html 当 deck**——手写的 html 不进演示稿注册表：不进演示稿列表、没有版本历史、打不开预览，用户在该找它的地方找不到它。

**边界按意图、不按格式**：用户要的是网页 / web 应用 / 落地页 / 工具页 / 单个 html——那**不是**演示稿，照常用 \`Task\`（mode async）/\`write_file\` 做。判断依据是"用户要不要一份翻页的演示物"，不是"产物是不是 HTML"。

操作流程（**叙事先行**——不要一上来就闷头铺幻灯片）：
1. 跟用户澄清风格 / 受众 / 规模 / 主题色 / 是否含图（一次最多 1-3 个最关键问题）；
2. 先起草叙事文稿——这份 deck 要讲什么、怎么递进、每段核心论点，再调 \`propose_deck_create\`（narrative / auto_generate 的用法见工具说明）；
3. 建壳未生成时用户过目 / 改完文稿说"生成吧" → 调 \`generate_deck\`（只管空壳首次生成）；**deck 已生成后**用户又改文稿、想据文稿刷新 → 那是「更新演示设计」（手术式修订、落版本可撤销），由用户点按钮触发，不是重新 \`generate_deck\`。

**改一份已经做过的 deck（不要新建）**：用户要"改改 / 扩充一版 / 调某段"的是一份**已经生成过**的 deck 时——**绝不要再调 \`propose_deck_create\`**：那是新建，会平白多出一份 deck。正确做法：\`list_dir\` 找到这份 deck 的文件夹，读 / 改其中的 \`.narrative.md\`（叙事文稿），改完告诉用户点「更新演示设计」据新文稿刷新这一份；别自己 \`generate_deck\`。

**例外**：用户明确要 \`.pptx\` 文件 / Keynote 兼容 → 如实说明 v1 不直接生成 .pptx，deck 完成后可导 PDF + 用 Keynote/PowerPoint 重排。

\`Task\`（mode async）仍用于：写代码、改文件、跑命令、调研等代码 / 工程类任务。
`,
);
