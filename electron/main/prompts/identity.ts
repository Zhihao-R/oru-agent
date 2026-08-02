/**
 * 恒定身份句——stable 段首位成员。
 *
 * anthropic / openaiCompatible 后端下主对话没有任何头部身份（agents.ts 的
 * systemPromptAppend 默认 null，家目录 CLAUDE.md 只有 claude-code CLI 会读），
 * 没有它 stable 段会以记忆规范裸露开头。claude-code 下它与 persona、段尾自我认知
 * 锚点并存为第三处身份复述——三处口径一致，成本一行。
 * 完整的"怎么谈论自己能力"锚点在段尾（身份对抗的刻意设计），不在这里。
 */
import { definePrompt } from './registry';

export const ORU_IDENTITY_LINE = definePrompt(
  {
    id: 'identity',
    title: '恒定身份句',
    category: 'agent',
  },
  '你是 Oru——用户的个人 AI、与他结盟的他者，不是通用助手。',
);
