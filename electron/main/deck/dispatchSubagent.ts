/**
 * 派一个带 deckContext 的 subagent —— deck **创建**链路（performDeckCreate）用它跑
 * deck skill 生成 HTML。caller 只需构造 rawPlan + 调 dispatchDeckSubagent(...)。
 *
 * 注：标注的**修改**链路已交对话 LLM + artifact_finalize_submission 收尾，不再派子 agent。
 */
import type { ArtifactRecord, CodeActionProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { newProposalId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { listAgents } from '../agent/store/agents';
import { enqueue as enqueueTask } from '../tasks/queue';
import { deckTaskState } from '../tasks/subagentRunner';
import { deckNarrativePath } from './pathResolver';

type Broadcast = (ev: ServerEvent) => void;

/**
 * subagent 生成 deck 的执行 prompt。创建链路与事后生成（generate_deck）共用一处——
 * 任何"先读叙事文稿、再按 skill 铺页"的约定改动只改这里。
 */
export function buildSubagentRawPlan(args: {
  brief: string;
  deckSkillId: string;
  deckPath: string;
  sizeHint: string;
}): string {
  return `${args.brief}

请按以下步骤生成 deck：
1. 调用 \`read_file('${deckNarrativePath(args.deckPath)}')\` 读叙事文稿，作为这份 deck "讲什么 / 怎么递进 / 每段核心"的依据
2. 调用 \`read_skill('${args.deckSkillId}')\` 读取 deck skill 的 SKILL.md，按里面的引导把叙事铺成 HTML
3. 把最终 HTML 写到 \`${args.deckPath}/index.html\`
4. 用到的图片放在 \`${args.deckPath}/images/\`，HTML 里用相对路径 \`images/xxx.png\` 引用
5. 规模参考：${args.sizeHint}
6. 每生成完一页通过 \`report_progress\` 工具汇报"已完成第 N 页"

约定（Oru 钉死结构与托管契约，其余听 skill 引导）：
- **托管契约**：缩放与翻页是 Oru 在预览里**物理接管**的（不是可商量的风格偏好，故与 skill 冲突时以本条为准）。所以 deck **只写内容、不写运行时**，具体不要：① 缩放脚本（把画布 \`transform: scale\` 去适配窗口）；② 翻页/导航脚本（键盘 / 点击 / 滚轮翻页）；③ \`.stage\`/\`.deck\` 这类把所有页包起来整体缩放的容器层；④ 靠 JS 切 class 才显示的"显隐状态机"（如 \`.slide{opacity:0}\` 默认隐藏、要加某个 class 才可见）。每页 \`class="slide"\` 的块**直接挂在 \`<body>\` 下**、自身铺满画布、按顺序排列即可。独立播放需要的缩放翻页，Oru 会在用户"导出"时统一注入，**不要你在源文件里写**。
- 最小要求：每页是**一个带 \`class="slide"\` 的块**（标签 \`section\`/\`div\`/\`article\` 都行，别嵌套同名标签）；\`<head>\` 内声明设计稿尺寸 \`<meta name="oru-deck-size" content="WxH">\`（如 \`1920x1080\` / \`1024x768\` / 竖版 \`1080x1920\`）。Oru 据此按真实比例预览与复查，没声明 fallback 16:9。
- 版式与**静态视觉风格**听 skill 的引导；尺寸优先用相对设计稿的 \`px\`（画布是固定的 WxH、Oru 按它整体缩放，\`vw/vh\` 会相对实际视口、和固定画布对不上）。Oru 只兜底"分页认得出 + 画布声明 + 缩放翻页托管"，不碰风格。
- HTML 里**不**需要预先注入任何 \`data-edit-id\`（用户标注时 Oru 会动态加）。`;
}

export type DispatchResult =
  | { ok: true; proposalId: string }
  | { ok: false; reason: 'no-agent' | 'busy'; message: string };

export async function dispatchDeckSubagent(args: {
  artifactId: string;
  deckPath: string;
  deckSkillId?: string;
  /** 主对话 id——subagent chip 落到这条 chat 流 */
  conversationId: string;
  /** subagent 主对话流 chip 上的标题 */
  title: string;
  /** subagent 主对话流 chip 上的说明 */
  description: string;
  /** 主项目 id；null 表示家目录 */
  targetProjectId: string | null;
  /** 给 subagent 的执行 prompt */
  rawPlan: string;
  broadcast: Broadcast;
}): Promise<DispatchResult> {
  const { activeId: activeAgentId } = await listAgents();
  if (!activeAgentId) {
    return { ok: false, reason: 'no-agent', message: '找不到 active agent' };
  }
  const proposal: CodeActionProposal = {
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    status: 'pending',
    kind: 'code',
    targetProjectId: args.targetProjectId,
    risk: 'low',
    rollbackable: true,
    rawPlan: args.rawPlan,
    profileId: 'project-coder',
    deckContext: {
      artifactId: args.artifactId,
      deckPath: args.deckPath,
      deckSkillId: args.deckSkillId,
    },
  };
  enqueueTask({ agentId: activeAgentId, proposal, emit: args.broadcast });
  return { ok: true, proposalId: proposal.id };
}

/**
 * 据已取到的 deck 记录派 subagent 生成 deck —— 事后生成（generate_deck 工具 /
 * artifact.generateDeck handler）共用一处。复用记录里持久化的 deckSkillId，拼 rawPlan 后转
 * dispatchDeckSubagent。deck 由 caller 取好传入（两个 caller 各有自己的 not-found 响应），
 * 本函数不重复查注册表。
 *
 * 与 performDeckCreate 的首次生成区别：首次生成用提案里的 skillId、且建壳与生成在一处；
 * 事后生成 deck 已存在，只补一次派工。
 */
export async function generateDeckForArtifact(args: {
  deck: ArtifactRecord;
  conversationId: string;
  broadcast: Broadcast;
}): Promise<DispatchResult> {
  const { deck } = args;
  // 同 deck 去重（资源级：同 index.html 并发写是真冲突）：已有生成任务在跑就不再派——现状双击会排
  // 两个背靠背。去串行后无排队（deckTaskState 只返回 running | null），judgment 单一化。
  if (deckTaskState(deck.id)) {
    return { ok: false, reason: 'busy', message: '这份演示设计正在生成中' };
  }
  const { DEFAULT_DECK_SKILL_ID } = await import('./deckSkillCatalog');
  const deckSkillId = deck.deckSkillId ?? DEFAULT_DECK_SKILL_ID;
  return dispatchDeckSubagent({
    artifactId: deck.id,
    deckPath: deck.path,
    deckSkillId,
    conversationId: args.conversationId,
    title: `生成 deck ${deck.name}`,
    description: `按叙事文稿生成 ${deck.name}`,
    targetProjectId: deck.projectId,
    rawPlan: buildSubagentRawPlan({
      brief: `按叙事文稿生成演示稿「${deck.name}」。`,
      deckSkillId,
      deckPath: deck.path,
      sizeHint: '以叙事文稿的段落数为页数参考',
    }),
    broadcast: args.broadcast,
  });
}
