/**
 * Capture subagent 的 prompt 模板
 */
export { CAPTURE_SYSTEM_PROMPT } from '../prompts/capture';

export const CAPTURE_OUTPUT_SCHEMA: object = {
  type: 'object',
  properties: {
    // reason 在 operations 之前：要求模型对"抓/不抓"先表态再下结论。
    // 生成侧从严（required）、消费侧从宽（parseCaptureOutput 容忍缺失）——刻意的不对称
    reason: { type: 'string' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string' },
          payload: {
            type: 'object',
            // 修复（2026-08-03）：此前 title/slug/description/content/projectId 只在 required、
            // 没进 properties——strict:false 的 json_schema 下模型只认 properties 里的字段，
            // 于是必填声明形同虚设，deepseek-v4-flash-0731 实测只吐 scope/type/userRequested 三个
            // 空壳 payload，全部落盘失败。补全进 properties 并给描述，模型才看得到怎么填。
            // 两个枚举仍防生造值；userRequested 仍声明成布尔防模型吐字符串 "false"（真值判断下会误锁记忆）。
            properties: {
              scope: { type: 'string', enum: ['agent', 'project'] },
              projectId: {
                type: 'string',
                description: 'scope=project 时必填，已注册项目 id（prj_ 前缀，见"当前项目"节）；scope=agent 时不要填。',
              },
              type: {
                type: 'string',
                enum: ['user', 'feedback', 'project', 'reference', 'agent'],
              },
              title: { type: 'string', description: '简短标题，跟随用户在对话中使用的语言' },
              slug: { type: 'string', description: '拉丁小写连字符' },
              description: { type: 'string', description: '一句话描述' },
              content: { type: 'string', description: '结论正文，写给将来的自己看' },
              userRequested: { type: 'boolean' },
            },
            // 可选参数会被模型系统性忽略（sources 漏填是现成教训，record_memory 据此把
            // userRequested 设成必填）——通道二同样强迫每条都表态，否则"用户嘱记过"这个痕迹静默丢失。
            required: ['scope', 'type', 'title', 'slug', 'description', 'content', 'userRequested'],
          },
        },
        required: ['op', 'payload'],
      },
    },
  },
  required: ['reason', 'operations'],
};

export type CaptureOutput = {
  /** 一句话：这段有什么值得记 / 为什么没有。只进日志，不落记忆文件 */
  reason?: string;
  operations: Array<{
    // 通道二只追加（S35·G67）：capture.ts 把任何 op 一律落成 create-episode，
    // 类型保留宽松只为容忍模型偶发吐出旧形态（消费侧从宽），落盘一定是追加。
    op: 'create-episode' | 'supersede-episode' | 'correct-episode';
    oldPath?: string;
    payload: {
      scope: 'agent' | 'project';
      projectId?: string;
      type: 'user' | 'feedback' | 'project' | 'reference' | 'agent';
      title: string;
      slug: string;
      description: string;
      tags?: string[];
      content: string;
      sources?: string[];
      /** 仅当用户在对话中明确要求记住时为 true——落盘 source=user-direct，夜间整理优先保留其原话 */
      userRequested?: boolean;
    };
  }>;
};

export function buildCapturePrompt(args: {
  conversationText: string;
  recentEpisodesIndex: string;
  /** 本对话已产出的 episode（带正文，超预算部分降级成索引行）——判"是否已覆盖同一件事"用 */
  sameConversationEpisodes: string;
  convId: string;
  /** 当前活跃项目 id（无=null）——scope=project 的唯一合法 id 来源，模型不许自造 */
  currentProjectId?: string | null;
}): string {
  const sections: string[] = [];
  sections.push('## 本次新增的对话片段');
  sections.push(`（convId: ${args.convId}；只含上次抽取之后的新对话，更早的内容见下方 episode）`);
  sections.push('');
  // 截断在 capture.ts 装配消息时按消息粒度做（游标与之对齐），这里不再盲切字符
  sections.push(args.conversationText);
  sections.push('');
  // 同一对话被抽十几次是冗余最高发的场景——这批给全文，覆盖关系才判得出来
  sections.push('## 这次对话已经记下的 episode（含正文）');
  sections.push(args.sameConversationEpisodes || '_(暂无)_');
  sections.push('');
  // 索引行带 tags：tag 是精确匹配的检索维度，给模型一个现成的复用池
  sections.push('## 最近一周的相关 episode（话题可能延续自此）');
  sections.push(args.recentEpisodesIndex || '_(暂无)_');
  sections.push('');
  // 项目段紧邻结尾指令：projectId 是生成 JSON 那一刻才用得上的值，
  // 放在长对话正文之前会被稀释（最需要它时离得最远）
  sections.push('## 当前项目');
  sections.push(
    args.currentProjectId
      ? `${args.currentProjectId}——只有这段对话确实在讲这个项目时，才用 scope=project 配这个 id。`
      : '无。这次抓到的都归 scope=agent（通用记忆），不要写 projectId。',
  );
  sections.push('');
  sections.push('## 现在按守则给出 JSON 输出');
  return sections.join('\n');
}
