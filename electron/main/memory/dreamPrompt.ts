/**
 * dream agent 的输入 prompt 组装。
 *
 * v2：dream 是带工具的多轮 agent——输入只给 episode 索引 + 三份档案全文，
 * episode 正文 / 来源对话由 agent 用工具（read_memory / read_conversation）按需读。
 * 不再有 outputSchema：落盘走 merge_episodes / edit_memory 工具，不是一次性结构化 JSON。
 */

export { DREAM_SYSTEM_PROMPT } from '../prompts/dream';

const DAY_MS = 24 * 3600_000;

/**
 * 把「距上次整理」表述成给夜记当时间锚点的一行——夜记守则据此说准跨度（别默认都发生在今天）。
 * lastDreamAt=0 表示从没整理过；now 显式传入以保持纯函数可测。
 */
export function describeSinceLastReview(lastDreamAt: number, now: number): string {
  if (!lastDreamAt) return '这是第一次整理，下面是目前攒下的 episode。';
  const days = Math.max(1, Math.round((now - lastDreamAt) / DAY_MS));
  return `距上次整理约 ${days} 天——下面的 episode 是这段时间里新增 / 动过的。`;
}

/**
 * 拼 dream agent 的首条 prompt：距上次整理跨度 + 近期 episode 索引 + 用户/项目/人设三份档案全文。
 */
export function buildDreamPrompt(args: {
  /** 上次复盘时刻 epochMs（0=从没跑过）；喂夜记当时间锚点 */
  lastDreamAt: number;
  /** 现在 epochMs；与 lastDreamAt 算跨度，显式传入保持可测 */
  now: number;
  episodeIndex: string;
  userProfileText: string;
  projectProfileText: string;
  selfText: string;
  currentProjectId: string | null;
  /** 超软预算、需整篇重写精简的档案（人类可读标签，S35·G35）。空=都在预算内 */
  overBudgetProfiles?: string[];
}): string {
  const projectHeader = args.currentProjectId
    ? `## 当前项目档案（${args.currentProjectId}）`
    : '## 项目档案';
  const overBudget = args.overBudgetProfiles ?? [];
  const budgetSection = overBudget.length
    ? [
        '',
        '## 超篇幅预算的档案——请整篇重写精简（write_memory 覆盖）',
        ...overBudget.map((x) => `- ${x}`),
        '把它删冗余、合并被新认知取代的旧段、收回预算内；只留解释「是谁」的稳定画像，别丢有效信息。',
      ]
    : [];
  return [
    '## 距上次整理',
    describeSinceLastReview(args.lastDreamAt, args.now),
    '',
    '## 近期 active episode 索引（压缩路径: 标题 - 描述）',
    args.episodeIndex || '_(无)_',
    '',
    '## 当前用户档案 user/profile.md',
    args.userProfileText || '_(空)_',
    '',
    projectHeader,
    args.projectProfileText || '_(空)_',
    '',
    '## 你的人设 agents/twin/self.md',
    args.selfText || '_(空)_',
    ...budgetSection,
    '',
    '现在按守则整理 episode、升格画像。需要 episode 正文或来源对话就用工具读。',
  ].join('\n');
}
