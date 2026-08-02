/**
 * Loop 验收标准拆解（2026-07-28 去特殊化 T1）——从「旁路 one-shot + 自建重试」改为
 * **一次只带一个工具的受限回合**：模型调 submit_checklist 提交清单（格式错走工具错误回执、
 * 同回合内自愈），拆不出可核验判据就直接用纯文本向用户反问（agent 本来就能说话），
 * 只有基础设施故障才算失败。
 *
 * 受限的三层机制（缺一不可）：
 *   ① usage='loopCompile'——submit_checklist 仅注册进该桶，factory 未分配时回落 twinMain 路由；
 *   ② restrictToolsTo=['submit_checklist']——anthropic/openaiCompatible 按白名单交集暴露；
 *   ③ claudeCode 由 restrictToolsTo 触发 builtinTools: []，结构性关断 SDK 内置工具
 *      （漏了这层模型会拿着 Read/Grep 去探索上下文，2026-07-27 现场原样重演）。
 *
 * 拆解 prompt 文案属"实现期调、留与内核同处"——纯函数（prompt）单独 TDD。
 */
import type { ChatAttachment, ChatMessage, ChecklistItem } from '@shared/types';
import type { ConversationEvent } from '@shared/agent/backend';
import { normalizeToolName } from '@shared/agent/toolName';
import { getBackendFor } from '../agent/backends';
import { singleUserTurn } from '../agent/singleUserTurn';
import { instrumentConversation } from '../debug/instrument';
import { newMessageId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { t } from '../i18n/t';

/** 总时长封顶：60s 量级 × 三次以内的工具往返。撞顶不归因（与网络故障共用中性失败文案）。 */
const COMPILE_TOTAL_BUDGET_MS = 180_000;
/** 回合内 submit_checklist 尝试次数封顶（含校验失败的）——防失控，正常自愈一两次就该成。 */
const MAX_SUBMIT_ATTEMPTS = 4;

export const COMPILE_SYSTEM_PROMPT = `你在为一个「对照标准把活干到达标」的收敛循环准备验收标准。把用户的目标拆成一份**可核验**的清单——每项是"算达标的样子"，且必须能在干完活后、只看摊在对话里的产出与证据核对真假。拆解本身是你唯一的职责，干活是之后别的回合的事。

两种收场，选其一：
- 拆得出 → 调 submit_checklist 工具提交清单，循环随即开跑。
- 拆不出「算完成了没」的判据（目标含开放问题、纯探索、缺关键信息）→ **不要**调工具、不要硬塞空话，直接用纯文本向用户提一个具体的问题（用户会在对话里看到并回答，循环这次不开跑）。

拆的规矩：
- 目标里指代了你看不到的上下文（"继续""上一轮"之类），照字面把它当作待核验的要求写进判据——独立审查员看得到完整对话。
- 每项是一句具体、可核对的"达标判据"；颗粒度克制，宁可少而准，不要堆没法核对的空话。
- 站在"独立审查员只读对话记录"的角度写——写成他一眼能判 satisfied / pending 的样子。
- 用户附了图时，图里的关键内容要落成文字判据（具体列名、要点清单、数值）；不要写"与图一致""按图上的样式"这类指着图说话的判据——审查员只读对话文本、看不到图，指图判据他永远判不了。`;
// 上面最后一条不只是迁就审查员的盲区（projectTurn 只抽文本）：判据要摊在卡面上给用户看、给用户
// 改，"与图一致"这种判据用户自己也核不了、改不动——验收标准本来就该是文字。所以答案不是"给审查员
// 也看图"（那还要按轮重复计费、且 loopReview 桶的模型未必支持视觉），而是拆解这一步就把图译成文字。
// 代价如实记：prompt 是劝不是拦，模型仍可能写出指图判据且无检测（表现为审查员一路判 pending 到
// 轮数上限）；不为此加正则校验（拿正则猜自然语言，脆且过度），靠真机验收那一遍看住。

/**
 * 从主对话历史投影「最近对话节选」——loop 常由进行中对话的追加指令启动（「继续」「上一轮」），
 * 光看目标原文解不了指代。纯函数。
 * 只取有正文的 user/assistant 消息（工具细节解不了指代、白费 token）；最近 6 条、每条截 400 字。
 *
 * loop-checklist 终态卡单独投影成一行摘要（目标、停在第几轮、逐项 statement 与达标状态）——
 * 卡本体 text 为空、数据在 loopCard 字段，不投影它「发『继续』」就名存实亡（中断后重启、
 * 上一个 loop 的进度只有这张卡一个出处，T3 接续通道）。
 */
export function projectContextTail(msgs: ChatMessage[]): string {
  return msgs
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.text.trim() || isFinalLoopCard(m)))
    .slice(-6)
    .map((m) => {
      if (isFinalLoopCard(m)) return projectLoopCard(m.loopCard!);
      return `${m.role === 'user' ? '用户' : '助手'}：${m.text.length > 400 ? `${m.text.slice(0, 400)}……` : m.text}`;
    })
    .join('\n');
}

/** loop 伴随卡的终态（收敛/失败/被打断）——运行中卡只广播不落盘，历史里只会有终态。 */
function isFinalLoopCard(m: ChatMessage): boolean {
  return m.kind === 'loop-checklist' && !!m.loopCard &&
    (m.loopCard.phase === 'done' || m.loopCard.phase === 'failed' || m.loopCard.phase === 'interrupted');
}

/** 终态卡 → 一行摘要（喂拆解解指代；「继续」时接续的标准从这里来）。 */
function projectLoopCard(card: {
  goal: string;
  phase: string;
  round: number;
  checklist: ChecklistItem[];
}): string {
  const items = card.checklist
    .map((it) => `${it.status === 'satisfied' ? '✓' : '✗'}${it.statement}`)
    .join('；');
  const state = card.phase === 'interrupted' ? `被打断（停在第 ${card.round} 轮）` : `第 ${card.round} 轮结束`;
  return `［上一个 Loop 的卡片］目标：${card.goal}；${state}；验收标准：${items || '（无）'}`;
}

/** 把用户目标（外加可选的对话节选）拼成拆解 prompt。纯函数。 */
export function buildCompilePrompt(goal: string, contextTail?: string): string {
  const context = contextTail?.trim()
    ? `这条目标发自一段进行中的对话。最近的对话节选（只用来解析目标里的指代，不是要你去完成里面的事）：

${contextTail}

`
    : '';
  return `${context}用户目标：

${goal}

把它拆成一份可核验的验收标准，用 submit_checklist 提交（每项一句 statement——算达标的样子，独立审查员只看对话记录就能判真假）；拆不出判据就直接向用户提问。`;
}

/** 拆解的两种合法终局：提交了清单（开跑）/ 纯文本反问（澄清，loop 不开跑）。 */
export type CompileOutcome =
  | { kind: 'checklist'; items: ChecklistItem[] }
  | { kind: 'clarify'; text: string };

/**
 * 跑一个受限拆解回合。基础设施故障（backend 持续抛错 / 撞封顶）→ 抛不归因中性文案
 * （卡片直接渲染 Error.message，网络故障与撞封顶共用，不怪目标也不错怪网络）。
 * 上游中止（用户停）原样透传，让 orchestrate 判 stopRequested。
 */
export async function compileChecklist(opts: {
  goal: string;
  agentId: string;
  conversationId: string;
  agentName: string;
  /** 最近对话节选（projectContextTail 产出）——解目标里的指代。 */
  contextTail?: string;
  /**
   * /loop 消息带的图——挂在合成 user 轮上直接进 prompt。这里没有 read_file
   * （restrictToolsTo 只留 submit_checklist），「指路 + 自读」不可用，附件是唯一通道。
   */
  attachments?: ChatAttachment[];
  /** 失败文案按 owner 语言取词（orchestrate 与 maxRounds 同一次 settings 读解析）。 */
  lang: 'zh' | 'en';
  /** 回合工作目录（orchestrate 传 agent.homePath 兜底 process.cwd()）。 */
  cwd: string;
  signal?: AbortSignal;
}): Promise<CompileOutcome> {
  const backend = await getBackendFor('loopCompile');
  const prompt = buildCompilePrompt(opts.goal, opts.contextTail);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), COMPILE_TOTAL_BUDGET_MS);
  const onAbort = () => ac.abort();
  if (opts.signal?.aborted) ac.abort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  // 工具校验通过即经此交回（纯数据，不走对话历史）；提交后到手即定局。
  let submitted: ChecklistItem[] | null = null;
  let assistantText = '';
  let resultText: string | null = null;
  let resultIsError = false;
  let submitAttempts = 0;

  try {
    const handle = backend.runConversation({
      agentId: opts.agentId,
      conversationId: opts.conversationId,
      userMessage: prompt,
      // prompt 必须同时作为 history 末尾的 user 轮：anthropic / openaiCompatible 只 replay
      // history、不读 userMessage（见 singleUserTurn 注释与 historyContract 契约闸）。
      history: singleUserTurn(opts.conversationId, prompt, opts.attachments),
      systemContext: COMPILE_SYSTEM_PROMPT,
      cwd: opts.cwd,
      abortController: ac,
      // 受限第 ②③ 层：白名单交集 + claudeCode builtinTools 关断（backends 原生消费）。
      restrictToolsTo: ['submit_checklist'],
      toolContext: {
        conversationId: opts.conversationId,
        agentId: opts.agentId,
        ownerId: getCurrentOwnerId(),
        usage: 'loopCompile',
        approvalMode: 'work', // 唯一工具是纯数据提交，无审批面
        abortSignal: ac.signal,
        onChecklistSubmit: (items) => {
          submitted = items;
        },
      },
    });
    const events = instrumentConversation(
      backend,
      {
        roundId: newMessageId(),
        conversationId: opts.conversationId,
        ownerId: getCurrentOwnerId(),
        agentId: opts.agentId,
        agentName: opts.agentName,
        source: 'loop_compile',
        userText: prompt,
      },
      handle.events,
      COMPILE_SYSTEM_PROMPT,
    );
    for await (const ev of events) {
      if (isSubmitAttempt(ev)) {
        submitAttempts += 1;
        // 撞尝试封顶还没提交成 → 掐掉回合（终局判定统一走下面的 conclude）
        if (submitAttempts > MAX_SUBMIT_ATTEMPTS && !submitted) ac.abort();
      } else if (ev.type === 'assistant_text') {
        assistantText += ev.text;
      } else if (ev.type === 'result') {
        resultText = ev.resultText;
        resultIsError = ev.isError;
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) throw e; // 用户停 loop：不是拆解失败
    if (!submitted) {
      console.warn('[loop] 验收标准拆解回合异常:', e instanceof Error ? e.message : e);
      throw new Error(t('main:loop.compileFailed', opts.lang));
    }
    // 已提交后的收尾异常不翻案——清单到手即有效
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (submitted) return { kind: 'checklist', items: submitted };
  if (opts.signal?.aborted) throw new Error('loop 拆解被用户中止');
  if (ac.signal.aborted) {
    // 内部封顶 abort（尝试次数 / 总时长）：round-trip 内核对 abort 是轮顶 break、事件流正常收束
    // （不抛、不补 result）——失败尝试夹带的说明文字这时还留在 assistantText 里，不拦住会被
    // 误判成合法反问。封顶不是文本终局，统一走不归因中性文案。
    console.warn('[loop] 验收标准拆解撞封顶（尝试 %d 次）', submitAttempts);
    throw new Error(t('main:loop.compileFailed', opts.lang));
  }
  const clarify = (resultText ?? assistantText).trim();
  if (!resultIsError && clarify) return { kind: 'clarify', text: clarify };
  console.warn('[loop] 验收标准拆解无有效终局（isError=%s, 文本长=%d）', resultIsError, clarify.length);
  throw new Error(t('main:loop.compileFailed', opts.lang));
}

/** submit_checklist 的调用事件（claude-code 下带 mcp__oru__ 前缀，按末段归一）。 */
function isSubmitAttempt(ev: ConversationEvent): boolean {
  return ev.type === 'tool_use' && normalizeToolName(ev.name) === 'submit_checklist';
}
