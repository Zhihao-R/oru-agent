/**
 * 任务评论图片 smoke
 *
 * 验目标问题本身（评论这条链路的图片处理），不重复验聊天侧已覆盖的 saveAttachments 细节：
 *   1. 纯留言带图（note.add）→ 落盘 + reply.message 带 oru-conv-img:// displayUrl + relPath 在 conv-images
 *   2. taskboard.comments 回读 → 历史消息的 attachments 被 hydrate 成 oru-conv-img:// displayUrl
 *   3. 决策 A 分叉：未配 vision 模型时评论贴图【不被拒】（与 chat.send 相反——后者会 ATTACHMENT_BAD_FORMAT）
 *   4. @oru 路径（comment.send）带图 → userMsg 同样落盘带图（喂模型时的 vision 剔除由后端负责，本层不验）
 *   5. 校验复用：9 张 → ATTACHMENT_TOO_MANY
 *
 * 注意：不配 vision 模型 + apiKey 缺省——comment.send 的异步 LLM run 会失败，但 reply（note.added）
 *       在 run 之前发出，send 即 resolve，不阻塞、不等 LLM。
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { Buffer } from 'node:buffer';
import WebSocket from 'ws';
import { startWsServer, stopWsServer } from '../../electron/main/ws/server';
import { createTask } from '../../electron/main/taskboard/store';
import { newReqId } from '@shared/ids';
import type { ClientRequestPayload, ServerEvent } from '@shared/protocol';
import type { ChatMessage, Conversation } from '@shared/types';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function send<T = ServerEvent>(ws: WebSocket, payload: ClientRequestPayload): Promise<T> {
  const reqId = newReqId();
  return new Promise<T>((resolve, reject) => {
    const onMsg = (raw: WebSocket.RawData) => {
      const ev = JSON.parse(raw.toString()) as ServerEvent;
      if (ev.reqId === reqId) {
        ws.off('message', onMsg);
        if (ev.type === 'error') reject(new Error(`${ev.code}: ${ev.message}`));
        else resolve(ev as unknown as T);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ ...payload, reqId }));
    setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout: ${payload.type}`));
    }, 8000);
  });
}

// 1x1 PNG 的标准 base64（含 magic bytes）
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const PNG = {
  base64: PNG_1X1_BASE64,
  mediaType: 'image/png' as const,
  filename: 'tiny.png',
  bytes: Buffer.from(PNG_1X1_BASE64, 'base64').length,
};

type NoteAdded = { type: 'taskboard.note.added'; message: ChatMessage };
type Comments = { type: 'taskboard.comments.result'; conversation: Conversation; messages: ChatMessage[] };

async function main(): Promise<void> {
  console.log('=== taskboard_comment_image smoke ===');

  // 不配任何 vision 模型——刻意停留在 OAuth 默认（无 vision），验证决策 A：评论贴图不被 vision 门控拦
  const task = await createTask({ title: '评论图片 smoke' }, 'you');
  const port = await startWsServer();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'file://' });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  try {
    // 懒创建评论 conv 并拿到 convId
    const comments0 = await send<Comments>(ws, { type: 'taskboard.comments', taskId: task.id });
    const convId = comments0.conversation.id;

    // case 1 + 3: 纯留言带图，未配 vision 模型也不被拒（决策 A 与 chat.send 相反）
    let added: NoteAdded | null = null;
    let rejected: Error | null = null;
    try {
      added = await send<NoteAdded>(ws, {
        type: 'taskboard.note.add',
        taskId: task.id,
        text: '给自己看的图',
        attachments: [PNG],
      });
    } catch (e) {
      rejected = e as Error;
    }
    assert(rejected === null, '未配 vision 模型时评论贴图不被拒（决策 A）', rejected?.message);
    assert(added?.message.attachments?.length === 1, 'note.added.message 带 1 张图');

    const att = added!.message.attachments![0];
    assert(att.relPath.startsWith(`${convId}-images/`), 'relPath 在评论 conv 的 images 目录下', att.relPath);
    assert(att.relPath.endsWith('.png'), 'relPath 后缀 .png', att.relPath);
    assert(
      typeof att.displayUrl === 'string' && att.displayUrl.startsWith('oru-conv-img://'),
      'note.added reply 已 hydrate oru-conv-img:// displayUrl',
      att.displayUrl,
    );
    const absPath = decodeURIComponent(new URL(att.displayUrl!).pathname);
    const stat = await fs.stat(absPath).catch(() => null);
    assert(stat !== null && stat.size > 0, '图片物理落盘成功', absPath);

    // case 2: 回读历史 → attachments 被 hydrate（落盘 jsonl 不带 displayUrl）
    const comments1 = await send<Comments>(ws, { type: 'taskboard.comments', taskId: task.id });
    const userImgMsg = comments1.messages.find(
      (m) => m.role === 'user' && (m.attachments?.length ?? 0) > 0,
    );
    assert(!!userImgMsg, '回读历史能找到含图评论');
    assert(
      userImgMsg?.attachments?.[0].displayUrl?.startsWith('oru-conv-img://') === true,
      '回读历史的 attachments 被 hydrate 成 oru-conv-img://',
      userImgMsg?.attachments?.[0].displayUrl,
    );

    // case 4: @oru 路径带图也落盘（reply 在异步 run 之前发出，不等 LLM）
    const oruAdded = await send<NoteAdded>(ws, {
      type: 'taskboard.comment.send',
      taskId: task.id,
      text: '@oru 看看这张',
      mentions: ['oru'],
      attachments: [PNG],
    });
    assert(
      oruAdded.message.attachments?.length === 1 &&
        oruAdded.message.attachments[0].displayUrl?.startsWith('oru-conv-img://') === true,
      '@oru 评论带图同样落盘 + hydrate',
      oruAdded.message.attachments?.[0].displayUrl,
    );

    // case 5: 校验复用 —— 9 张 → ATTACHMENT_TOO_MANY
    let tooMany: Error | null = null;
    try {
      await send(ws, {
        type: 'taskboard.note.add',
        taskId: task.id,
        text: '',
        attachments: Array.from({ length: 9 }, () => PNG),
      });
    } catch (e) {
      tooMany = e as Error;
    }
    assert(
      tooMany !== null && tooMany.message.startsWith('ATTACHMENT_TOO_MANY'),
      '9 张 → ATTACHMENT_TOO_MANY（复用服务端校验）',
      tooMany?.message,
    );

    // case 6: 坏格式 —— 伪造 PNG（声明 png 实为乱码字节）→ DECODE_FAIL（证明 magic-byte 校验也复用）
    let badFmt: Error | null = null;
    try {
      const fake = Buffer.from('not a real png').toString('base64');
      await send(ws, {
        type: 'taskboard.note.add',
        taskId: task.id,
        text: '',
        attachments: [{ base64: fake, mediaType: 'image/png', filename: 'fake.png', bytes: 14 }],
      });
    } catch (e) {
      badFmt = e as Error;
    }
    assert(
      badFmt !== null && badFmt.message.startsWith('ATTACHMENT_DECODE_FAIL'),
      '伪造 PNG → ATTACHMENT_DECODE_FAIL（magic-byte 校验复用）',
      badFmt?.message,
    );
  } finally {
    ws.close();
    await stopWsServer();
  }

  const failed = RESULTS.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${RESULTS.length}`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${RESULTS.length} cases`);
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke unhandled error:', e);
  process.exit(1);
});
