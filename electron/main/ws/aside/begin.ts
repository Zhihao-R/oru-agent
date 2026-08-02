/**
 * aside.begin：用户在浮层首次开口 → 创建 kind:'aside' 对话并落种子消息（技术方案 §7）。
 *
 * - 标题 = referent.label——出生即有、归档里好找回。刻意不接 autoName：
 *   它的「默认标题 + 首轮」闸门与 aside 出生形态全不匹配，强扭不如不用。
 * - 种子顺序固定：指代卡（user，必有）→ 短评（assistant，仅当用户开口前短评已飘出；
 *   用户抢话则没有，符合「不再补自评」）。
 * - 指代卡 text 用 buildAsideCommentPrompt 的回放形态——短评与短聊喂模型的指代措辞
 *   同一处维护（§5.2 与 §7 一个口径）；referent 原样落 asideReferent payload，
 *   UI 的指代卡从 payload 还原，不靠拍扁文本反猜。
 * - 截图过「评点模型」的 vision 闸（二期 §3：aside 回合喂图的就是它，落盘与消费一个口径）。
 *   闸由 router 的 asideCommentSupportsVision 算好传入——aside.begin 与 aside.addReferent
 *   共用同一道闸，本模块不重算 settings。
 * - 知情接受的边界：createConversation 成功后 appendMessage 失败会留下空/半截 aside
 *   对话（归档里可见、可删）。本地磁盘 append 失败罕见，不为它加事务补偿（克制）。
 */
import type { AsideBeginReq } from '@shared/protocol';
import type { AsideReferent, ChatAttachment, ChatMessage, Conversation } from '@shared/types';
import { newMessageId } from '@shared/ids';
import { appendMessage, createConversation } from '../../conversations/store';
import { hydrateAttachmentDisplayUrls, saveAttachments } from '../../conversations/attachments';
import { buildAsideCommentPrompt } from './comment';

/**
 * 构造一张指代卡（user 消息，kind:'aside-referent'）——aside.begin 的种子与
 * aside.addReferent 的追加卡共用这一份逻辑，避免第三份拷贝（技术方案 §7）。
 *
 * - 截图过 vision 闸（闸由 router 的 asideCommentSupportsVision 单源算好传入）；
 *   不过闸则纯文本指代卡。落盘走既有 saveAttachments（校验 + conv-images 目录），
 *   历史回放整条链天然复用。
 * - 截图链路失败 → 无图降级（§4 同一哲学）：卡照常构造——链路的失败不配阻断
 *   用户已经做出的指认。
 */
export async function buildAsideReferentCard(p: {
  agentId: string;
  conversationId: string;
  referent: AsideReferent;
  screenshot?: string;
  asideVisionOk: boolean;
}): Promise<ChatMessage> {
  const cardId = newMessageId();
  let attachments: ChatAttachment[] | undefined;
  if (p.screenshot && p.asideVisionOk) {
    try {
      attachments = await saveAttachments(p.agentId, p.conversationId, cardId, [
        {
          base64: p.screenshot,
          mediaType: 'image/png',
          filename: 'aside-screenshot.png',
          // saveAttachments 以解码后的 buffer.length 为准、不消费这个自报值——
          // 粗算即可，不为一个被忽略的字段整份解码 base64
          bytes: Math.floor((p.screenshot.length * 3) / 4),
        },
      ]);
    } catch (e) {
      console.warn(
        '[aside] 指代卡截图落盘失败（降级纯文本）:',
        e instanceof Error ? e.message : e,
      );
    }
  }
  return {
    id: cardId,
    conversationId: p.conversationId,
    role: 'user',
    kind: 'aside-referent',
    asideReferent: p.referent,
    // text 用 buildAsideCommentPrompt 的回放形态——短评与短聊喂模型的指代措辞同一处维护
    text: buildAsideCommentPrompt(p.referent),
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    attachments,
  };
}

/**
 * 创建 aside 对话 + 落种子消息。返回值原样作 aside.begin.result 响应——
 * 渲染进程拿它注册 conversationStore.byId 并灌 chatStore 桶（T12）。
 */
export async function runAsideBegin(
  req: AsideBeginReq,
  asideVisionOk: boolean,
): Promise<{ conversation: Conversation; messages: ChatMessage[] }> {
  const conversation = await createConversation({
    agentId: req.agentId,
    title: req.referent.label,
    kind: 'aside',
  });

  const messages: ChatMessage[] = [
    await buildAsideReferentCard({
      agentId: req.agentId,
      conversationId: conversation.id,
      referent: req.referent,
      screenshot: req.screenshot,
      asideVisionOk,
    }),
  ];
  if (req.comment || req.commentError) {
    messages.push({
      id: newMessageId(),
      conversationId: conversation.id,
      role: 'assistant',
      text: req.comment ?? '',
      toolCalls: [],
      // 可能与指代卡同毫秒——已核渲染端不依赖 createdAt 严格递增：浮层与 chatStore
      // 桶按数组（=JSONL 落盘）顺序展示，ChatArea 的时间拼合是稳定排序、同值保持原序
      createdAt: Date.now(),
      done: true,
      // 短评失败：空文本 + error 的种子——浮层与主对话都用既有的消息报错渲染；
      // 不可重试（重说一句话就是天然重试），主对话不出重试按钮
      ...(req.commentError ? { error: { message: req.commentError, retryable: false } } : {}),
    });
  }
  for (const msg of messages) {
    await appendMessage(req.agentId, conversation.id, msg);
  }

  // 落盘不带 displayUrl；响应出口 hydrate 出渲染端可用的 oru-conv-img:// URL
  // （taskboard.comment.send 回执与 conv.history.result 同口径）
  return {
    conversation,
    messages: messages.map(
      (m) =>
        hydrateAttachmentDisplayUrls(
          m as ChatMessage & Record<string, unknown>,
          req.agentId,
        ) as ChatMessage,
    ),
  };
}
