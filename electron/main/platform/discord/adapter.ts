/**
 * Discord adapter（tech design §3.2）——discord.js 高层 Client（自带握手/重连/心跳，不自封底层 gateway）。
 * DM only：必开 MESSAGE_CONTENT 特权 intent（否则 content 为空串，新手第一坑）+ Partials.Channel（DM 需要）。
 *
 * 副作用纪律：Client 在 disconnect 里 destroy 干净；SDK 自带重连，无需另起 timer。
 */
import { Client, GatewayIntentBits, Partials, ChannelType, Events } from 'discord.js';
import type { PlatformAdapter } from '../adapter';
import type { MessageEvent, ProcessingHandle, SendResult } from '@shared/platform/message';
import { parseCommand } from '@shared/platform/command';
import { splitMessage } from '../platformTurn';
import { classifySendFailure, sendWithRetry } from '../outboundRetry';

/** Discord「处理中」表情（§B）——👀 等价飞书 OnIt 的「收到、在处理」。 */
const PROCESSING_EMOJI = '👀';

/** discord.js Message 里我们用到的字段（结构化便于单测；真实 Message 满足此形状）。 */
interface DiscordMessageLike {
  id: string;
  content: string;
  author: { id: string; bot: boolean };
  channelId: string;
}

/** 把 Discord 消息 normalize 成统一 MessageEvent（纯函数，单测覆盖）。 */
export function normalizeDiscordMessage(m: DiscordMessageLike): MessageEvent {
  return {
    text: m.content,
    messageId: m.id,
    command: parseCommand(m.content),
    source: {
      platform: 'discord',
      chatId: m.channelId,
      chatType: 'dm',
      userId: m.author.id, // Discord user id 全局稳定，无飞书 open_id/union_id 双 ID 之分
      raw: m,
    },
  };
}

const DISCORD_MAX_MESSAGE_LEN = 2000; // Discord 单条上限（PRD）
const DISCORD_MAX_FILE_BYTES = 25 * 1024 * 1024; // 非 Nitro 上传上限（保守）
const SEGMENT_GAP_MS = 300;
const RETRY_BACKOFF_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 出站投递编排（纯函数，单测覆盖，S05 拍板口径）：分段发文本、再发文件；每份载荷经
 * sendWithRetry——明确瞬时失败（429 等）退避重投一次；Discord 消息接口无幂等键，
 * 结果未知（超时等）不盲重发（防双发），如实返回失败交上层感知。
 */
export async function deliverDiscordContent(
  sendPayload: (payload: { content: string } | { files: string[] }) => Promise<SendResult>,
  content: string,
  filePaths: string[],
  maxLen: number,
  backoff: () => Promise<void>,
  gap: () => Promise<void>,
): Promise<SendResult> {
  let lastId: string | undefined;
  const parts = splitMessage(content, maxLen);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await gap();
    const res = await sendWithRetry(() => sendPayload({ content: parts[i]! }), { idempotent: false, backoff });
    if (!res.ok) return res;
    lastId = res.messageId;
  }
  for (const path of filePaths) {
    const res = await sendWithRetry(() => sendPayload({ files: [path] }), { idempotent: false, backoff });
    if (!res.ok) return res;
    lastId = res.messageId;
  }
  return { ok: true, messageId: lastId };
}

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = 'discord' as const;
  readonly maxMessageLength = DISCORD_MAX_MESSAGE_LEN;
  readonly maxFileBytes = DISCORD_MAX_FILE_BYTES;
  // S24 · G30 本期声明 'text'：远程审批走现状「拒绝+提示」回落；按钮级（Discord Buttons + interaction）
  // 实现拆后续 session——届时只把此处改 'button' + 补三件套，channelOutbound 分流一行不动（PM 2026-07-12 定）。
  readonly approvalCapability = 'text' as const;

  private client: Client | null = null;

  constructor(private readonly cfg: { botToken: string }) {}

  async connect(onMessage: (e: MessageEvent) => Promise<void>): Promise<boolean> {
    const client = new Client({
      intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel], // DM 需要 Channel partial 才收得到
    });
    client.on(Events.MessageCreate, async (m) => {
      if (m.author.bot) return; // 防 echo / 自触发
      if (m.channel.type !== ChannelType.DM) return; // DM only（PRD 边界）
      try {
        await onMessage(normalizeDiscordMessage(m as unknown as DiscordMessageLike));
      } catch (e) {
        console.warn('[discord] onMessage 处理失败（不崩连接）:', e);
      }
    });
    this.client = client;
    await client.login(this.cfg.botToken);
    return true;
  }

  async disconnect(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  /** 给消息贴 👀「处理中」表情（§B）；任何失败返回 null（表情非关键路径，不崩 turn）。 */
  async markProcessing(chatId: string, messageId: string): Promise<ProcessingHandle | null> {
    try {
      const message = await this.fetchMessage(chatId, messageId);
      if (!message) return null;
      await message.react(PROCESSING_EMOJI);
      return { platform: 'discord', chatId, messageId, emoji: PROCESSING_EMOJI };
    } catch {
      return null;
    }
  }

  /** 移除 Oru 在该消息上贴的 👀（只删机器人自己加的，按 bot 身份移除）。 */
  async clearProcessing(handle: ProcessingHandle): Promise<void> {
    const botId = this.client?.user?.id;
    if (!botId || !handle.emoji) return;
    try {
      const message = await this.fetchMessage(handle.chatId, handle.messageId);
      await message?.reactions.cache.get(handle.emoji)?.users.remove(botId);
    } catch {
      // 尽力清干净，失败吞掉
    }
  }

  /** 取一条 DM 消息（reaction 增删共用）；取不到返回 null。 */
  private async fetchMessage(chatId: string, messageId: string) {
    const channel = await this.client?.channels.fetch(chatId);
    if (!channel?.isTextBased() || !('messages' in channel)) return null;
    return channel.messages.fetch(messageId);
  }

  async send(chatId: string, content: string, opts?: { filePaths?: string[] }): Promise<SendResult> {
    const client = this.client;
    if (!client) return { ok: false, error: 'discord 未连接', failure: 'permanent' };
    let channel;
    try {
      channel = await client.channels.fetch(chatId);
    } catch (e) {
      return { ok: false, error: `取 DM 频道失败: ${String(e)}`, failure: classifySendFailure(e) };
    }
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      return { ok: false, error: 'DM 频道不可发送', failure: 'permanent' };
    }
    const sendPayload = async (payload: { content: string } | { files: string[] }): Promise<SendResult> => {
      try {
        const sent = await channel.send(payload);
        return { ok: true, messageId: sent.id };
      } catch (e) {
        return { ok: false, error: String(e), failure: classifySendFailure(e) };
      }
    };
    return deliverDiscordContent(
      sendPayload,
      content,
      opts?.filePaths ?? [],
      this.maxMessageLength,
      () => sleep(RETRY_BACKOFF_MS),
      () => sleep(SEGMENT_GAP_MS),
    );
  }
}
