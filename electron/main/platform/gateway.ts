/**
 * PlatformGateway（tech design §4 / §9；S10 统一准入重构）——三方平台入站消息的编排器。全流程：
 *
 *   ① messageId 去重（重投忽略）
 *   ② 配对 / 白名单 fail-closed（陌生人零回应）
 *   ③/④ 命令分派：immediate 插队直办（/stop /mode /model /status /help）、
 *        chained 入串行链保序（/new /compress）——分层表见 commandTable
 *   ④ 入 per-sessionKey 串行链：get-or-create 会话 → admit（统一入队）
 *
 * S10 变化：串行链收窄为「解析 + 入队」一小段——链内只做 getOrCreateConversation + admit（统一准入
 * 入队），不再包住整个回合、不再 awaitNotBusy 轮询。「同来源并发不双建对话」仍是链的活；「同来源
 * 串行执行」交给统一队列的 per-conv 锁。admit（gatewayWiring 注入）把入站消息以 trigger:'user' + origin
 * 送进 steeringQueue——空闲起回合、忙时排队 / 间隙插入，与桌面消息共用同一条队列、可合并进同一回合。
 *
 * 「处理中」表情（§6）语义改为跟**消息**走（排队后可能等一阵）：入站即贴、按 origin 登记清除闭包，
 * 清除发起方在统一回合装配（消费出站完成 / 交还时按 origin 精确清）。
 *
 * 编排只依赖注入的 deps，不直接碰 runChat / electron——真实接线在 gatewayWiring.ts，本类可被纯 fake 测试。
 */
import type { MessageEvent, PlatformCommand, ProcessingHandle, SendResult, SessionSource } from '@shared/platform/message';
import type { ApprovalMode, TriggerOrigin, WhitelistEntry } from '@shared/types';
import type { ManualCompressResult } from '../agent/context/manualCompress';
import { sessionKey } from './sessionKey';
import { MessageDedup } from './dedup';
import { decideAccess, stableId } from './access';
import { t } from '../i18n/t';

export interface PlatformGatewayDeps {
  /** 配对码校验（PairingManager.tryConsume 的子集） */
  pairing: { tryConsume(code: string): boolean };
  loadWhitelist(): Promise<WhitelistEntry[]>;
  /** 原子往白名单追加一条（配对绑定）——RMW 入锁，防与设置页增删并发时丢更新（安全边界）。 */
  addToWhitelist(entry: WhitelistEntry): Promise<void>;
  /** 补录认证用户的聊天地址（原子只补缺失）——供「定时任务按人推送」定位。不注入则不补（纯 fake 测试）。 */
  backfillChatId?(id: string, userId: string, chatId: string): Promise<void>;
  /**
   * 绑定成功时抓发话人昵称（best-effort，展示用）——飞书走通讯录 API（gatewayWiring 接 adapter.fetchUserProfile）。
   * 抓不到 / 无权限 / 平台无此能力：返回 undefined，绑定照常，界面回落显示 id。不注入则一律无昵称。
   */
  resolveDisplayName?(source: SessionSource): Promise<string | undefined>;
  /** 远程默认 agent（设置页指定）；未配置返回 null */
  resolveRemoteAgentId(): Promise<string | null>;
  /** owner 有效界面语言——平台回执（配对/无默认 Oru）是配对前文案，无对话语言可判，跟 owner 界面语言。 */
  resolveLang(): Promise<'zh' | 'en'>;
  /** 按来源查/建会话，返回 convId */
  getOrCreateConversation(agentId: string, source: SessionSource, title: string): Promise<string>;
  /** 按来源只查不建，无则 null（/stop 用——尚无会话即无正在跑的轮，不该建空会话） */
  findConversation(agentId: string, source: SessionSource): Promise<string | null>;
  /** 中断正在跑的 turn（/stop） */
  abort(agentId: string, convId: string): void;
  /** 远程调挡（/mode）——改的是那个全局挡位（以设置为单一真相），并通知桌面 UI 同步 */
  setApprovalMode(agentId: string, mode: ApprovalMode): Promise<void>;
  /**
   * /new（斜杠命令补全 plan §3）——归档当前绑定会话：占闸（忙→'busy'）→ 对话级刹车 →
   * 归档 → 释闸（窗口期零星项交还）。五步封装在 gatewayWiring。不注入则回「能力未接」兜底。
   */
  archiveCurrentConversation?(agentId: string, source: SessionSource): Promise<'archived' | 'busy' | 'none'>;
  /** /compress——回合外手动压缩（manualCompress 内核代理，gatewayWiring 装配）。不注入则回兜底。 */
  compressConversation?(agentId: string, convId: string): Promise<ManualCompressResult>;
  /** /model——列全局主对话候选模型（注册清单，current 标注当前 twinMain）。不注入则回兜底。 */
  listMainModels?(): Promise<{ id: string; label: string; current: boolean }[]>;
  /** /model <编号>——切全局主对话模型（下一轮生效），返回被切到的 label 供回执。 */
  setMainModel?(id: string): Promise<string>;
  /** /status——状态快照。convId 为 null 表示尚无绑定会话。不注入则回兜底。 */
  statusInfo?(
    agentId: string,
    convId: string | null,
  ): Promise<{
    agentName: string;
    approvalMode: ApprovalMode;
    /** 当前 twinMain 的显示名；null = 默认档（OAuth 未指定模型） */
    modelLabel: string | null;
    running: boolean;
    pending: number;
  }>;
  /**
   * 统一准入（S10）：把入站消息以 trigger:'user' + origin 送进 steeringQueue——空闲起回合、忙时排队 /
   * 间隙插入。图片懒拉取 + 落盘在 admit 内于入队前做完（失败回执、不入队）。imageKeys/platformMessageId
   * 是入站图坐标。gatewayWiring 装配。
   */
  admit(args: {
    agentId: string;
    convId: string;
    source: SessionSource;
    userText: string;
    imageKeys?: string[];
    platformMessageId: string;
  }): Promise<void>;
  /** 回发文本到平台 */
  send(chatId: string, content: string): Promise<SendResult>;
  /** 给收到的消息贴「处理中」表情（§6，可选——平台无此能力时不注入）。失败返回 null。 */
  markProcessing?(chatId: string, messageId: string): Promise<ProcessingHandle | null>;
  /** 移除「处理中」表情（§6，与 markProcessing 成对）——传给登记表作清除闭包。 */
  clearProcessing?(handle: ProcessingHandle): Promise<void>;
  /**
   * 登记「处理中」表情的清除闭包（§6）：入站贴表情后按 origin 登记，清除发起方在统一回合装配
   * （消费出站完成 / 交还时）。gatewayWiring 接 channelProcessing.registerProcessing；纯 fake 测试可不注入。
   */
  registerProcessing?(origin: TriggerOrigin, clear: () => Promise<void>): void;
  /**
   * 按 origin 清「处理中」表情（§6）——入队前故障（解析对话 / admit 抛错）时兜底清除已贴的表情，
   * 否则永久悬挂。gatewayWiring 接 channelProcessing.clearProcessing；纯 fake 测试可不注入。
   */
  clearProcessingByOrigin?(origin: TriggerOrigin): Promise<void>;
  /**
   * 入站去重集的落盘路径（S11 · G07）——给定则去重跨重启存活（重启后重投仍被挡）。
   * gatewayWiring 按 owner + 平台装配；纯 fake 测试可不注入（退化为纯内存去重）。
   */
  dedupPath?: string;
}

/**
 * 挡位人类可读名的取词 key（/mode 切挡回执用）——聊天场景的短名。
 */
const MODE_NAME_KEY: Record<ApprovalMode, string> = {
  readonly: 'main:platform.modeNameReadonly',
  work: 'main:platform.modeNameWork',
  danger: 'main:platform.modeNameDanger',
};

function autoTitle(s: SessionSource): string {
  return s.platform === 'feishu' ? '飞书 · 私聊' : 'Discord · 私聊';
}

type CommandCtx = { e: MessageEvent; agentId: string; lang: 'zh' | 'en' };
/**
 * 命令分派层标记（斜杠命令补全 plan §3）——「哪些插队、哪些入链」在 commandTable 一眼可查：
 * - immediate（③ 段插队，绕过串行链）：/stop（正在跑的轮读不到新消息，刚需）；/mode /model
 *   （全局设置，无会话顺序问题，即时生效是卖点）；/help /status（只读，无一致性风险）。
 * - chained（④ 串行链，与同来源消息严格保序）：/new /compress——「/new 前的消息归旧篇、
 *   后的归新篇」这个直觉语义只有入链才能保证。
 */
type CommandLayer = 'immediate' | 'chained';
type CommandHandlers = {
  [K in PlatformCommand['kind']]: {
    layer: CommandLayer;
    run: (cmd: Extract<PlatformCommand, { kind: K }>, ctx: CommandCtx) => Promise<void>;
  };
};

/** /compress 四态 → 回执 key（与桌面 slash.compress 映射同形；两端 i18n 域不同，各收一处）。 */
function compressReceiptKey(r: ManualCompressResult): string {
  if (r.status === 'compressed') {
    return r.fallback ? 'main:platform.compressDoneFallback' : 'main:platform.compressDone';
  }
  if (r.status === 'busy') return 'main:platform.compressBusy';
  if (r.status === 'empty') {
    return r.emptyReason === 'tooShort'
      ? 'main:platform.compressEmptyTooShort'
      : 'main:platform.compressEmptyNothingNew';
  }
  return 'main:platform.compressFailed';
}

export class PlatformGateway {
  /** 入站去重集（S11 · G07）：给了 dedupPath 就跨重启存活，否则纯内存。 */
  private readonly dedup: MessageDedup;
  /** 每 sessionKey 一条串行链（get-or-create + 入队都挂这里，杜绝同来源并发双建对话） */
  private readonly chains = new Map<string, Promise<void>>();
  /**
   * 「未认证」引导回复的限频（防未绑定者刷爆 send / 撞平台限流）：每 sessionKey 冷却期内只回一次。
   * 纯内存、按发信人计（数量 ≈ 私聊过的陌生人，个人工具下极小，无需清理 timer）。
   */
  private readonly denyRepliedAt = new Map<string, number>();
  private static readonly DENY_COOLDOWN_MS = 10 * 60_000;

  constructor(private readonly deps: PlatformGatewayDeps) {
    this.dedup = new MessageDedup(500, deps.dedupPath);
  }

  async handleMessage(e: MessageEvent): Promise<void> {
    const sk = sessionKey(e.source);

    // ① 去重：平台重投同一 messageId 直接忽略（防破坏性操作执行两次）
    if (!this.dedup.admit(sk, e.messageId)) return;

    // ② fail-closed：白名单 / 配对码
    const whitelist = await this.deps.loadWhitelist();
    const decision = decideAccess(e, whitelist, this.deps.pairing);
    if (decision.kind === 'deny') {
      // 未认证：回一句引导（错码/失效码/普通消息同一句，不泄露「码对不对」防爆破）。限频防刷。
      const last = this.denyRepliedAt.get(sk) ?? 0;
      if (Date.now() - last >= PlatformGateway.DENY_COOLDOWN_MS) {
        this.denyRepliedAt.set(sk, Date.now());
        await this.deps.send(e.source.chatId, t('main:platform.notAuthenticated', await this.deps.resolveLang()));
      }
      return;
    }
    if (decision.kind === 'bind') {
      // 昵称 best-effort：抓失败不阻断绑定（界面回落显示 id）。抓取（可能数秒网络）在锁外，
      // 追加走 addToWhitelist 原子 RMW（不拿这里读到的 whitelist 拼接——那份读于本轮起点，已可能过期）。
      const displayName = await this.deps.resolveDisplayName?.(e.source).catch(() => undefined);
      await this.deps.addToWhitelist({
        id: decision.stableId,
        platform: e.source.platform,
        source: 'pairing',
        boundAt: Date.now(),
        chatId: e.source.chatId, // 绑定即捕获聊天地址，供「按人推送」定位
        ...(displayName ? { displayName } : {}),
      });
      await this.deps.send(e.source.chatId, t('main:platform.bindSuccess', await this.deps.resolveLang()));
      return;
    }

    // 放行：把该认证人的聊天地址补进白名单（旧数据 / 手动新增缺 chatId 时，首次发消息自动补——
    // 供定时任务「按人推送」定位）。前置只在缺失时才调 backfill（其内 mutate 幂等，只补缺失，
    // 并发多触发也不覆盖/不写错）——常态一条已补录的会话不再写盘。
    const meId = stableId(e.source);
    const me = whitelist.find((w) => w.id === meId || w.id === e.source.userId);
    if (me && !me.chatId && this.deps.backfillChatId) {
      await this.deps.backfillChatId(meId, e.source.userId, e.source.chatId);
    }

    // 放行：固定路由到远程默认 agent
    const agentId = await this.deps.resolveRemoteAgentId();
    if (!agentId) {
      await this.deps.send(e.source.chatId, t('main:platform.noRemoteDefault', await this.deps.resolveLang()));
      return;
    }

    // ③/④ 命令分派：按层标记各就各位——immediate 插队直办，chained 入串行链保序（理由见
    // CommandLayer 注释）。命令不贴「处理中」表情、不进 admit（回执即反馈，无回合可跟）。
    if (e.command) {
      const cmd = e.command;
      // 分派不变量：按 kind 索引到的 entry，其 run 收到的 cmd 必为对应窄类型——一次局部断言。
      const entry = this.commandTable[cmd.kind] as {
        layer: CommandLayer;
        run: (cmd: PlatformCommand, ctx: CommandCtx) => Promise<void>;
      };
      const ctx: CommandCtx = { e, agentId, lang: await this.deps.resolveLang() };
      if (entry.layer === 'immediate') {
        await entry.run(cmd, ctx);
      } else {
        // chained handler 抛错不能逃出串行链：链的 then(task, task) 会吞掉、消息又已过 dedup，
        // 用户发完命令石沉大海且重发被去重挡——兜一条失败回执（与 manualCompress 吞异常同论证）。
        this.enqueue(sk, async () => {
          try {
            await entry.run(cmd, ctx);
          } catch (err) {
            console.warn('[gateway] chained 命令执行失败:', err);
            await this.deps.send(e.source.chatId, t('main:platform.commandFailed', ctx.lang));
          }
        });
        await this.chains.get(sk);
      }
      return;
    }

    // 空内容守卫：非文本非图消息（贴纸/文件/语音等）normalize 后两样皆空——回执告知代替石沉大海。
    // 必须在 markProcessing 之前：表情登记只对会进入队列的消息做。
    if (!e.text.trim() && !e.imageKeys?.length) {
      await this.deps.send(e.source.chatId, t('main:platform.unsupportedMessage', await this.deps.resolveLang()));
      return;
    }

    // 「处理中」表情：放行即贴（§6），不等串行链——让「收到了、在干」的反馈立刻可见，即便排在队尾。
    // 按 origin 登记清除闭包；清除发起方在统一回合装配（消费出站完成 / 交还时按 origin 精确清）。
    const origin: TriggerOrigin = { platform: e.source.platform, chatId: e.source.chatId, platformMessageId: e.messageId };
    if (this.deps.markProcessing) {
      const handle = await this.deps.markProcessing(e.source.chatId, e.messageId);
      if (handle && this.deps.clearProcessing) {
        const clear = this.deps.clearProcessing;
        this.deps.registerProcessing?.(origin, () => clear(handle));
      }
    }

    // ④ 入 per-sessionKey 串行链：get-or-create + 统一入队（admit）。链只保「同来源不双建对话」；
    // 忙 / 空闲的序交给统一队列 per-conv 锁。
    this.enqueue(sk, async () => {
      try {
        const convId = await this.deps.getOrCreateConversation(agentId, e.source, autoTitle(e.source));
        await this.deps.admit({
          agentId,
          convId,
          source: e.source,
          userText: e.text,
          imageKeys: e.imageKeys,
          platformMessageId: e.messageId,
        });
      } catch (err) {
        // 入队前故障（解析对话 / admit 抛错）：清掉已贴的表情，否则永久悬挂（S10 review · M3）。
        // admit 内部图片失败自清并正常返回（不抛，走不到这里），故无双清；clearProcessing 幂等亦无害。
        await this.deps.clearProcessingByOrigin?.(origin);
        throw err;
      }
    });
    await this.chains.get(sk);
  }

  /** 把任务追加到该 sessionKey 的串行链尾（前一个跑完才跑下一个，杜绝并发双建对话）。 */
  private enqueue(sk: string, task: () => Promise<void>): void {
    const prev = this.chains.get(sk) ?? Promise.resolve();
    // then(task, task)：前一环无论成败都接着跑下一环（一条消息出错不卡死整条会话链）。
    const next = prev.then(task, task).finally(() => {
      if (this.chains.get(sk) === next) this.chains.delete(sk);
    });
    this.chains.set(sk, next);
  }

  // ─── 命令分派表与各命令 handler（③/④ 分层见 CommandLayer）─────────────────

  private readonly commandTable: CommandHandlers = {
    // /stop 必须绕过串行链直接 abort（正在跑的轮读不到新消息，只能平台层拦截）。
    stop: {
      layer: 'immediate',
      run: async (_cmd, { e, agentId, lang }) => {
        const convId = await this.deps.findConversation(agentId, e.source);
        if (convId) this.deps.abort(agentId, convId);
        await this.deps.send(e.source.chatId, t('main:platform.stopped', lang));
      },
    },
    // /mode 调挡即时生效（全局挡位、单一真相，setApprovalMode 内通知桌面 UI 同步）。
    setMode: {
      layer: 'immediate',
      run: async (cmd, { e, agentId, lang }) => {
        const mode = cmd.mode;
        if (!mode) {
          await this.deps.send(e.source.chatId, t('main:platform.modeUsage', lang));
          return;
        }
        await this.deps.setApprovalMode(agentId, mode);
        await this.deps.send(
          e.source.chatId,
          t('main:platform.modeSwitched', lang, { mode: t(MODE_NAME_KEY[mode], lang) }),
        );
      },
    },
    // /model：全局主对话模型（无会话顺序问题）。无参列清单；带编号切换，下一轮生效；
    // 参数非法回用法、超界回「编号失效」——不静默列清单（用户明明想切却被列单，是错误吞并）。
    model: {
      layer: 'immediate',
      run: async (cmd, { e, lang }) => {
        if (!this.deps.listMainModels || !this.deps.setMainModel) {
          await this.deps.send(e.source.chatId, t('main:platform.capabilityUnavailable', lang));
          return;
        }
        if (cmd.invalid) {
          await this.deps.send(e.source.chatId, t('main:platform.modelUsage', lang));
          return;
        }
        const models = await this.deps.listMainModels();
        if (models.length === 0) {
          await this.deps.send(e.source.chatId, t('main:platform.modelEmpty', lang));
          return;
        }
        if (cmd.index === null) {
          const current = models.find((m) => m.current);
          const list = models
            .map(
              (m, i) =>
                `${i + 1}. ${m.label}${m.current ? t('main:platform.modelCurrentMark', lang) : ''}`,
            )
            .join('\n');
          await this.deps.send(
            e.source.chatId,
            t('main:platform.modelList', lang, {
              current: current?.label ?? t('main:platform.statusDefaultModel', lang),
              list,
            }),
          );
          return;
        }
        // 编号↔模型映射在同一次调用内从清单取；清单展示与切换之间模型被删 → 编号失效。
        const target = models[cmd.index - 1];
        if (!target) {
          await this.deps.send(e.source.chatId, t('main:platform.modelStale', lang));
          return;
        }
        const label = await this.deps.setMainModel(target.id);
        await this.deps.send(e.source.chatId, t('main:platform.modelSwitched', lang, { label }));
      },
    },
    // /status：只读快照，无一致性风险。
    status: {
      layer: 'immediate',
      run: async (_cmd, { e, agentId, lang }) => {
        if (!this.deps.statusInfo) {
          await this.deps.send(e.source.chatId, t('main:platform.capabilityUnavailable', lang));
          return;
        }
        const convId = await this.deps.findConversation(agentId, e.source);
        const info = await this.deps.statusInfo(agentId, convId);
        const state = info.running
          ? t('main:platform.statusBusy', lang, { count: info.pending })
          : t('main:platform.statusIdle', lang);
        await this.deps.send(
          e.source.chatId,
          t('main:platform.statusBody', lang, {
            agent: info.agentName,
            mode: t(MODE_NAME_KEY[info.approvalMode], lang),
            model: info.modelLabel ?? t('main:platform.statusDefaultModel', lang),
            state,
          }),
        );
      },
    },
    // /help：纯文案。
    help: {
      layer: 'immediate',
      run: async (_cmd, { e, lang }) => {
        await this.deps.send(e.source.chatId, t('main:platform.help', lang));
      },
    },
    // /new（串行链层）：五步封装在 dep——占闸（忙→拒绝）→ 刹车 → 归档 → 释闸。
    new: {
      layer: 'chained',
      run: async (_cmd, { e, agentId, lang }) => {
        if (!this.deps.archiveCurrentConversation) {
          await this.deps.send(e.source.chatId, t('main:platform.capabilityUnavailable', lang));
          return;
        }
        const r = await this.deps.archiveCurrentConversation(agentId, e.source);
        const key =
          r === 'archived'
            ? 'main:platform.newDone'
            : r === 'busy'
              ? 'main:platform.newBusy'
              : 'main:platform.newNone';
        await this.deps.send(e.source.chatId, t(key, lang));
      },
    },
    // /compress（串行链层）：回合外手动压缩，四态如实回执。
    compress: {
      layer: 'chained',
      run: async (_cmd, { e, agentId, lang }) => {
        if (!this.deps.compressConversation) {
          await this.deps.send(e.source.chatId, t('main:platform.capabilityUnavailable', lang));
          return;
        }
        const convId = await this.deps.findConversation(agentId, e.source);
        if (!convId) {
          await this.deps.send(e.source.chatId, t('main:platform.compressNone', lang));
          return;
        }
        const r = await this.deps.compressConversation(agentId, convId);
        await this.deps.send(e.source.chatId, t(compressReceiptKey(r), lang));
      },
    },
  };
}
