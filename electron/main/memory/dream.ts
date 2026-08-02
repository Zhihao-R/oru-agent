/**
 * dream 复盘 agent 主流程（v2：带工具的多轮 agent）
 *
 * - 收集近期 active episode 索引 + 三份档案（用户 / 项目 / 人设）作为输入
 * - 起 backend.runConversation，注册到 memoryDream 的工具让 agent 自己探查 / 落盘：
 *     读：read_memory / grep_memory / query_episodes / read_conversation
 *     写：merge_episodes（整理 episode）/ write_memory · edit_memory（升格档案：印象 + 自由分章）
 * - 消费事件流统计成 DreamRunOutcome
 *
 * 回收站清除已独立（trashCleaner，S35·G36）——dream 只做需要判断力的整理。
 * 失败不抛——dream 是 best-effort，错了下次再来。
 */
import { appendFileSync as __dbg } from 'node:fs';
import { getBackendFor } from '../agent/backends';
import { provisionAgent } from '../agent/capabilities';
import { instrumentConversation } from '../debug/instrument';
import { normalizeToolName } from '@shared/agent/toolName';
import { listAgents } from '../agent/store/agents';
import { readAgentSelf, listAllEpisodesWithSuperseded } from './store';
import { readLastDreamAt } from './dreamState';
import { readMarkdownFile } from '../fs/frontmatter';
import { userProfilePath, projectProfilePath } from './paths';
import { compressPath } from './compressedPath';
import { SNAPSHOT_BUDGET } from './snapshot';
import { writeNightNote } from './changelog';
import { buildDreamPrompt } from './dreamPrompt';
import { singleUserTurn } from '../agent/singleUserTurn';
import { withIdleWatchdog, STREAM_IDLE_TIMEOUT_MS } from '../agent/util/idleWatchdog';
import type { DreamRunOutcome } from '@shared/types';
import type { ConversationEvent } from '@shared/agent/backend';

/** episode 索引召回窗：近 30 天 */
const RECENT_WINDOW_MS = 30 * 24 * 3600_000;

export async function runDream(args: {
  ownerId: string;
  currentProjectId: string | null;
}): Promise<DreamRunOutcome> {
  const { ownerId, currentProjectId } = args;
  try {
    // 1. 找 owner 的主 agent——dream 借它的 id / homePath 起会话
    const { agents } = await listAgents();
    const agent = agents.find((a) => a.ownerId === ownerId);
    if (!agent) return { kind: 'skipped', reason: 'no-new-conversations' };

    // 2. 收集 episode 索引 + 三份档案（细节由 agent 用工具按需读）
    // 三份档案按 raw markdown body 读（自由分章文档，dream 看到完整原文，不经两段解析丢小节）
    // lastDreamAt 喂夜记当时间锚点（0=从没跑过）——和 episode/档案一样是 dream 的输入，一并读
    const [episodeIndex, userProfileText, projectProfileText, self, lastDreamAt] = await Promise.all([
      buildEpisodeIndexText(ownerId),
      readDocBody(userProfilePath(ownerId)),
      currentProjectId ? readDocBody(projectProfilePath(ownerId, currentProjectId)) : Promise.resolve(''),
      readAgentSelf(ownerId),
      readLastDreamAt(ownerId),
    ]);
    if (!episodeIndex.trim()) {
      // 没有近期 active episode 可整理——无事可做
      return { kind: 'skipped', reason: 'no-new-conversations' };
    }

    // 3. 起 dream agent
    const backend = await getBackendFor('memoryDream');
    const ready = await backend.isReady();
    if (!ready.ok) return { kind: 'failed', error: ready.hint };

    // 记忆整理走统一裁剪装配（S31·G47）：memory-curation 能力一处声明整理工具 + 守则，此处经 provisionAgent
    // 取 capabilityPrompt 当 systemContext，不再手拼 DREAM_SYSTEM_PROMPT——工具与守则单源，消除对齐税。
    // dream 不用搜索预算，searchBudgetId 占位（memory-curation 无 initRuntime 消费它）。
    const provision = await provisionAgent({
      usage: 'memoryDream',
      searchBudgetId: 'dream',
      activeProjectId: currentProjectId ?? null,
    });
    const dreamSystemContext = provision.capabilityPrompt;

    // 超软预算的档案作为「整篇重写精简」的输入信号（S35·G35）——写入侧无靶子，靠 dream 收口
    const overBudgetProfiles: string[] = [];
    const flagOverBudget = (label: string, text: string, soft: number): void => {
      if (text.length > soft) overBudgetProfiles.push(`${label}（${text.length}/${soft} 字）`);
    };
    flagOverBudget('用户档案 user/profile.md', userProfileText, SNAPSHOT_BUDGET.userProfile);
    if (currentProjectId) {
      flagOverBudget(`项目档案 projects/${currentProjectId}/profile.md`, projectProfileText, SNAPSHOT_BUDGET.projectProfile);
    }
    flagOverBudget('人设 agents/twin/self.md', self, SNAPSHOT_BUDGET.agentProfile);

    const prompt = buildDreamPrompt({
      lastDreamAt,
      now: Date.now(),
      episodeIndex,
      userProfileText: userProfileText || '_(空)_',
      projectProfileText: projectProfileText || '_(无当前项目)_',
      selfText: self,
      currentProjectId,
      overBudgetProfiles,
    });

    const abortController = new AbortController();
    const dreamConvId = `dream_${Date.now()}`;
    const handle = backend.runConversation({
      agentId: agent.id,
      conversationId: dreamConvId,
      userMessage: prompt,
      // 独立会话无历史，但 prompt 必须作为 history 末尾的 user 轮传入：anthropic /
      // openaiCompatible 后端只 replay history、不读 userMessage（见 singleUserTurn 注释）。
      history: singleUserTurn(dreamConvId, prompt),
      systemContext: dreamSystemContext,
      cwd: agent.homePath || process.cwd(),
      abortController,
      disallowedTools: provision.extraDisallowed.length ? provision.extraDisallowed : undefined,
      toolContext: {
        conversationId: dreamConvId,
        agentId: agent.id,
        ownerId,
        usage: 'memoryDream',
        approvalMode: 'work', // 后台复盘不弹审批卡片（等价旧 requireApproval=false）
        abortSignal: abortController.signal,
        ...provision.toolContextPatch,
      },
    });
    const events = instrumentConversation(
      backend,
      {
        roundId: dreamConvId,
        conversationId: dreamConvId,
        ownerId,
        agentId: agent.id,
        agentName: agent.name,
        source: 'dream',
        userText: prompt,
      },
      handle.events,
      dreamSystemContext,
    );
    let nightNote = '';
    const outcome = await summarizeDreamEvents(
      // 空闲看门狗：静默（卡死）超阈值才 abort，还在整理就不杀——缘由见 idleWatchdog.ts
      withIdleWatchdog(events, STREAM_IDLE_TIMEOUT_MS, () => abortController.abort()),
      (t) => {
        nightNote = t;
      },
    );
    // 夜记：dream 的最终回复就是面向用户的总结段（守则要求），写进 changelog 当夜小节。
    // 空跑也写——"看过一遍，没有需要整理的"同样是交代。
    if (outcome.kind === 'ok') {
      await writeNightNote(ownerId, nightNote).catch(() => {});
    }
    // 回收站清除已拆成独立每日定时程序（trashCleaner，S35·G36）——dream 不再顺带清，
    // dream 被 skip / 失败也不影响回收站按期清除。
    return outcome;
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 消费 dream agent 的事件流，按 tool_use 统计落盘动作，汇总成 outcome。
 *
 * 工具在 agent 循环里已直接 applyOps 落盘，这里只数"调了什么"——
 * 统计粒度是工具调用次数（含可能失败的），给 telemetry 用，不承担正确性。
 */
export async function summarizeDreamEvents(
  events: AsyncIterable<ConversationEvent>,
  onFinalText?: (text: string) => void,
): Promise<DreamRunOutcome> {
  let episodesMerged = 0;
  let userFactsChanged = 0;
  let projectFieldsChanged = 0;
  const profileWrites = new Set<string>();
  let errored = false;
  let sawResult = false;

  for await (const ev of events) {
    if(process.env.DREAM_DEBUG2) try{__dbg('/tmp/dream-debug2.log',JSON.stringify(ev).slice(0,1500)+'\n')}catch(e){}
    if (ev.type === 'tool_use') {
      const toolName = normalizeToolName(ev.name);
      if (toolName === 'merge_episodes') {
        const from = (ev.input as { mergeFrom?: unknown }).mergeFrom;
        episodesMerged += Array.isArray(from) ? from.length : 0;
      } else if (toolName === 'write_memory' || toolName === 'edit_memory') {
        // dream 升格档案改用主对话同款 write/edit_memory（自由分章文档）。按写入的 relPath 统计——
        // userFactsChanged / projectFieldsChanged 退化为"改了 user / project 档案的次数"，仅供日志。
        const relPath = String((ev.input as { relPath?: unknown }).relPath ?? '');
        if (relPath) {
          profileWrites.add(relPath);
          if (relPath.startsWith('user/')) userFactsChanged += 1;
          else if (relPath.startsWith('projects/')) projectFieldsChanged += 1;
        }
      }
    } else if (ev.type === 'result') {
      sawResult = true;
      if (ev.isError) errored = true;
      else onFinalText?.(ev.resultText ?? '');
    }
  }

  // 没看到终态 result（abort / 超时后流直接断）也算失败——否则会误报 ok、让调度推进 lastDreamAt
  if (errored) return { kind: 'failed', error: 'dream agent 执行报错' };
  if (!sawResult) return { kind: 'failed', error: 'dream agent 未返回终态（超时或中断）' };
  return {
    kind: 'ok',
    episodesMerged,
    userFactsChanged,
    projectFieldsChanged,
    profileWrites: [...profileWrites],
  };
}

/**
 * 收集近 30 天有改动的 active episode 索引行，mtime 倒序。
 *
 * 用固定窗而非"自上次 dream 起"：dream 是幂等整理，本次没覆盖到的下次窗口里还在；
 * 新建 / 改动的 episode mtime 必落在近 30 天内，所以固定窗天然涵盖"本次新增"。
 */
async function buildEpisodeIndexText(ownerId: string): Promise<string> {
  const eps = await listAllEpisodesWithSuperseded(ownerId, false); // 只 active
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  return eps
    .filter((e) => e.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => {
      let compressed = e.relPath;
      try {
        compressed = compressPath(e.relPath);
      } catch {
        /* 压缩失败就用原 relPath */
      }
      return `- ${compressed}: ${e.title}${e.description ? ` - ${e.description}` : ''}`;
    })
    .join('\n');
}

/** 读一份档案的 raw markdown 正文（不经两段解析，dream 看到完整原文）；文件不存在回空串 */
async function readDocBody(absPath: string): Promise<string> {
  const f = await readMarkdownFile(absPath);
  return f?.content.trim() ?? '';
}
