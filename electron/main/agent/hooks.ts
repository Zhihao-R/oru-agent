/**
 * 主对话 / 背景 Twin 的运行时上下文构造
 *
 * - buildRuntimeContext: 主对话每轮拼一块 `[运行时上下文]`，放进 systemContext.dynamicPart
 *   集中所有动态元数据：当前时间 / 当前关注项目 / 可见项目列表 / 已完成未播报任务 / 家目录说明
 * - sessionStartHandler: 仅 twinBackgroundQuery 用——背景 Twin 走独立 session，
 *   通过 SDK SessionStart hook 一次性注入项目环境（背景 Twin 不需要时间 / 任务 hint）
 *
 * 主对话不再依赖 SDK SessionStart hook——所有 backend 都从 systemContext 拿到完整运行时元数据
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '@shared/types';
import type { EngineHookHandler } from '../engine';
import { getActiveProjectId } from './activeProject';
import { rendererQuery, type DirtySetResult } from './rendererQuery';
import { tasksGateway } from './tasksGateway';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import {
  listBackgroundForConversation,
  markBackgroundAnnounced,
} from '../proposals/backgroundCommandStore';
import { listProjects, getProject } from '../projects/store';
import { buildUnreachableNote } from './mcpPrompt';
import { getByConversation as getSubmissionsByConversation, type Submission } from '../deck/submissions';
import { getTodos } from './todoStore';
import { countOpenTodos, renderTodoLines } from '@shared/todo';

/** buildPendingSubmissionHint 分流用——只读 key/kind/groupId/annotationIds。 */
type PendingSubmission = Submission;
import { resolveDeckPath } from '../deck/store';

const HOME_DIR_NOTE =
  '家目录就是当前 cwd（含 memory/ notes/ drafts/ 三个子目录），用相对路径即可';

export function buildCurrentTimeLine(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `当前时间: ${fmt.format(now)}（${tzName}）`;
}

/**
 * opts.projectId 三态语义：
 *   - undefined：caller 未指定 → fallback 到 getActiveProjectId()（默认主聊天行为）
 *   - null：显式"无项目"模式（评论场景 task.projectTag 不命中任何项目）
 *   - string：强制走该 projectId（评论场景命中具体项目）
 *
 * 不用 `??` 因为 null 是合法值——`?? getActiveProjectId()` 会让"无项目"模式
 * 退化成 fallback active，破坏评论场景上下文隔离。
 */
type ProjectIdOpts = { projectId?: string | null };

async function buildCurrentProjectInfo(opts?: ProjectIdOpts): Promise<string> {
  const id = opts && 'projectId' in opts ? opts.projectId : getActiveProjectId();
  if (!id) return '当前关注项目: 用户暂未打开任何项目';
  try {
    const p = await getProject(id);
    const hasGit = existsSync(join(p.path, '.git'));
    return [
      `当前关注项目: id=${p.id}, name=${p.name}, path=${p.path}${hasGit ? '（git 仓库）' : ''}`,
      '（调工具填 target_project_id 必须用 id，不要用 name 或 path）',
    ].join('\n');
  } catch {
    return '当前关注项目: 用户暂未打开任何项目';
  }
}

async function buildProjectInventory(opts?: ProjectIdOpts): Promise<string> {
  const { projects } = await listProjects();
  const active = opts && 'projectId' in opts ? opts.projectId : getActiveProjectId();
  if (projects.length === 0) {
    return '可见项目: 暂无（用户尚未添加任何项目）';
  }
  const lines: string[] = [`可见项目（共 ${projects.length} 个）:`];
  for (const p of projects) {
    const mark = p.id === active ? ' ←(当前关注)' : '';
    lines.push(`- id=${p.id} name=${p.name} path=${p.path}${mark}`);
  }
  return lines.join('\n');
}

/**
 * 「已完成但未播报的后台任务」hint——扫该对话的终态未播报 task，格式化成提示文本，并**立即 markAnnounced
 * 去重**（同 taskAnnouncer 的 announcedAt 去重位）。两处调用：
 * - 回合起点：buildRuntimeContext 把它并进 systemContext（系统记）。
 * - 动作边界：router 把它绑成 ConversationInput.drainBoundaryNotice，随 steering 同边界注入（纯文本系统记）。
 * markAnnounced 原子（patchTask 锁内 RMW），两处 + taskAnnouncer 都经它去重，不双注入/双播。
 */
export async function buildUnannouncedTaskHint(conversationId: string): Promise<string> {
  const { listTasksForConversation, markAnnounced } = tasksGateway();
  try {
    const tasks = await listTasksForConversation(conversationId);
    const unannounced = tasks.filter(
      // interrupted = 启动扫描认出的崩溃遗留（G18）：也算「已结束、该知会」
      (t) =>
        (t.status === 'done' || t.status === 'failed' || t.status === 'interrupted') &&
        !t.announcedAt,
    );
    if (unannounced.length === 0) return '';
    const lines = [
      '[已完成但未播报的任务]',
      '（自上次说话以来已结束。如与本轮对话相关请主动 acknowledge，不相关可忽略）',
    ];
    for (const t of unannounced) {
      lines.push(
        `- task ${t.id} (${t.proposalTitle}) 状态=${t.status}` +
          (t.summary ? `, 摘要: ${t.summary.slice(0, 200)}` : '') +
          (t.errorMessage ? `, 错误: ${t.errorMessage.slice(0, 200)}` : ''),
      );
      // 立即标记 announced，避免下一轮重复注入
      await markAnnounced(t.id);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 「已结束但未播报的后台命令」hint（S19·G15）——扫该对话终态（exited/crashed）未播报的后台命令，
 * 格式化成提示并**立即 markBackgroundAnnounced 去重**（同 buildUnannouncedTaskHint 的 announcedAt 去重）。
 * 「触发带的是信号，不是全部输出」：这里只列编号+命令+退出码，完整输出留后台、模型按需 read_background_output。
 */
export async function buildUnannouncedBackgroundHint(conversationId: string): Promise<string> {
  try {
    const ownerId = getCurrentOwnerId();
    const cmds = await listBackgroundForConversation(ownerId, conversationId);
    const unannounced = cmds.filter((c) => c.status !== 'running' && !c.announcedAt);
    if (unannounced.length === 0) return '';
    const lines = [
      '[已结束但未播报的后台命令]',
      '（自上次说话以来已结束。如与本轮对话相关请主动 acknowledge，不相关可忽略；要看完整输出调 read_background_output）',
    ];
    for (const c of unannounced) {
      const outcome =
        c.status === 'crashed'
          ? '因崩溃中断'
          : c.timedOut
            ? '长时间无输出被判停滞、已终止'
            : `退出码 ${c.exitCode}`;
      lines.push(`- ${c.id}（${c.command.slice(0, 120)}）：${outcome}`);
      await markBackgroundAnnounced(ownerId, c.id);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 待收尾的提交组提示（设计 §6.3）——本对话有未完成（修改中）的标注提交组时，
 * 注入强提示让 AI 改完后必须调 artifact_finalize_submission 逐条报成败。
 *
 * 显式收尾是完成的唯一信号（绝不 isDirty 反推）。AI 没调 → 组停在「修改中」、
 * 用户可手动完成、不卡死。已完成（有 afterVersionId）的组不再提示。
 */
export async function buildPendingSubmissionHint(conversationId: string): Promise<string> {
  const pending = getSubmissionsByConversation(conversationId).filter(
    (s) => s.afterVersionId === undefined,
  );
  if (pending.length === 0) return '';
  // 按制品类型分流（项目B 第三期 Task16，护栏 C-1）：deck 走体检+收尾工具；html 旁路、手动收尾。
  // deck agentTool 对 html 路径会抛 resolveDeckPath——绝不能把 html 组喂进 deck 收尾提示。
  const blocks: string[] = [];
  const deckPending = pending.filter((s) => s.target.kind === 'deck');
  const htmlPending = pending.filter((s) => s.target.kind === 'html');
  if (deckPending.length > 0) blocks.push(await buildDeckSubmissionHint(deckPending));
  if (htmlPending.length > 0) blocks.push(buildHtmlSubmissionHint(htmlPending));
  return blocks.join('\n\n');
}

async function buildDeckSubmissionHint(pending: PendingSubmission[]): Promise<string> {
  const lines = [
    '[待收尾的制品标注]',
    '下面的标注组要你**亲自动手改**——用 `read_file` 读下面的源文件、按标注直接改它。这不是新建 deck，没有"提案 / 自动派发"这一步（别去调 `propose_deck_create` 或干等），不动手组会一直停在修改中。',
    '改完每组必须调用 `artifact_finalize_submission`（传 group_id + 逐条 results 报成败）来收尾——这是"改完了"的唯一信号。',
    '收尾时系统会对改后的 deck 做一次客观体检（失效图 / 内容溢出 / 空白页 / 结构契约）并把清单发回你：这些通常该修、**建议修掉后再次收尾**；若你判断某项该保留，带 `acknowledge_residual:true` 再次调用收尾定版、并在回复里向用户说明。改前可用 `view_slide(page)` 把改动页渲染出来自查。',
  ];
  for (const s of pending) {
    // 带上 deck 源文件的真实绝对路径——它在已注册项目根下，read_file 直接放行，
    // 省得 LLM 自己猜路径。解析不到（罕见的孤儿组）就退化成纯文案，不炸整条 hint。
    const deckPath = await resolveDeckPath(s.key).catch(() => null);
    const loc = deckPath ? `：源文件 ${join(deckPath, 'index.html')}` : '';
    lines.push(`- group ${s.groupId}（${s.annotationIds.length} 条标注待处理）${loc}`);
  }
  return lines.join('\n');
}

/**
 * html 标注组的收尾提示（项目B 第三期 Task16）——html 旁路 deck 体检、不调收尾工具：
 * AI 只管按标注改 html 源文件，改完用户在预览里核对后点「标记完成」定版（手动收尾，C-1）。
 * s.key 即 html 绝对路径（htmlTarget.key=resolve(htmlPath)）。
 */
function buildHtmlSubmissionHint(pending: PendingSubmission[]): string {
  const lines = [
    '[待修改的网页标注]',
    '下面的标注组要你**亲自动手改**——用 `read_file` 读下面的 HTML 源文件、按标注（框选截图+评论已在对话里）直接改它。这是松散网页、不是 deck：没有收尾工具这一步，你直接改源文件即可；改完用户会在预览里核对后点「标记完成」定版。不动手组会一直停在修改中。',
  ];
  for (const s of pending) {
    lines.push(`- group ${s.groupId}（${s.annotationIds.length} 条标注待处理）：源文件 ${s.key}`);
  }
  return lines.join('\n');
}

/**
 * 编辑器脏文件清单（兜底层②）——必须走 dynamicPart，不得进 stableSystemContext
 * （stable 段是 prompt cache 边界，脏清单高频变化会打爆缓存）。
 * 查询失败/超时按空处理：这层只是提示，硬闸在提案执行前的同步拉取。
 */
async function buildDirtyFilesHint(): Promise<string> {
  try {
    const { paths } = await rendererQuery<DirtySetResult>('dirtySet', {}, 500);
    if (paths.length === 0) return '';
    return [
      '[编辑器中有未保存草稿的文件]',
      ...paths.map((p) => `- ${p}`),
      '（这些文件磁盘上是旧版本：grep/脚本搜到的内容可能过时；对它们动手（脚本/写入/导出）前先请用户 ⌘S 保存）',
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * 定时任务后台执行完毕的下一回合旁白（S18·G98 余 / §7）——执行体的结果卡与产出已直接落盘承载对话
 * （不占回合），对话模型靠本旁白知悉：扫描历史尾部，最后一条「真回复」（非执行体产出 scheduled-run-output）
 * 之后若有 scheduled-run 结果卡，就框定「已在后台跑完、产出已直接发给用户、别重跑」。
 *
 * 去重不需标记：模型一开口，新 assistant 消息把这些卡隔在「上一条真回复」之前，下轮不再命中——
 * scheduled-run-output 的 kind 正是为了让扫描把执行体产出排除在「真回复」外（否则它会被当真回复、
 * 把本该注入的旁白挡掉）。纯函数——喂模型的系统记（owner 语言，非 UI 文案，不走 i18n）。
 */
export function buildScheduledRunNotice(history: ChatMessage[]): string {
  let lastRealReplyIdx = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m.role === 'assistant' && m.kind !== 'scheduled-run-output') {
      lastRealReplyIdx = i;
      break;
    }
  }
  const cards = history
    .slice(lastRealReplyIdx + 1)
    .filter((m) => m.kind === 'scheduled-run');
  if (cards.length === 0) return '';
  const lines = [
    '[定时任务后台执行完毕]',
    '（下列定时任务已在后台跑完，产出已直接发给用户、就在上方消息里。知悉即可，不要重新执行它们。）',
  ];
  for (const c of cards) {
    const title = c.scheduledRun?.title ?? '定时任务';
    const ok = c.scheduledRun?.status === 'ok';
    lines.push(`- 「${title}」${ok ? '' : '（执行失败，详情在任务页）'}`);
  }
  return lines.join('\n');
}

/**
 * 计划清单块——把这条对话还悬着的计划贴回模型眼前。
 *
 * 清单写完那一刻在工具回执里，但几十条消息之后它漂到对话深处、上下文一压缩就彻底消失：Oru 不是
 * 不肯更新，是不记得有这份清单。全部项都终结的清单不注入（它已在下一轮开始时被清掉，见 todoSweep）。
 *
 * 纯读、无副作用，不受本模块「每轮只能调用一次」那条约束（该约束来自 markAnnounced 的副作用）。
 */
async function buildTodoBlock(ownerId: string, agentId: string, conversationId: string): Promise<string> {
  const items = await getTodos(ownerId, agentId, conversationId);
  const open = countOpenTodos(items);
  if (open === 0) return '';
  // 只贴状态、不复述规则：怎么记账写在 todo 工具的描述里，两处同义表述迟早漂移
  return ['[当前计划清单]', renderTodoLines(items), `还有 ${open} 项没有结果。`].join('\n');
}

/**
 * 主对话每轮拼接的 [运行时上下文] 块——所有运行时动态元数据集中放这里。
 *
 * 包含：当前时间 + 家目录说明 + 当前关注项目 + 可见项目列表 + MCP 不可达点名
 *       + 已完成未播报任务 + 待收尾的制品标注组（提醒 AI 调 artifact_finalize_submission 收尾）
 *       + 定时任务后台执行完毕旁白（S18）+ 当前计划清单。
 *
 * 注意：内部会立即 markAnnounced 已列出的 task，因此每轮只能调用一次（runner 拼
 * systemContext 时调），不能在别处再调一次。
 *
 * opts.asideMode：aside 短聊回合跳过 MCP 不可达点名——aside 白名单没有 MCP 工具，
 * 注入会与 bare 裁剪原则自相矛盾。
 * opts.ownerId / agentId 必填（不做可选）：漏传就是静默不注入清单，这类静默失效要在编译期挡住。
 */
export async function buildRuntimeContext(
  conversationId: string,
  opts: ProjectIdOpts & {
    ownerId: string;
    agentId: string;
    history?: ChatMessage[];
    asideMode?: boolean;
  },
): Promise<string> {
  const [currentProject, inventory, mcpDownNote, taskHint, bgHint, submissionHint, dirtyHint, todoBlock] =
    await Promise.all([
      buildCurrentProjectInfo(opts),
      buildProjectInventory(opts),
      // MCP 不可达点名读探活运行时状态（启动期 starting→connected 必翻转），只能进动态层
      opts.asideMode ? Promise.resolve('') : buildUnreachableNote(),
      buildUnannouncedTaskHint(conversationId),
      buildUnannouncedBackgroundHint(conversationId),
      buildPendingSubmissionHint(conversationId),
      buildDirtyFilesHint(),
      buildTodoBlock(opts.ownerId, opts.agentId, conversationId),
    ]);
  const scheduledRunNotice = opts.history ? buildScheduledRunNotice(opts.history) : '';
  const lines: string[] = [
    '[运行时上下文]',
    buildCurrentTimeLine(),
    HOME_DIR_NOTE,
    '',
    currentProject,
    '',
    inventory,
  ];
  if (mcpDownNote) {
    lines.push('', mcpDownNote);
  }
  if (taskHint) {
    lines.push('', taskHint);
  }
  if (bgHint) {
    lines.push('', bgHint);
  }
  if (submissionHint) {
    lines.push('', submissionHint);
  }
  if (dirtyHint) {
    lines.push('', dirtyHint);
  }
  if (scheduledRunNotice) {
    lines.push('', scheduledRunNotice);
  }
  // 清单放末尾——离用户消息最近的位置，是这块里最需要被看见的一段
  if (todoBlock) {
    lines.push('', todoBlock);
  }
  return lines.join('\n');
}

/**
 * SDK SessionStart hook——仅 twinBackgroundQuery 用。
 *
 * 背景 Twin 跑独立 session、不带历史，靠这个 hook 一次性灌项目环境基线。
 * 主对话不再用本 hook（运行时元数据已经通过 systemContext 一次性给到所有 backend）。
 */
export const sessionStartHandler: EngineHookHandler = async (ctx) => {
  if (ctx.eventName !== 'SessionStart') return;
  const inv = await buildProjectInventory();
  return {
    additionalContext: ['[Oru 环境快照]', HOME_DIR_NOTE, '', inv].join('\n'),
  };
};
