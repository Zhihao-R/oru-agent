/**
 * /loop 编排层（v3 可见循环）——把「编译验收标准 + 可见干活轮 + 独立审查员」串成端到端。
 *
 * 与 v2 的根本差异：干活不再派隐藏 subagent 在后台黑箱跑，而是**在主对话流里可见地干**——
 * 每个干活轮复用主回合装配（buildMainTurnRunner.runOneTurn），消息/工具调用全可见。编排层在整个
 * loop 生命周期**持有一次对话闸**（runToken 由 /loop 入口占好传入），轮与轮之间不释闸：间隙用户
 * 消息落 steering 队列、下一干活轮开工时 pullSteering 消费（既作插话引导，也堵住「抢闸致 loop 静默死」，
 * §3.1）。审查员读主对话从 loop 起点以来的完整记录盲判（§3.3）。释闸时机只有收敛/中止/用户停。
 *
 * 停止：brake（Esc/删除/远程 /stop）经 registry.stopLoopForConversation 接管——置 stopRequested +
 * abort，当前轮中断、不起下一轮、落 user-stopped 终态（§3.2）。改标准走 registry 控制句柄、下一轮生效。
 * 运行态每轮落盘快照，重启后 boot 对账落一张纯陈列的中断卡（停在第几轮、达标到哪）——想继续就
 * 再发一条带 Loop 标记的「继续」，拆解看得到中断卡摘要（2026-07-28 去特殊化 T3：恢复路径退役，
 * 与普通对话断后重续同规矩）。
 *
 * 设计 ground truth：docs/tech/2026-07-24-loop-v3-可见循环重构实施方案.md（跨重启段由
 * docs/plans/2026-07-28-loop-去特殊化-实施plan.md 修订）。
 */
import type { Broadcast } from '../ws/server';
import type { ChatAttachment, ChatMessage, ChecklistItem, LoopCardPayload, LoopPhase } from '@shared/types';
import { newMessageId, newTaskId } from '@shared/ids';
import { getAgent } from '../agent/store/agents';
import { abortConversation } from '../agent/runner';
import { getConversation, appendMessage, readHistory } from '../conversations/store';
import { steeringQueue, steeringKey } from '../agent/steeringQueue';
import { clearProcessingForItems } from '../platform/channelProcessing';
import { getSettings } from '../projects/store';
import { resolveEffectiveLang } from '../i18n/effectiveLang';
import { buildMainTurnRunner } from '../ws/handlers/mainTurnAssembly';
import { compileChecklist, projectContextTail } from './compileChecklist';
import { makeReviewer, type ReviewTranscriptTurn } from './reviewer';
import { runLoop, type LoopControlIntents } from './runLoop';
import { registerLoop, unregisterLoop } from './registry';
import { buildRunState, saveLoopRunState, deleteLoopRunState } from './persist';

export async function runLoopOrchestration(args: {
  agentId: string;
  conversationId: string;
  goal: string;
  /** 已占好的对话闸凭据（/loop 入口占好传入，贯穿整个 loop；编排层不再自己占/释）。 */
  runToken: number;
  broadcast: Broadcast;
  /**
   * /loop 消息带的图（已落盘、与消息一同进历史）——只给拆解回合用：干活轮读完整对话历史，
   * 那条 /loop 消息自带附件，不必也不该在这里二传。
   *
   * 为什么不从下面手边的 hist 末条取（那条就是这次的 /loop 消息，contextTail 已在吃这个位置
   * 不变量）：显式传参不押在位置上——不变量哪天破了（谁在起编排前多落一条消息），取历史的写法
   * 退化成「拆解静默看不到图」，而漏传参数编译期就红。
   */
  attachments?: ChatAttachment[];
}): Promise<void> {
  const { agentId, conversationId, goal, runToken, broadcast, attachments } = args;
  const loopId = newTaskId();
  const cardId = `loopcard_${loopId}`;
  // 伴随卡是一条「同 id 反复覆盖」的消息——createdAt 固定一次，否则每次覆盖都刷新时间戳，reload 后错位。
  const createdAt = Date.now();
  const ac = new AbortController();
  let stopRequested = false; // 区分「用户主动停」与真报错

  let phase: LoopPhase = 'compiling';
  let round = 0;
  let checklist: ChecklistItem[] = [];
  const settings = await getSettings().catch(() => null);
  const maxRounds = settings?.loopMaxRounds ?? 5;
  const lang = resolveEffectiveLang(settings?.language);

  // await 后归属重检（§6，对齐 steeringTurnLoop 起循环前的同款防线）：占闸到此隔着 await
  // （调用方动态 import / 上面的 getSettings），期间用户可能已 Esc——drainUnconsumedOnAbort
  // 无条件清闸且此刻 loop 尚未注册（brake 的 stopLoopForConversation 落空、stopRequested
  // 置不上），不重检 loop 会无闸裸跑、与随后的新回合并发写同一对话。凭据失配就此打住；
  // 重检到 registerLoop 之间无 await，窗口就此闭合。
  if (!steeringQueue.isRunning(steeringKey(agentId, conversationId)) ||
      steeringQueue.runToken(steeringKey(agentId, conversationId)) !== runToken) {
    return;
  }

  // 改标准意图队列——内核轮边界单点消费（splice(0) 拉取即转移所有权）。
  const inbox: Required<LoopControlIntents> = { edits: [] };
  const pullControl = (): LoopControlIntents => ({ edits: inbox.edits.splice(0) });

  const buildCardMessage = (over?: Partial<LoopCardPayload>): ChatMessage => ({
    id: cardId,
    conversationId,
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt,
    done: phase === 'done' || phase === 'failed',
    kind: 'loop-checklist',
    loopCard: { loopId, goal, phase, round, maxRounds, checklist, ...over },
  });
  // 运行中只 emit（同 id 就地覆盖、不落盘）；终态落盘一次，保证刷新/重开对话还看得到结果。
  const emitCard = (over?: Partial<LoopCardPayload>) =>
    broadcast({ type: 'chat.loopCard', conversationId, message: buildCardMessage(over) });
  // 终态收口：endedAt 只在这里盖一次（emit 与落盘同值）——常驻条「陈列到下一条消息」靠它派生。
  const finishCard = async (over?: Partial<LoopCardPayload>): Promise<void> => {
    const final = { ...over, endedAt: Date.now() };
    emitCard(final);
    await appendMessage(agentId, conversationId, buildCardMessage(final));
  };

  // 控制句柄：WS handler / brake 按 loopId 或 conversationId 找到它投递停止 / 改标准意图。
  registerLoop({
    loopId,
    conversationId,
    stop: () => {
      stopRequested = true;
      ac.abort(); // 中断编排层的 await（如正在跑的审查）
      // 中断当前干活轮本身（§3.2「abort 当前干活轮」）——干活轮跑在主对话回合上、不观察 ac，
      // 得走对话级 abort 才能立刻停；否则卡片「停止」按钮要等整轮跑完才生效。与 Esc/brake 路径同步
      // （brakeConversation 也调 abortConversation，幂等、重复调无害）。
      abortConversation(agentId, conversationId);
    },
    requestChecklistEdit: (edit) => inbox.edits.push(edit),
  });

  // 审查员 transcript 取样的轮边界：本次 loop 每个干活轮开工前的主对话 history 长度。
  const roundStarts: number[] = [];
  const getTranscript = async (): Promise<ReviewTranscriptTurn[]> => {
    const hist = await readHistory(agentId, conversationId);
    return roundStarts.map((from, i) => {
      const to = i + 1 < roundStarts.length ? roundStarts[i + 1] : hist.length;
      return projectTurn(i + 1, hist.slice(from, to));
    });
  };

  try {
    emitCard();
    const agent = await getAgent(agentId);
    const conversation = await getConversation(agentId, conversationId);

    // 拆解：受限回合把目标拆成可核验验收标准。拆完直接开跑（v3 砍开工前确认门，跑偏靠中途改标准兜）；
    // 拆不出判据 → 反问收场：反问文本落成主对话 assistant 消息，卡落 clarify 安静终态，loop 不开跑。
    // 喂最近对话节选解目标里的指代（含中断卡摘要——「继续」的接续通道）；末尾剔掉刚落盘的
    // goal 消息本身（chat.ts 先落盘再起编排）。
    const hist = await readHistory(agentId, conversationId);
    const compiled = await compileChecklist({
      goal,
      contextTail: projectContextTail(hist.at(-1)?.role === 'user' ? hist.slice(0, -1) : hist),
      attachments,
      agentId,
      conversationId: `loop_${loopId}_compile`,
      agentName: agent.name,
      lang,
      cwd: agent.homePath || process.cwd(),
      signal: ac.signal,
    });
    if (compiled.kind === 'clarify') {
      const clarifyMsg: ChatMessage = {
        id: newMessageId(),
        conversationId,
        role: 'assistant',
        text: compiled.text,
        toolCalls: [],
        createdAt: Date.now(),
        done: true,
      };
      await appendMessage(agentId, conversationId, clarifyMsg);
      broadcast({ type: 'chat.loopClarify', conversationId, message: clarifyMsg });
      phase = 'done';
      await finishCard({ stopReason: 'clarify' });
      return;
    }
    checklist = compiled.items;

    phase = 'running';
    emitCard();

    // watchLiveTurn 关：loop 跨轮持闸、编排层自掌生命周期——干活轮不进「连发撤起」判定，
    // 否则窗口内一条无产出时的连发消息会把干活轮当可撤回合误杀（S1）。
    const runner = buildMainTurnRunner({ agentId, agent, conversation, broadcast, runToken, watchLiveTurn: false });
    const reviewer = makeReviewer({
      agentId,
      conversationId: `loop_${loopId}_review`,
      agentName: agent.name,
      getTranscript,
    });

    // 干活轮不传图：走完整对话历史，那条 /loop 消息自带（claudeCode 每轮重注同批图的代价见
    // docs/plans/2026-07-28-loop-附件支持-实施plan.md 的 T3）。
    // 跑一个可见干活轮：记 transcript 边界 → 复用主回合装配跑。间隙插话不在这里 pull——runOneTurn 内置
    // 的 drainSteering 会在工具边界按对话标准机制（现有 steering 队列，§1）消费它，喂进本轮作引导；
    // 在这里 pull 会「落盘成 user 气泡 + 再内联进 nudge」把同一句话喂 LLM 两遍。
    const runWorkTurn = async (nudge: string): Promise<void> => {
      roundStarts.push((await readHistory(agentId, conversationId)).length);
      const outcome = await runner.runOneTurn({ userText: nudge });
      // 干活轮没正常结束 → throw 透传（内核不 catch）：aborted 且 stopRequested → user-stopped；否则失败。
      if (outcome !== 'ok') throw new Error(`loop 干活轮未正常结束（${outcome}）`);
    };

    const outcome = await runLoop({
      maxRounds,
      goal,
      checklist,
      runWorkTurn: ({ nudge }) => runWorkTurn(nudge),
      review: reviewer,
      // 汇报轮：仍在持闸内跑一个可见回合（审查结果做 nudge）——失败不致命（收敛已达成）。
      runReportTurn: async ({ nudge }) => {
        const o = await runner.runOneTurn({ userText: nudge });
        if (o !== 'ok') console.warn('[loop] 汇报轮未正常结束:', o);
      },
      onProgress: (r, items) => {
        round = r;
        checklist = items;
        phase = 'running';
        emitCard();
      },
      persistSnapshot: async (snap) => {
        await saveLoopRunState(
          buildRunState({
            loopId,
            conversationId,
            agentId,
            goal,
            round: snap.round,
            checklist: snap.checklist,
            now: Date.now(),
          }),
        ).catch((e) => console.warn('[loop] 运行态快照落盘失败（不影响运行）:', e));
      },
      pullControl,
      signal: ac.signal,
    });

    checklist = outcome.checklist;
    round = outcome.rounds;
    phase = 'done';
    await finishCard({ stopReason: outcome.stopReason });
  } catch (e) {
    if (stopRequested) {
      // 用户主动停：非失败——当前轮已被打断收尾，已达标项保留，落 user-stopped 终态。
      phase = 'done';
      await finishCard({ stopReason: 'user-stopped' });
    } else {
      phase = 'failed';
      const error = e instanceof Error ? e.message : String(e);
      await finishCard({ error });
    }
  } finally {
    unregisterLoop(loopId);
    ac.abort(); // 收尾：掐掉任何仍在跑的审查
    await deleteLoopRunState(loopId).catch(() => {}); // 终态删快照（已在对话历史）
  }
}

/**
 * 编排 + 收尾三件套（catch 记日志 → finally 按 token 释闸 → 交还剩余队列 + 清渠道表情）。
 * 两个起跑入口（chat.ts 空闲直起 / mainTurnAssembly 排队转投）共用——收尾是 loop 编排的
 * 契约的一部分，收在编排侧单源，不让两个入口各抄一份漂移。
 */
export async function runLoopOrchestrationAndRelease(
  args: Parameters<typeof runLoopOrchestration>[0],
): Promise<void> {
  try {
    await runLoopOrchestration(args);
  } catch (e) {
    console.warn('[loop] 编排崩溃（不影响主对话）:', e);
  } finally {
    // 释放闸：编排期间入队的消息交还用户发落。按 token 归属释放（§6）：编排中被 Esc 清闸、
    // 新回合已起时不误清别人的闸。交还的渠道排队消息清「处理中」表情（§6：交还/清掉时清）。
    const handed =
      (await steeringQueue.handBackIfRunning(steeringKey(args.agentId, args.conversationId), args.runToken)) ?? [];
    if (handed.length > 0) {
      args.broadcast({ type: 'chat.queue.handback', conversationId: args.conversationId, items: handed });
      clearProcessingForItems(handed);
    }
  }
}

/** 把一段主对话消息投影成审查员读的一轮（主 agent 文本 + 工具调用名与结果全文）。 */
function projectTurn(round: number, msgs: ChatMessage[]): ReviewTranscriptTurn {
  const texts: string[] = [];
  const toolCalls: { name: string; detail: string }[] = [];
  for (const m of msgs) {
    if (m.role === 'user' && m.text) texts.push(`（用户插话）${m.text}`);
    else if (m.text) texts.push(m.text);
    for (const tc of m.toolCalls ?? []) {
      const detail = tc.result?.detail ?? tc.result?.persistedRef?.preview ?? tc.result?.summary ?? '';
      toolCalls.push({ name: tc.name, detail });
    }
  }
  return { round, text: texts.join('\n'), toolCalls };
}
