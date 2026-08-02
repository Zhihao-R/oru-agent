/**
 * 飞书 adapter（tech design §3.1）——WSClient 长连接收 im.message.receive_v1、Client 发消息。
 * 只做 websocket、不做 webhook（PRD 边界）；DM only（chat_type==='p2p'）。
 *
 * 来源可信：事件来自 SDK 维护的已认证 TLS 长连接（应用凭证），攻击者无法注入伪造事件——
 * 白名单不需再做应用层消息签名（§3.1）。
 *
 * 副作用纪律（CLAUDE.md）：WSClient 在 disconnect 里 close 干净；SDK 自带重连 / 心跳，无需我们另起 timer。
 */
import { randomUUID } from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { PlatformAdapter } from '../adapter';
import type {
  ApprovalCallbackEvent,
  MessageEvent,
  ProcessingHandle,
  RemoteApprovalCard,
  SendResult,
} from '@shared/platform/message';
import { parseCommand } from '@shared/platform/command';
import { splitMessage } from '../platformTurn';
import { classifySendFailure, sendWithRetry } from '../outboundRetry';
import { MAX_INBOUND_IMAGE_BYTES } from '../../conversations/attachments';
import { addOnItReaction, removeReactions } from './reaction';
import { buildFeishuApprovalCard, buildFeishuTerminalCard } from './approvalCard';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { getSettings } from '../../projects/store';

/** 飞书 im.message.receive_v1 事件里我们用到的字段（SDK 已解包到 message / sender）。 */
interface FeishuReceiveData {
  sender?: { sender_id?: { open_id?: string; union_id?: string; user_id?: string } };
  message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string };
}

/** post 消息 content 里的一个元素（官方「接收消息内容」：段落数组的数组，按 tag 区分）。 */
type FeishuPostRun = { tag?: string; text?: string; image_key?: string };

/** card.action.trigger 事件里我们用到的字段（S24 · G30；SDK 解包后的 event 体）。 */
interface FeishuCardActionEvent {
  operator?: { open_id?: string; union_id?: string };
  action?: { value?: { proposalId?: string; action?: string } };
  context?: { open_chat_id?: string; open_message_id?: string };
}

/**
 * 按 msg_type 解析 content JSON → 文本 + 图片资源标识（纯函数）。
 * - text：取 text 字段；
 * - image：单图，content 只有 image_key；
 * - post（图文混发——输入框打字+贴图一起发就是它）：title 与 text run 拼文本、img run 收 key；
 * - 其余类型 / 非法 JSON：两样皆空，交 gateway 回「不支持」回执，不抛。
 */
function parseFeishuContent(
  messageType: string | undefined,
  raw: string | undefined,
): { text: string; imageKeys?: string[] } {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(raw ?? '{}') as Record<string, unknown>;
  } catch {
    return { text: '' };
  }
  if (messageType === 'image') {
    const key = content.image_key;
    return typeof key === 'string' && key ? { text: '', imageKeys: [key] } : { text: '' };
  }
  if (messageType === 'post') {
    const paragraphs = Array.isArray(content.content) ? (content.content as FeishuPostRun[][]) : [];
    const textParts: string[] = typeof content.title === 'string' && content.title ? [content.title] : [];
    const imageKeys: string[] = [];
    for (const para of paragraphs) {
      if (!Array.isArray(para)) continue;
      const line = para
        .filter((r) => r?.tag === 'text' && typeof r.text === 'string')
        .map((r) => r.text)
        .join('');
      if (line) textParts.push(line);
      for (const r of para) {
        if (r?.tag === 'img' && typeof r.image_key === 'string' && r.image_key) imageKeys.push(r.image_key);
      }
    }
    return { text: textParts.join('\n'), ...(imageKeys.length > 0 ? { imageKeys } : {}) };
  }
  // text 及其它带 text 字段的类型
  return { text: typeof content.text === 'string' ? content.text : '' };
}

/** 把飞书事件 normalize 成统一 MessageEvent（纯函数，单测覆盖）。 */
export function normalizeFeishuEvent(data: FeishuReceiveData): MessageEvent {
  const msg = data.message ?? {};
  const { text, imageKeys } = parseFeishuContent(msg.message_type, msg.content);
  const senderId = data.sender?.sender_id ?? {};
  return {
    text,
    messageId: msg.message_id ?? '',
    ...(imageKeys ? { imageKeys } : {}),
    command: parseCommand(text),
    source: {
      platform: 'feishu',
      chatId: msg.chat_id ?? '',
      chatType: 'dm',
      userId: senderId.open_id ?? '',
      userIdAlt: senderId.union_id,
      raw: data,
    },
  };
}

/**
 * 出站文本的消息体（纯函数，单测覆盖）——走 post 富文本的 md 标签而非 text 类型：
 * text 类型飞书不渲染 Markdown（标题/列表/分割线原样上屏），md 标签支持 CommonMark+GFM。
 * 语言 key 固定 zh_cn：post 按语言分桶只影响多语言机器人选桶，单桶时所有客户端都读它。
 * uuid 是 message.create 的幂等键（平台按它去重）——重发同 uuid 不会双投。
 */
export function buildOutboundText(chatId: string, text: string, uuid: string) {
  return {
    receive_id: chatId,
    content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } }),
    msg_type: 'post',
    uuid,
  };
}

type OutboundMessage = ReturnType<typeof buildOutboundText>;

/**
 * 发一段文本的完整策略（纯编排，单测覆盖，S05 拍板口径）：post+md 优先，带 uuid 幂等键——
 * 明确瞬时失败与结果未知（超时等）都退避后同 uuid 重发一次，平台按 uuid 去重，绝无双发；
 * 仅当 post 被平台**明确拒收**（permanent，如 "content format of the post type is incorrect"）
 * 才降级 text 原样补投一次（明确失败无双发风险；代价是鉴权类失败也多花一次注定失败的请求，
 * 可接受——比按错误串区分「格式拒收 vs 鉴权」可靠）。结果未知的最终失败不补投（防双发），
 * 如实返回失败交上层感知。
 */
export async function deliverText(
  sendOnce: (data: OutboundMessage) => Promise<SendResult>,
  chatId: string,
  text: string,
  backoff: () => Promise<void>,
  newUuid: () => string = randomUUID,
): Promise<SendResult> {
  const uuid = newUuid();
  const res = await sendWithRetry(() => sendOnce(buildOutboundText(chatId, text, uuid)), { idempotent: true, backoff });
  if (res.ok || res.failure !== 'permanent') return res;
  return sendOnce({ receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text', uuid: newUuid() });
}

// 飞书单条文本上限（PRD）。改走 post 后请求体硬限从 150KB 缩到 30KB（官方文档）：
// 8000 字符全 CJK 按 UTF-8 约 24KB + 信封几十字节，仍在限内。
const FEISHU_MAX_MESSAGE_LEN = 8000;
const FEISHU_MAX_FILE_BYTES = 30 * 1024 * 1024; // 出站文件上限（保守，实测调整）
const SEGMENT_GAP_MS = 300; // 段间最小间隔（避免撞限流）
const RETRY_BACKOFF_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FeishuAdapter implements PlatformAdapter {
  readonly platform = 'feishu' as const;
  readonly maxMessageLength = FEISHU_MAX_MESSAGE_LEN;
  readonly maxFileBytes = FEISHU_MAX_FILE_BYTES;
  readonly approvalCapability = 'button' as const; // S24 · G30：飞书互动卡片按钮级完整实现

  private ws: Lark.WSClient | null = null;
  private readonly client: Lark.Client;
  private approvalCb: ((e: ApprovalCallbackEvent) => Promise<void>) | null = null;

  constructor(private readonly cfg: { appId: string; appSecret: string }) {
    this.client = new Lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret, domain: Lark.Domain.Feishu });
  }

  async connect(onMessage: (e: MessageEvent) => Promise<void>): Promise<boolean> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: FeishuReceiveData) => {
        if (data.message?.chat_type !== 'p2p') return; // DM only（PRD 边界）
        try {
          await onMessage(normalizeFeishuEvent(data));
        } catch (e) {
          console.warn('[feishu] onMessage 处理失败（不崩连接）:', e);
        }
      },
      // 审批卡按钮回流（S24 · G30）：normalize 成 ApprovalCallbackEvent 交回调（内经门卫校验身份）。
      // 身份来自 SDK 已认证长连接的 operator，与消息入站同源可信。
      'card.action.trigger': async (data: unknown) => {
        try {
          await this.dispatchCardAction(data);
        } catch (e) {
          console.warn('[feishu] card.action 处理失败（不崩连接）:', e);
        }
      },
    });
    this.ws = new Lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn,
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    return true;
  }

  async disconnect(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }

  async send(chatId: string, content: string, opts?: { replyTo?: string; filePaths?: string[] }): Promise<SendResult> {
    let lastId: string | undefined;
    const parts = splitMessage(content, this.maxMessageLength);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await sleep(SEGMENT_GAP_MS);
      const res = await this.sendTextWithRetry(chatId, parts[i]!);
      if (!res.ok) return res;
      lastId = res.messageId;
    }
    for (const path of opts?.filePaths ?? []) {
      const res = await this.sendFile(chatId, path);
      if (!res.ok) return res; // 超限 / 失败：上层据此回降级提示（§8）
      lastId = res.messageId;
    }
    return { ok: true, messageId: lastId };
  }

  /**
   * 下载入站图片（懒拉取，gatewayWiring 在准入后的 runTurn 内调用）——
   * 消息资源 API：GET /im/v1/messages/:message_id/resources/:file_key?type=image
   * （官方文档载明 im:message 或其只读变体即可，真机 PoC 待验）。
   * 流式读入内存，超单图上限即弃（防 100MB 级资源占内存；截断保存会落半张坏图，宁可失败回执）。
   */
  async fetchImage(messageId: string, key: string): Promise<Buffer> {
    const res = await this.client.im.messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: key },
    });
    const stream = res.getReadableStream();
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > MAX_INBOUND_IMAGE_BYTES) {
        // DoS 天花板（非模型上限）：下载到此值即弃。超模型上限但在天花板内的大图照常下完，
        // 由 saveAttachments 缩放压缩到限制内（G25），不再下载即拒。
        stream.destroy();
        throw new Error(`图片超过入站下载上限 ${MAX_INBOUND_IMAGE_BYTES} 字节`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  /**
   * 取用户昵称（绑定白名单时展示用）——通讯录 contact.v3.user.get，入站 userId 是 open_id。
   * 需应用开通 `contact:user.base:readonly`；无权限 / 查不到抛错在此吞掉回 null（绑定不因此失败）。
   */
  async fetchUserProfile(userId: string): Promise<{ name?: string } | null> {
    try {
      const res = await this.client.contact.v3.user.get({
        path: { user_id: userId },
        params: { user_id_type: 'open_id' },
      });
      const name = res.data?.user?.name;
      return name ? { name } : null;
    } catch (e) {
      console.warn('[feishu] 取用户昵称失败（回落显示 id）:', e);
      return null;
    }
  }

  /** 给消息贴 OnIt「处理中」表情（§B），返回带 reaction_id 的 handle 供 clearProcessing 精确删除。 */
  async markProcessing(chatId: string, messageId: string): Promise<ProcessingHandle | null> {
    const reactionId = await addOnItReaction(this.client.im.messageReaction, messageId);
    if (!reactionId) return null;
    return { platform: 'feishu', chatId, messageId, reactionIds: [reactionId] };
  }

  /** 移除该消息上 Oru 贴的全部「处理中」表情（§B）。 */
  async clearProcessing(handle: ProcessingHandle): Promise<void> {
    await removeReactions(this.client.im.messageReaction, handle.messageId, handle.reactionIds ?? []);
  }

  // ── 远程可点审批卡（S24 · G30 下半）──────────────────────────────────────
  setApprovalCallback(cb: (e: ApprovalCallbackEvent) => Promise<void>): void {
    this.approvalCb = cb;
  }

  /** 发出审批投影卡（interactive 卡片）；失败返回 null（投影卡是副本、非承重）。 */
  async sendApprovalCard(
    chatId: string,
    card: RemoteApprovalCard,
  ): Promise<{ platformMessageId: string } | null> {
    try {
      const cardJson = buildFeishuApprovalCard(card, await this.resolveLang());
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(cardJson) },
      });
      const id = res.data?.message_id;
      return id ? { platformMessageId: id } : null;
    } catch (e) {
      console.warn('[feishu] 审批投影卡发送失败:', e);
      return null;
    }
  }

  /** 决定落定后把投影卡原地改写成终态（飞书 message.patch）。失败只 warn（本地是事实源）。 */
  async updateApprovalCardToTerminal(
    _chatId: string,
    platformMessageId: string,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    const cardJson = buildFeishuTerminalCard(decision, await this.resolveLang());
    await this.client.im.message.patch({
      path: { message_id: platformMessageId },
      data: { content: JSON.stringify(cardJson) },
    });
  }

  /** card.action.trigger 事件 → ApprovalCallbackEvent（operator 身份来自可信长连接）。 */
  private async dispatchCardAction(data: unknown): Promise<void> {
    const cb = this.approvalCb;
    if (!cb) return;
    const ev = (data as { event?: FeishuCardActionEvent } | FeishuCardActionEvent | undefined) ?? {};
    const event: FeishuCardActionEvent = 'event' in ev && ev.event ? ev.event : (ev as FeishuCardActionEvent);
    const value = event.action?.value ?? {};
    const action = value.action;
    if (!value.proposalId || (action !== 'allow' && action !== 'always' && action !== 'reject')) return;
    const op = event.operator ?? {};
    await cb({
      proposalId: value.proposalId,
      action,
      source: {
        platform: 'feishu',
        chatId: event.context?.open_chat_id ?? '',
        chatType: 'dm',
        userId: op.open_id ?? '',
        userIdAlt: op.union_id,
        raw: data,
      },
    });
  }

  private async resolveLang(): Promise<'zh' | 'en'> {
    return resolveEffectiveLang((await getSettings().catch(() => null))?.language);
  }

  /** 发一段文本：重试与降级策略在 deliverText（纯编排），这里只接线 SDK 调用与退避。 */
  private async sendTextWithRetry(chatId: string, text: string): Promise<SendResult> {
    return deliverText((data) => this.sendMessage(data), chatId, text, () => sleep(RETRY_BACKOFF_MS));
  }

  private async sendMessage(data: OutboundMessage): Promise<SendResult> {
    try {
      const res = await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data });
      return { ok: true, messageId: res.data?.message_id };
    } catch (e) {
      return { ok: false, error: String(e), failure: classifySendFailure(e) };
    }
  }

  /** 出站文件 / 图片：超 maxFileBytes 不发、回不可重试错误（上层降级「去桌面取」）。 */
  private async sendFile(chatId: string, path: string): Promise<SendResult> {
    const { statSync, readFileSync } = await import('node:fs');
    const { basename, extname } = await import('node:path');
    let bytes: number;
    try {
      bytes = statSync(path).size;
    } catch (e) {
      return { ok: false, error: `读不到文件 ${path}: ${String(e)}`, failure: 'permanent' };
    }
    if (bytes > this.maxFileBytes) {
      return { ok: false, error: `文件 ${basename(path)} 超平台上限`, failure: 'permanent' };
    }
    const ext = extname(path).slice(1).toLowerCase();
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext);
    try {
      if (isImage) {
        const up = await this.client.im.image.create({ data: { image_type: 'message', image: readFileSync(path) } });
        const res = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, content: JSON.stringify({ image_key: up?.image_key }), msg_type: 'image' },
        });
        return { ok: true, messageId: res.data?.message_id };
      }
      const up = await this.client.im.file.create({
        data: { file_type: 'stream', file_name: basename(path), file: readFileSync(path) },
      });
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify({ file_key: up?.file_key }), msg_type: 'file' },
      });
      return { ok: true, messageId: res.data?.message_id };
    } catch (e) {
      // 文件路径无自动重试（上传 create 无幂等键，且失败多为权限 / 大小类），只如实分类交上层。
      return { ok: false, error: String(e), failure: classifySendFailure(e) };
    }
  }
}
