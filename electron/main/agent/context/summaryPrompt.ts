/**
 * 对话摘要 prompt 模板（v0.2 Level 2）
 *
 * 用 conversationSummary backend 调一次模型，把"老对话 + 上次摘要"压成一段新摘要，给 Twin 后续对话作为参考。
 * 递增式：每次触发都把上次摘要喂回去，避免每次重读所有原文。
 */
import type { ChatMessage } from '@shared/types';

export type BuildSummaryPromptArgs = {
  /** 上次摘要（首次触发时为空字符串） */
  previousSummary: string;
  /** 这次要压缩的对话消息（按时间正序） */
  toCompress: ChatMessage[];
  /**
   * 当前任务——用户最新请求原文，供「①当前任务」小节逐字引用。
   * 它的锚在保留段（不被压缩）里，摘要 LLM 只看被压段拿不到它，故由调用方传入。
   */
  currentUserRequest: string;
};

const MAX_SUMMARY_LENGTH = 1500;

export function buildSummaryPrompt(args: BuildSummaryPromptArgs): string {
  const renderedHistory = args.toCompress
    .map((m) => {
      if (m.role === 'user') return `【用户】\n${m.text}`;
      if (m.role === 'assistant') {
        const tcLines = m.toolCalls.map((tc) => {
          // v0.4：shortSummary 已下线；摘要 prompt 看完整 detail（摘要 LLM 单次跑，不在乎多几个 token）
          const result = tc.result?.detail ?? tc.result?.summary ?? '（未完成）';
          return `  · 调用 ${tc.name}：${result}`;
        });
        return ['【Twin】', m.text, ...tcLines].filter(Boolean).join('\n');
      }
      // system / context-compressed / abort terminator 等
      return `【系统】\n${m.text}`;
    })
    .join('\n\n');

  const previousSection = args.previousSummary.trim().length > 0
    ? `【已有摘要——本轮把下面新对话合并进来，仍按四个小节重写】\n${args.previousSummary}\n\n`
    : '';

  return `你的任务是把下面这段对话压缩成一段摘要，给 Twin 后续对话作为参考。

${previousSection}【要压缩的对话】（按时间正序）
${renderedHistory}

【当前任务】（保留段里用户的最新请求，供①小节逐字引用）
${args.currentUserRequest}

【要求】
按下面四个固定小节书写，顺序与标题不变（用「① … ④」编号，不用 markdown 标题）：
① 当前任务：逐字引用上面【当前任务】里用户的最新请求，不要转述、不要概括。
② 已完成动作：做过的关键操作，带文件路径与结论。
③ 关键决定及理由：拍板了什么、为什么。
④ 未决问题与待办：还没做完、需要继续跟进的事。
- 保留：用户的请求和决策、用户偏好和事实、跨多轮的重要事件、待办事项
- 丢弃：寒暄、临时上下文、已经 acknowledge 完的子任务执行细节（结论保留）
- **数字按「真相在哪里」分流**：能从磁盘重算的量（表里多少行、录了几条、文件多大、改了几处）一律不写进摘要，换成指向来源的指针——写「行数以 <文件路径> 为准」而不是「共 32 行」；只存在于用户话里的量（他报的薪资范围、他定的底线、他给的期限）照原样保留。
- 用户给过的授权与放宽（「合适的直接录入，不用问我」这类）写进③，它决定后续还要不要再问；丢了会让后面反复追问已经授权过的事。
- 不要重复 system prompt 里已有的内容（人设、记忆系统使用规则等）
- 直接输出四个小节，不要前缀、不要说"摘要："、不要 markdown 标题
- 长度不超过 ${MAX_SUMMARY_LENGTH} 字`;
}
