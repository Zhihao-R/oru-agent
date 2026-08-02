/**
 * gatewayWiring（tech design §4.4 / §5 / §9；S10 统一准入重构）——把已单测的各件组装到真实
 * store / steeringQueue / 统一回合装配，产出一个配好 deps 的 PlatformGateway。
 *
 * S10 变化：入站消息不再走独立 runChatAndPersist，而是经 admit 以 trigger:'user' + origin 送进
 * steeringQueue——与桌面消息共用同一条准入队列（空闲起回合、忙时排队 / 间隙插入、可合并进同一回合）。
 * 回合装配、回发、提案远程语义都收在统一回合装配（mainTurnAssembly + channelOutbound），gatewayWiring
 * 只负责「解析对话 + 图片懒拉取 + 统一入队 + 门卫回执」。回发面下沉到 outbound.ts（deliverToChannel），
 * 平台发送器由 platformManager 连接时注册。
 *
 * 凭证只在主进程（红线 1）：adapter 拿 appId/appSecret、CLI 走密钥链，渲染进程零接触。
 */
import type { PlatformAdapter } from './adapter';
import type { SessionSource } from '@shared/platform/message';
import type { ServerEvent } from '@shared/protocol';
import type { ChatAttachment, ChatMessage, TriggerOrigin, WhitelistEntry } from '@shared/types';
import { PlatformGateway, type PlatformGatewayDeps } from './gateway';
import { buildSourceContext } from './platformTurn';
import { stableId, isWhitelisted } from './access';
import { t } from '../i18n/t';
import type { PairingManager } from './pairing';
import { newMessageId } from '@shared/ids';
import { join } from 'node:path';
import { userDir } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { getSettings, updateSettings } from '../projects/store';
import { resolveEffectiveLang } from '../i18n/effectiveLang';
import { getAgent, updateAgent, listAgents } from '../agent/store/agents';
import { getConversation, getOrCreateConversation, findConversationBySource, archiveConversation, appendMessage } from '../conversations/store';
import { detectMime, saveAttachments, MAX_IMAGES_PER_MESSAGE, MIME_TO_EXT } from '../conversations/attachments';
import { currentTwinSupportsVision } from '../agent/backends/visionSupport';
import { brakeConversation } from '../ws/handlers/brake';
import { runAssembledMainTurn } from '../ws/handlers/mainTurnAssembly';
import { restartCleanMainTurn, supersedeCleanTurn } from '../ws/handlers/restartCleanTurn';
import { pushConvState } from '../ws/handlers/convState';
import { broadcastMainChatStatus } from '../ws/handlers/backendStatusBroadcast';
import { forceCompressConversation } from '../agent/context/manualCompress';
import { steeringQueue, steeringKey } from '../agent/steeringQueue';
import { clearProcessing, clearProcessingForItems, registerProcessing } from './channelProcessing';

/** 平台 turn 没有渲染进程可广播——给需要 broadcast 的旧基建喂 noop。 */
const noopBroadcast = (_ev: ServerEvent): void => {};

/** settings 支撑（白名单 / 远程默认 agent 的读写，由设置层实现并注入）。 */
export interface PlatformRuntimeConfig {
  pairing: PairingManager;
  loadWhitelist(): Promise<WhitelistEntry[]>;
  addToWhitelist(entry: WhitelistEntry): Promise<void>;
  /** 补录认证用户聊天地址（供「定时任务按人推送」）——非承重，纯 fake 测试可不注入。 */
  backfillChatId?(id: string, userId: string, chatId: string): Promise<void>;
  resolveRemoteAgentId(): Promise<string | null>;
  /**
   * 平台会话变更信号（§4.5）——平台 turn 没有渲染进程可直接广播（emit noop），
   * 但会话级状态（新会话出现 / updatedAt 冒顶）需要进桌面列表。对称 onStatus：
   * 这里只发「某 agent 会话变了」，由持有 broadcast 的 WS 层去 pushConvState。
   * 可选：这是非承重副作用——缺它核心 turn 照跑，只是前端不实时刷（区别于其它必需字段）。
   */
  notifyConvChanged?: (agentId: string) => void;
  /**
   * 全局广播（达所有渲染端，由持有 broadcast 的 WS 层注入）——平台 turn 据此把 chat.* 事件
   * （入站 user 消息 / chat.started / 流式 / done）推给桌面，让「同一对话被飞书驱动时桌面也实时
   * 长出来」。缺它（如单测不传）则降级回原 noop：turn 照跑、只回平台、不实时刷桌面。
   * 注意：渲染端只把这些事件落进**已加载历史**的对话桶（未打开的对话不建部分桶），见 dispatchToMainChat。
   */
  broadcast?: (ev: ServerEvent) => void;
}

const toStoreSource = (s: SessionSource) => ({ platform: s.platform, chatId: s.chatId });

export function createPlatformGateway(adapter: PlatformAdapter, cfg: PlatformRuntimeConfig): PlatformGateway {
  // owner 有效界面语言（平台回执统一取法，本文件多处用）
  const resolveLang = async () => resolveEffectiveLang((await getSettings().catch(() => null))?.language);

  /**
   * 统一准入（S10）：图片懒拉取 + 落盘于入队前做完，然后以 trigger:'user' + origin 送进 steeringQueue。
   * 空闲 → started：落盘 user 消息 + 起统一回合装配（回发 / 提案远程语义收在装配层，据 origin 判）。
   * 忙 → enqueued：排队等回合末合并 / 间隙插入；广播 chat.steering.added（带 text/origin 投影）供桌面
   * 渲染渠道排队气泡。图片失败 → 回执 + 清「处理中」表情 + 不入队（不假装看过图）。
   */
  const admit: PlatformGatewayDeps['admit'] = async ({ agentId, convId, source, userText, imageKeys, platformMessageId }) => {
    const key = steeringKey(agentId, convId);
    const origin: TriggerOrigin = { platform: source.platform, chatId: source.chatId, platformMessageId };
    const clientMsgId = newMessageId();

    // 入站图懒拉取（提前到入队前——排队后才拉取会把失败拖进别人的回合）：字节直接进内存 →
    // saveAttachments（校验白名单/5MB/magic bytes + relPath 落盘），零临时文件。任一失败：如实回
    // 「图片处理失败」+ 清表情 + 不入队，不做「丢图保文」的静默降级。
    let attachments: ChatAttachment[] | undefined;
    if (imageKeys && imageKeys.length > 0) {
      if (!(await currentTwinSupportsVision())) {
        await adapter.send(source.chatId, t('main:platform.visionUnsupported', await resolveLang()));
        await clearProcessing(origin);
        return;
      }
      try {
        if (imageKeys.length > MAX_IMAGES_PER_MESSAGE) {
          throw new Error(`单条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图，本次 ${imageKeys.length} 张`);
        }
        const fetchImage = adapter.fetchImage;
        if (!fetchImage) throw new Error(`${adapter.platform} adapter 未实现 fetchImage，无法处理入站图片`);
        const items = await Promise.all(
          imageKeys.map(async (imgKey, i) => {
            const buf = await fetchImage.call(adapter, platformMessageId, imgKey);
            const mediaType = detectMime(buf);
            if (!mediaType) throw new Error(`入站图片字节无法识别为受支持的图片格式（key=${imgKey}）`);
            return {
              base64: buf.toString('base64'),
              mediaType,
              filename: `${source.platform}-image-${i + 1}.${MIME_TO_EXT[mediaType]}`,
              bytes: buf.length,
            };
          }),
        );
        // 用 clientMsgId 命名附件目录（与桌面统一）；relPath 即引用，与最终消息 id 无关。
        attachments = await saveAttachments(agentId, convId, clientMsgId, items);
      } catch (e) {
        console.warn('[platform] 入站图片处理失败，已回执跳过:', e);
        await adapter.send(source.chatId, t('main:platform.imageFailed', await resolveLang()));
        await clearProcessing(origin);
        return;
      }
    }

    // 统一准入裁决：与桌面共用同一条队列（trigger:'user' + origin，附件随项）。
    const decision = await steeringQueue.enqueueOrStart(key, {
      clientMsgId,
      text: userText,
      trigger: 'user',
      origin,
      attachments,
    });

    if (decision.action === 'enqueued') {
      // 忙时入队：等回合末合并 / 间隙插入。桌面无乐观气泡，投影 text/origin 让它渲染渠道排队气泡（§3）。
      cfg.broadcast?.({ type: 'chat.steering.added', conversationId: convId, clientMsgId, serverId: decision.serverId, text: userText, origin });
      cfg.notifyConvChanged?.(agentId);
      return;
    }

    if (decision.action === 'restart') {
      // 连发撤起重跑（S1）：在飞回合窗口内且无产出——撤掉带更全历史重跑（飞书连发「在/吗/帮我…」
      // 不再被切成三个回合）。supersede 必须同步紧随决策（首个 await 前）：决策到杀之间只隔微任务，
      // delta 溜不进来。被撤回合已贴的表情随 custody 过户进重起回合逐条清，不触发 handback。
      supersedeCleanTurn(agentId, convId, decision.token, origin);
      let agent;
      let conversation;
      try {
        agent = await getAgent(agentId);
        conversation = await getConversation(agentId, convId);
      } catch (e) {
        // 取数失败必须释放刚翻新的闸（否则对话永久卡「运行中」）+ 清表情——按 token 归属释放（§6）
        await steeringQueue.handBackIfRunning(key, decision.token);
        await clearProcessing(origin);
        throw e;
      }
      await restartCleanMainTurn({
        agentId,
        agent,
        conversation,
        broadcast: cfg.broadcast ?? noopBroadcast,
        runToken: decision.token,
        clientMsgId,
        text: userText,
        attachments,
        origin,
        // 来源段（§A）：与 started 路径同款注入
        extraDynamicSystemPrompt: buildSourceContext(source),
        onPersisted: (msg) => {
          cfg.notifyConvChanged?.(agentId);
          // 桌面若正打开这条对话：实时推「对方在平台发了什么」（chat.started 由统一装配自己广播）。
          cfg.broadcast?.({ type: 'chat.inboundUserMessage', conversationId: convId, message: msg });
        },
      });
      return;
    }

    // started：落盘起回合那条 user 消息 + 起统一回合装配（与桌面 started 同形；回发/提案远程语义
    // 收在装配层，据 firstOrigin 判）。附件必须随首轮带进装配，否则起回合带图项图片没喂给模型。
    let agent;
    let conversation;
    try {
      agent = await getAgent(agentId);
      conversation = await getConversation(agentId, convId);
    } catch (e) {
      // 取数失败必须释放刚占的闸（否则对话永久卡「运行中」，后续入站全被判忙入队、永不起回合）+ 清表情。
      // 按 token 归属释放（§6），不误清 await 间隙里可能已起的新回合。
      await steeringQueue.handBackIfRunning(key, decision.token);
      await clearProcessing(origin);
      throw e;
    }
    const userMsg: ChatMessage = {
      id: newMessageId(),
      conversationId: convId,
      role: 'user',
      text: userText,
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
      clientMsgId,
      ...(attachments ? { attachments } : {}),
    };
    try {
      await appendMessage(agentId, convId, userMsg);
    } catch (e) {
      // 落盘失败必须释放刚占的闸（同上取数失败兜底口径）+ 清表情——按 token 归属释放（§6）
      await steeringQueue.handBackIfRunning(key, decision.token);
      await clearProcessing(origin);
      throw e;
    }
    // 记忆抽取触发已收口到 runChatAndPersist 落 assistant 那刻（读历史数轮次），入站路径经
    // admit → 回合循环 → runChatAndPersist 天然覆盖，此处不再手动计数（漏计根治见本次重构）。
    cfg.notifyConvChanged?.(agentId);
    // 桌面若正打开这条对话：实时推「对方在平台发了什么」（chat.started 由统一装配自己广播）。
    cfg.broadcast?.({ type: 'chat.inboundUserMessage', conversationId: convId, message: userMsg });
    void runAssembledMainTurn({
      agentId,
      agent,
      conversation,
      broadcast: cfg.broadcast ?? noopBroadcast,
      runToken: decision.token,
      firstText: userText,
      attachments,
      firstOrigin: origin,
      // 来源段（§A）：注入「正通过飞书/Discord 远程触达 + 发话人 ID」，纠正「我们在 Oru 里」误答、带防注入守则。
      extraDynamicSystemPrompt: buildSourceContext(source),
    });
  };

  const deps: PlatformGatewayDeps = {
    // 入站去重落盘（S11 · G07）：每个 PlatformGateway 按平台各持一个 MessageDedup 实例，故每平台
    // 一份文件、各自 cap=500——高频平台不会挤占低频平台的去重窗口（也与 per-gateway 实例天然对齐，
    // 不必跨 gateway 共享一个 dedup）。去重集跨重启存活。
    dedupPath: join(userDir(getCurrentOwnerId()), `platform-dedup-${adapter.platform}.json`),
    pairing: cfg.pairing,
    loadWhitelist: cfg.loadWhitelist,
    addToWhitelist: cfg.addToWhitelist,
    backfillChatId: cfg.backfillChatId,
    // 绑定时抓昵称（best-effort，展示用）——平台支持才接（adapter 可选方法）。
    resolveDisplayName: adapter.fetchUserProfile
      ? async (source) => (await adapter.fetchUserProfile!(source.userId))?.name
      : undefined,
    resolveRemoteAgentId: cfg.resolveRemoteAgentId,
    resolveLang,
    getOrCreateConversation: async (agentId, source, title) =>
      (await getOrCreateConversation(agentId, toStoreSource(source), title)).id,
    findConversation: async (agentId, source) =>
      (await findConversationBySource(agentId, toStoreSource(source)))?.id ?? null,
    // 远程 /stop 对齐对话级刹车（G30）：停当前轮 + 该对话后台任务 / 排队派工 / 后台 bash。渠道排队项
    // 经 brakeConversation → steeringQueue 交还路被交还成桌面待处理项（S10 §3）。fire-and-forget。
    abort: (agentId, convId) => {
      void brakeConversation(agentId, convId, cfg.broadcast ?? noopBroadcast);
    },
    setApprovalMode: async (agentId, mode) => {
      await updateAgent(agentId, { approvalMode: mode });
      if (cfg.broadcast) {
        const { agents, activeId } = await listAgents();
        cfg.broadcast({ type: 'agents.state', agents, activeId });
      }
    },
    // /new（斜杠命令补全 plan §3·五步）——PM 拍板「忙时拒绝」：不 abort、不等闸。
    archiveCurrentConversation: async (agentId, source) => {
      const conv = await findConversationBySource(agentId, toStoreSource(source));
      if (!conv) return 'none';
      const key = steeringKey(agentId, conv.id);
      // 占闸：占不到 = 有回合在跑 = 忙 → 拒绝。占闸同时封死「查空闲」与「归档」之间
      // 桌面发送 / 定时触发抢闸的窗口。
      const token = await steeringQueue.beginDirectTurn(key);
      if (token === null) return 'busy';
      try {
        // 恒走对话级刹车：闸已占住、对回合是 no-op，但要它撤后台任务 / 杀后台 bash / 撤排队提案——
        // 这些的后台完成播报会往旧对话写消息（appendMessage 无条件解档），不清则归档复活。
        await brakeConversation(agentId, conv.id, cfg.broadcast ?? noopBroadcast);
        await archiveConversation(agentId, conv.id);
      } finally {
        // 释闸：占闸窗口期从他源落进旧队列的零星项交还成桌面待处理（既有 handback 机制，
        // 不重投不丢弃）；空批则直接置 idle。
        const batch = await steeringQueue.handBackIfRunning(key, token);
        if (batch && batch.length > 0) {
          cfg.broadcast?.({ type: 'chat.queue.handback', conversationId: conv.id, items: batch });
          clearProcessingForItems(batch); // 交还的渠道消息清「处理中」表情，否则永久悬挂
        }
      }
      // 桌面会话列表实时刷新（归档区冒头）——与 conv.archive 路由同款推送。
      if (cfg.broadcast) await pushConvState(agentId, null, null, cfg.broadcast);
      return 'archived';
    },
    // /compress——与桌面 conv.compress 路由同调一个内核（manualCompress）。
    compressConversation: (agentId, convId) =>
      forceCompressConversation(agentId, convId, cfg.broadcast ?? noopBroadcast),
    // /model：读注册清单 + 当前 twinMain 标注；写走 settings 单一真相 + 广播两连（models.ts 同款）。
    listMainModels: async () => {
      const settings = await getSettings();
      const current = settings.modelAssignments.twinMain;
      return settings.models.map((m) => ({ id: m.id, label: m.label, current: m.id === current }));
    },
    setMainModel: async (id) => {
      const cur = await getSettings();
      const model = cur.models.find((m) => m.id === id);
      if (!model) throw new Error(`setMainModel: 未知模型 id ${id}`);
      const updated = await updateSettings({
        modelAssignments: { ...cur.modelAssignments, twinMain: id },
      });
      cfg.broadcast?.({ type: 'modelAssignments.state', assignments: updated.modelAssignments });
      if (cfg.broadcast) await broadcastMainChatStatus(cfg.broadcast);
      return model.label;
    },
    // /status：数据源现成——steeringQueue 的闸与队列计数；模型 null 时交 gateway 如实显示「默认档」。
    statusInfo: async (agentId, convId) => {
      const agent = await getAgent(agentId);
      const settings = await getSettings();
      const modelId = settings.modelAssignments.twinMain;
      const model = modelId ? settings.models.find((m) => m.id === modelId) : undefined;
      const key = convId ? steeringKey(agentId, convId) : null;
      return {
        agentName: agent.name,
        approvalMode: agent.approvalMode,
        modelLabel: model?.label ?? null,
        running: key ? steeringQueue.isRunning(key) : false,
        pending: key ? steeringQueue.pendingCount(key) : 0,
      };
    },
    admit,
    send: (chatId, content) => adapter.send(chatId, content),
    // 「处理中」表情（§6）——平台支持才接（adapter 可选方法），bind 到具体 adapter 实例。
    markProcessing: adapter.markProcessing ? (chatId, messageId) => adapter.markProcessing!(chatId, messageId) : undefined,
    clearProcessing: adapter.clearProcessing ? (handle) => adapter.clearProcessing!(handle) : undefined,
    registerProcessing,
    clearProcessingByOrigin: clearProcessing, // 入队前故障兜底清表情（§6 / review·M3）
  };

  // 远程可点审批卡的按钮回流（S24 · G30 下半）——只认绑定主人本人的平台身份（复用消息入站白名单校验），
  // 与 approval.html:189「权限跟人走，配对绑定即本人，远程与桌面同权」一致：渠道可批灾难级、可点始终允许。
  // 决定汇入桌面/渠道共用出口 settleApprovalDecision，先到先得。非本人静默丢弃（fail-closed）。
  adapter.setApprovalCallback?.(async (e) => {
    const whitelist = await cfg.loadWhitelist().catch(() => [] as WhitelistEntry[]);
    const id = stableId(e.source);
    if (!isWhitelisted(whitelist, id, e.source.userId)) return; // 非本人 → 静默
    const { settleApprovalDecision } = await import('../ws/handlers/settleApprovalDecision');
    await settleApprovalDecision({
      proposalId: e.proposalId,
      decision: e.action === 'reject' ? 'rejected' : 'approved',
      always: e.action === 'always',
      by: { source: 'channel', platform: e.source.platform, userId: id },
      broadcast: cfg.broadcast ?? noopBroadcast,
    });
  });

  return new PlatformGateway(deps);
}
