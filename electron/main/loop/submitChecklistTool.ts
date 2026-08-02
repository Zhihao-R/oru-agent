/**
 * submit_checklist AgentTool——Loop 拆解受限回合（usage='loopCompile'）唯一暴露的工具。
 * 纯数据提交、无副作用、不过提案闸：校验通过就经 ctx.onChecklistSubmit 把清单交回
 * compileChecklist；校验失败返回带具体原因的工具错误回执，模型在同一回合内修正重交
 * （格式自愈是 agent 系统通用能力，取代旧 one-shot 路径的自建重试）。
 *
 * 校验语义与旧 parseChecklistOutput 一致：剔空 statement、空清单报错。id/status 赋值也在
 * 这里收口——调用方拿到的就是可直接开跑的 ChecklistItem[]。
 */
import type { AgentTool, ToolContext, ToolResult } from '@shared/agent/backend';
import type { ChecklistItem } from '@shared/types';

const TOOL_DESC = `提交拆解好的验收标准清单。每项一句 statement——"算达标的样子"，独立审查员只看对话记录就能判真假。
拆不出可核验判据时不要硬塞空话，也不要调用本工具——直接用纯文本向用户提一个具体的问题。`;

export const SUBMIT_CHECKLIST_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['statement'],
        properties: {
          statement: { type: 'string', description: '一句可核验的达标判据' },
        },
      },
    },
  },
} as const;

/**
 * 提交内容 → ChecklistItem[]。纯函数，校验失败 throw（错误信息面向模型回执）。
 * 语义承接旧 parseChecklistOutput：剔空 statement；剔完为空 = 提交无效。
 */
export function toChecklistItems(input: unknown): ChecklistItem[] {
  const items = (input as { items?: Array<{ statement?: unknown }> } | null)?.items;
  if (!Array.isArray(items)) {
    throw new Error('入参缺 items 数组——按 schema 传 { items: [{ statement: "…" }] }');
  }
  const valid = items.filter(
    (it): it is { statement: string } => typeof it?.statement === 'string' && it.statement.trim().length > 0,
  );
  if (valid.length === 0) {
    throw new Error('清单为空（或全是空 statement）——每项要有一句可核验的达标判据；拆不出就改用纯文本向用户提问');
  }
  return valid.map((it, i) => ({
    id: `c${i + 1}`,
    statement: it.statement.trim(),
    status: 'pending' as const,
  }));
}

export function makeSubmitChecklistTool(): AgentTool {
  return {
    name: 'submit_checklist',
    description: TOOL_DESC,
    inputSchema: SUBMIT_CHECKLIST_SCHEMA,
    mutatesEnvironment: false,
    persistPolicy: 'never',
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.onChecklistSubmit) {
        // 装配错误（拆解回合外被调到）要能看见，不静默吞成功
        return { isError: true, text: '本回合没有接收清单的通道，提交无效' };
      }
      let items: ChecklistItem[];
      try {
        items = toChecklistItems(input);
      } catch (e) {
        return { isError: true, text: e instanceof Error ? e.message : String(e) };
      }
      ctx.onChecklistSubmit(items);
      return { text: `已收到 ${items.length} 项验收标准，循环即将开跑` };
    },
  };
}
