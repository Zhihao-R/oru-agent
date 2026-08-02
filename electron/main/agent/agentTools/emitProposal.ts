/**
 * 写类工具（bash / write_file / edit_file / manage_files / MCP 与扩展装卸 / deck）共用的
 * proposal 审批闸门。
 *
 * 信任模式（无需审批）：写操作就是一次普通工具调用——直接执行，把真实结果（命令输出 / diff）回模型。
 * 审批模式：emit 审批卡 → **同步挂起**等用户点确认 → 批准则执行同一 execute、真实结果回模型，
 * 拒绝 / 取消则回执文案。turn 在等待期间自然挂起，模型不会拿着假结果乱跑——这是旧 fire-and-forget
 * +「系统记」+ maybeResumeTurn 续跑的替代（去同步根因即「工具 emit 后立即返回假文案」，见 pendingDecision.ts）。
 *
 * needsApproval 按审批挡位（只读重构 PRD）：readonly 写类直接拒（不弹卡）、只读命令放行；
 * work 按 forceApproval（破坏性 / 覆盖 / 未授权 / 对外投递）问；danger 全放，仅火灰断路器
 * catastrophic 停下（S04 · G77：全放挡即全量授权）。挡位实时读，中途收紧立即生效（PRD 决策三）。
 * 只读挡的 web 例外（2026-07-31 PM 拍板）：只读 = 可搜索可看网页、不可改系统文件——
 * web_fetch / browser_navigate 传 readonlyPolicy:'allow'，只读挡直抓直开、不弹卡也不拒
 * （接受「注入模型把数据编进 URL 外带」这道代价，approval.html 已同步改写）。bash 外发等
 * 其余对外投递只读挡照旧硬拒。
 *
 * 持久授权免卡（S24 · G30）：forceApproval 为真后，先查提案的 grantable scope 是否全部已在持久授权
 * 清单（isGranted）——全部命中即视同已批准、不弹卡直执行；否则弹卡。用户点「始终允许」写授权由
 * settleApprovalDecision 据请求体 always 落，本函数不写授权（去除了旧 viaCard→enableBash 一次性置位）。
 *
 * 对外投递（S04 · G74）：带 delivery 的提案只读挡拒（专属文案）、工作挡弹卡（emit 端置
 * forceApproval）、全放挡放行（2026-07-10 P1 拍板）；免卡改查持久授权（{delivery} 按收件人＋渠道）。
 * 例外：web 读取（web_fetch / browser_navigate）虽带 delivery 标记，只读挡按 'allow' 放行
 * （2026-07-31 PM 拍板，见文件头）；此处的只读硬拒管的是 bash 外发等其余投递。
 */
import type { ToolContext, ToolResult } from '@shared/agent/backend';
import type { ActionProposal, FileWriteProposal } from '@shared/types';
import type { ProposalOutcome } from '@shared/proposals/outcome';
import { executeFileWriteProposal } from '../../proposals/executeFileWriteProposal';
import { findProjectByPath, getProject } from '../../projects/store';
import { maybeShowGitHint } from '../../projects/gitHint';
import { realtimeApprovalMode } from './approvalGate';
import { isGranted } from '../../proposals/grants/store';
import { isAskOverridden } from '../../proposals/behaviorPolicy/store';
import { behaviorForProposal } from '@shared/proposals/behaviors';
import { surfaceFailureText } from '../../proposals/failure';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { getSettings } from '../../projects/store';
import {
  awaitProposalDecision,
  abortProposalDecision,
  finalizeProposalExecution,
  forgetToolAwaited,
  type ProposalExecOutcome,
} from '../../proposals/pendingDecision';

/**
 * 只读挡下怎么处置一个提案（工具自声明）：
 * - `'reject'`（默认）：写类在只读挡直接拒、不弹卡（硬约束）。
 * - `'ask'`：弹卡等用户亲自批准（批了就做）——给 `mutatesEnvironment: false`、本就不受中央闸管
 *   的提案用，硬拒会让只读挡彻底做不了这件事。目前只有 `propose_deck_create` 是这一类。
 * - `'allow'`：只读挡也直接执行（2026-07-31 PM 拍板：只读 = 可搜索可看网页）——目前只有
 *   web_fetch / browser_navigate：模型自拟地址在工作挡仍弹卡，只读挡不拒不弹、直抓。
 */
export type ReadonlyPolicy = 'reject' | 'ask' | 'allow';

export async function proposeOrExecute(
  ctx: ToolContext,
  proposal: ActionProposal,
  opts: {
    approvalText: string;
    execute: () => Promise<ToolResult>;
    /** 免审批直执行时补一张留痕卡（装卸类专用；落点判据与理由见 emitTraceCard）。 */
    traceCard?: boolean;
    readonlyPolicy?: ReadonlyPolicy;
  },
): Promise<ToolResult> {
  // 当天首次改这个非 git 项目时提示（每项目每天一次）。只对真会改项目文件的提案发——
  // 「装一个 MCP server」跟这个项目有没有做版本管理无关，提示挂到那里是错位。
  if (proposal.kind === 'file.write' || proposal.kind === 'bash') {
    const hintProject =
      proposal.kind === 'file.write'
        ? await findProjectByPath(proposal.path)
        : ctx.activeProjectId
          ? await getProject(ctx.activeProjectId).catch(() => null)
          : null;
    await maybeShowGitHint(ctx, hintProject);
  }

  /** 免审批直执行的共用出口（只读挡的只读命令与 'allow' 读取 / 非 forceApproval / 持久授权免卡三处）。 */
  const executeDirectly = async (): Promise<ToolResult> => {
    if (!opts.traceCard) return opts.execute();
    try {
      const result = await opts.execute();
      await emitTraceCard(ctx, proposal, result.isError ? result.text : null);
      return result;
    } catch (e) {
      // 卡上给 owner 语言的说法；抛出去的 e 不动——回执要技术原文。
      await emitTraceCard(ctx, proposal, await surfaceText(e));
      throw e;
    }
  };

  // 挡位实时读（PRD 决策三：挡位实时生效）：中途收紧到只读，正在跑的任务下一条命令立即受限——不用 ctx.approvalMode 快照。
  const mode = await realtimeApprovalMode(ctx);
  const bash = proposal.kind === 'bash' ? proposal : undefined;

  // 只读挡（硬约束）：写类直接拒、不弹卡；只读命令放行直执行（命令能力门已取消，决策 6——
  // 只读挡下不再有「首次授权弹卡」分支）。文件写工具恒写（bash===undefined）；bash 由 isReadOnly 判。
  // readonlyPolicy 'ask'/'allow' 是工具自声明的只读挡例外（弹卡亲自批 / 直接放行，见 opts 注释）。
  if (mode === 'readonly') {
    // 'ask' 提案不在此拒——落到下方审批流弹卡，等用户亲自放行（既有行为，见 readonlyPolicy）。
    const allowedInReadonly =
      bash?.isReadOnly === true || opts.readonlyPolicy === 'ask' || opts.readonlyPolicy === 'allow';
    if (!allowedInReadonly) {
      // 对外投递专属文案（S04）：读到的东西可以被投递带走，只读挡对投递硬拒
      if (proposal.delivery?.length) {
        return {
          text: '当前是「只读」挡：这一步会向外部地址或他人送出内容（对外投递），已停下未执行。如需放行，请把分身切到「工作」挡后重试。',
        };
      }
      return {
        text: '当前是「只读」挡：这一步需要写文件或运行会改动环境的命令，已停下未执行。如需放行，请把分身切到「工作」挡后重试。',
      };
    }
    // readonlyPolicy='ask' 落下去弹卡：只读挡下这类提案要用户亲自点，不能直执行；
    // 'allow'（web 读取）与只读命令在此直执行。
    if (opts.readonlyPolicy !== 'ask') return executeDirectly();
  }

  // work / danger（'strict' 已退场）：danger 仅火灰 catastrophic 停下（S04 · G77：全放挡即
  // 全量授权；对外投递按 P1 拍板同样放行）；work 按 forceApproval。
  // readonly 走到此处只剩 readonlyPolicy='ask' 一种情形（如 deck 创建）——它必须**恒弹卡**
  // （「等用户亲自批准」是 'ask' 的语义本体），不能靠 forceApproval 表达：deck.create 在 work 挡
  // 直执行是有意的、不置 forceApproval，少了下边的显式析取，只读挡会漏成直执行。
  // 收紧覆盖（2026-07-31 策略表双向开关）：工作挡下用户把「默认不问」的行（create/modify）拨成
  // 「每次问」→ 视同 forceApproval。仅工作挡消费——策略表是工作挡概念，危险挡=全量授权不看覆盖。
  const behaviorRowId = mode === 'work' ? behaviorForProposal(proposal)?.id : undefined;
  const forceForApproval =
    mode === 'danger'
      ? bash?.catastrophic === true
      : (mode === 'readonly' && opts.readonlyPolicy === 'ask') ||
        proposal.forceApproval === true ||
        (!!behaviorRowId && (await isAskOverridden(behaviorRowId)));
  if (!forceForApproval) return executeDirectly();

  // 持久授权免卡（S24 · G30）：提案的可授权后果 scope 全部已在清单里 → 视同已批准，不弹卡直执行。
  // 「全部命中才免卡」（合取）；灾难级 / 含不可持久授权目标的提案无 grantable，永不免卡（弹卡）。
  if (proposal.grantable?.length) {
    // 外发总开关（2026-07-31 PM 拍板，默认关）：{category:sendExternal} 已授权时只顶替 delivery
    // 型 scope 的授权检查——其余后果（破坏性/覆盖/未知）仍须各自命中，合取不变量不被总开关
    // 破坏（rm && curl 复合命令不能因外发免卡连带放行 rm）。web.fetch 不在此列——其 grantable
    // 是 {webAccess} 整类，由「访问网站」自己的开关管，两轴不混。
    const sendExternalGranted = await isGranted({ kind: 'category', id: 'sendExternal' });
    const allGranted = (
      await Promise.all(
        proposal.grantable.map(async (s) =>
          s.kind === 'delivery' && sendExternalGranted ? true : await isGranted(s),
        ),
      )
    ).every(Boolean);
    if (allGranted) return executeDirectly();
  }

  // 背景 / 无 UI 场景（onProposal 未挂）：没人弹卡、没人点确认，进同步等待会死锁——
  // 维持旧语义：不执行，直接返回提案文案。
  if (!ctx.onProposal) return { text: opts.approvalText };

  // 先挂 waiter 再 emit 卡片：注册同步完成，确保 waiter 早于任何 settle 就位（避免「卡片已到、
  // 用户秒点确认，但 waiter 尚未注册」的理论窗口）。派发失败则 cancel 清理，不留死 deferred。
  const decisionPromise = awaitProposalDecision(proposal.id, ctx.abortSignal);
  try {
    await ctx.onProposal(proposal);
  } catch (e) {
    abortProposalDecision(proposal.id);
    // 派发失败：卡片从没出去、提案也永不进注册表，生命周期就此终结——释放留痕，不留孤儿标记。
    forgetToolAwaited(proposal.id);
    return {
      isError: true,
      text: `proposal 构造成功但派发失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 同步挂起等用户决定（router.proposal.execute / proposal.reject 唤醒；对话 abort 自动取消）。
  const decision = await decisionPromise;
  if (decision === 'rejected') return { text: '用户拒绝了这次操作，未执行。' };
  if (decision === 'aborted') return { text: '用户已取消，操作未执行。' };

  // 批准路径：router 已把卡片转 executing 并注册了 finalizer，真实终态在这里回报。
  // try/finally 保证抛错也回报——否则工具异常时卡片永远停在 executing。
  // isError 形态的失败（工具自判、不抛错）同样算 failed，卡片不说谎。
  // 持久授权（{destructive}/{unknown}/{overwrite}/… 的「始终允许」）由 settleApprovalDecision 据
  // 请求体 always 写入，不在此处；本函数只负责「执行 + 回报终态」。
  let outcome!: ProposalExecOutcome; // try/catch 两条路必赋值后才进 finally
  try {
    const result = await opts.execute();
    outcome = result.isError
      ? { status: 'failed', failureMessage: result.text }
      : { status: 'executed' };
    return result;
  } catch (e) {
    // 同上：卡片 failureMessage 走上屏口径，回执照旧拿技术原文。
    outcome = { status: 'failed', failureMessage: await surfaceText(e) };
    throw e;
  } finally {
    finalizeProposalExecution(proposal.id, outcome);
  }
}

/** 上屏文案：已知失败按 owner 语言取词，未知失败原样透传（见 proposals/failure）。 */
async function surfaceText(e: unknown): Promise<string> {
  const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
  return surfaceFailureText(e, lang);
}

/**
 * 环境变更类工具（MCP 三件套 / plugin 装卸升 / skill 装建改 / deck 建壳）专用薄封装。
 *
 * 在 proposeOrExecute 之上补两件收尾，六个工具一字不差：
 * - **chip**：执行完成后成败都落一条对话流痕迹（唯一落点 outcomeChip，与独立执行器共用）；
 * - **留痕卡**：免审批时另补一张只记录「做了什么」的终态卡（走审批时不补——审批卡自己就是痕迹）。
 *
 * perform 只管做事与给回执文案：真实成败在原轮回给模型，不预告一件还没发生的事。
 */
export async function proposeOrExecuteEnvChange(
  ctx: ToolContext,
  proposal: ActionProposal,
  opts: {
    approvalText: string;
    /** 真正干活；返回给模型的回执文案，以及 chip 需要的附加信息（真名 / 非致命警告）。 */
    perform: () => Promise<{ text: string; outcome?: ProposalOutcome }>;
    /** 见 ReadonlyPolicy（环境变更类只有 deck 用 'ask'；'allow' 是 web 读取专属，此处收窄防误传）。 */
    readonlyPolicy?: Exclude<ReadonlyPolicy, 'allow'>;
  },
): Promise<ToolResult> {
  return proposeOrExecute(ctx, proposal, {
    approvalText: opts.approvalText,
    traceCard: true,
    readonlyPolicy: opts.readonlyPolicy,
    execute: async () => {
      // chip 是 best-effort：写不出去只记日志，绝不冒泡把一次真实成功的安装翻转成失败
      // （与下方 emitTraceCard 同一不变量；契约层不强制，故在调用点兜住）。
      const chip = async (outcome: ProposalOutcome) =>
        ctx.onProposalOutcome?.(proposal, outcome).catch((e: unknown) =>
          console.warn('[oru.proposals] chip 回报失败（忽略，不影响执行结果）:', e),
        );
      try {
        const done = await opts.perform();
        await chip(done.outcome ?? { ok: true });
        return { text: done.text };
      } catch (e) {
        await chip({ ok: false, error: await surfaceText(e) });
        throw e;
      }
    },
  });
}

/**
 * 留痕卡：只记录「做了什么」，不承载审批（§2.4，PM 2026-07-28 拍板保留）。
 *
 * **只在未走审批分支时补**——走了审批，那张审批卡自己就是痕迹；两张同 id 的卡会重出
 * （前端 addProposal 不按 id 去重）。这个落点判据与 chip（「执行完就发」，成败都发）不同，
 * 故两者不能共用一个收尾封装。
 *
 * **恒以终态广播**——pending 且从没工具等过的卡会被判成「设置页起的卡」而交给独立执行器，
 * 那会把同一件事再做一遍。故不走 transitionProposal（它只允许从 pending 迁），而是在广播前
 * 就把对象构造成终态：留痕卡不进 proposals 注册表、不参与任何决定，「status 赋值唯一经
 * transitionProposal」那条纪律护的是决策状态机，这里不适用。
 *
 * 也不 rememberProposal：不进注册表更干净——用户误发 proposal.execute 会被
 * settleApprovalDecision 判 already-decided 挡住，不会凭空执行第二遍。
 *
 * 广播失败只记日志：一张记录卡发不出去，不该翻转一次真实成功的安装。
 */
async function emitTraceCard(
  ctx: ToolContext,
  proposal: ActionProposal,
  failureMessage: string | null,
): Promise<void> {
  if (!ctx.onProposalTrace) return;
  const card: ActionProposal = {
    ...proposal,
    trace: true,
    status: failureMessage ? 'failed' : 'executed',
    completedAt: Date.now(),
    ...(failureMessage ? { failureMessage } : {}),
  };
  try {
    await ctx.onProposalTrace(card);
  } catch (e) {
    console.warn('[oru.proposals] 留痕卡广播失败（忽略，不影响执行结果）:', e);
  }
}

/**
 * file.write 专用薄封装：批准（或信任模式）后落盘（executeFileWriteProposal）并返回 resultText。
 * write/edit/manage_files 三个工具的内联分支一字不差，收敛在此——加第四个文件写工具零成本。
 * 失败时 executeFileWriteProposal 抛错，由 backend 的 executeToolSafe 统一转 isError 回执。
 *
 * structured 只随 execute 成功返回——它的存在即「真正落盘」的事实标记（渲染层产物条 /
 * 打开按钮据此判定），审批被拒 / 只读挡拦下的回执不带。
 */
export async function proposeOrExecuteFileWrite(
  ctx: ToolContext,
  proposal: FileWriteProposal,
  opts: { approvalText: string; resultText: string; structured?: Record<string, unknown> },
): Promise<ToolResult> {
  return proposeOrExecute(ctx, proposal, {
    approvalText: opts.approvalText,
    execute: async () => {
      await executeFileWriteProposal(proposal);
      return { text: opts.resultText, structured: opts.structured };
    },
  });
}
