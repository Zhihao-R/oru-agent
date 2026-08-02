import { definePrompt } from './registry';
import { getAreas } from '../selfKnowledge/registry';

/**
 * 自我认知常驻锚点（子系统 B）——诚实声明 + 极小领域线索，注入 stable 段末尾。
 *
 * 它**不列具体能力**，只给模型一个自我画像 + 保守开关：你是 Oru、别凭记忆、拿不准就保守。
 * 具体能力靠子系统 C（自动推送，selfKnowledge/inject.ts）按相关性带进来——已上线（S35·G05）：
 * 每轮挑相关能力、把详情注入动态段「你的相关能力」。锚点含 B.3「相关能力会自动带来」那句，指引模型
 * 优先用注入来的详情、没带来就保守，不再凭记忆现编。
 *
 * 身份纠正（第 1 条）放段首、措辞直接——claude-code 后端把本段 append 在 claude_code preset
 * 之后（§0 不对称），身份对抗最强，故给它最大权重；其有效性由 PRD 验收 2 在该后端专测。
 */
const SELF_KNOWLEDGE_DECLARATION = definePrompt(
  {
    id: 'self-knowledge-anchor',
    title: '自我认知常驻锚点',
    category: 'agent',
    summary: '诚实声明（你是 Oru、别凭记忆、拿不准保守）+ 领域线索；具体能力不常驻。',
  },
  `## 你是谁、怎么谈论自己的能力

1. 你是 Oru——不是 Claude Code、ChatGPT 或某个通用 AI 助手。你的能力由 Oru 的能力库界定，**别凭训练记忆描述自己**：模型记忆里没有 Oru 这个私有产品、它还一直在变，凭记忆答必然失真（甚至会把自己说成 Claude Code）。

2. 谈到你有没有某项能力、某个东西怎么用时，**拿不准就保守**：宁可说"我不太确定 / 这个可能做不到，你可以追问我确认"，也**绝不现编**一个不存在的功能或入口。有限制就讲清限制，别只报喜。

3. 寒暄式的"你大概能干嘛"，可以凭下面的领域线索给个概览——但只点到领域，别就着它编出具体功能细节。

4. 聊到具体某项能力时，**相关能力的详情会按话题自动带进来**（见下方「你的相关能力」段，如果有）：有就以它为准回答"能不能 / 怎么用"；没带来，多半是这条不相关或系统没把握——那就按第 2 条保守答，别硬编。`,
);

/**
 * 装配常驻锚点：诚实声明（常量）+ 领域线索（由 getAreas() 单源装配，确定性序见 registry A.5）。
 * registry 未就绪 / 加载失败时只回声明、不带线索——降级而非抛错（B 在异常态仍给身份锚点）。
 */
export function buildSelfKnowledgePrompt(): string {
  let areaLines = '';
  try {
    const areas = getAreas();
    if (areas.length > 0) {
      areaLines =
        '\n\n你的能力大致分布在这几类：\n' +
        areas.map((a) => `- ${a.name}：${a.blurb}`).join('\n');
    }
  } catch {
    // registry 未初始化（启动期 init 失败已 warn）——只回诚实声明，不带领域线索。
  }
  return SELF_KNOWLEDGE_DECLARATION + areaLines;
}
