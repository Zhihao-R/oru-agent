/**
 * v0.3 chat 图片附件 smoke
 *
 * 真协议链路：起 ws server → 配 anthropic provider + 一个 supportsVision=true 的 model →
 * 触发 chat.send 带 1 张 PNG → 验证落盘 + history 中 attachments + displayUrl + relPath。
 *
 * 后续 case 验证校验失败：缺 vision 模型时拒、单张超 5MB、9 张、bad mime、伪造 PNG、删 conv 时 rm。
 *
 * 注意：本 smoke 不会真调 LLM——chat.send 后立即 abort，不等 chat.done。
 *       验证目标限定在「主进程对 attachments 的处理」这层。
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import WebSocket from 'ws';
import { startWsServer, stopWsServer } from '../../electron/main/ws/server';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { createSubConversation } from '../../electron/main/conversations/store';
import { newReqId } from '@shared/ids';
import type { ClientRequestPayload, ServerEvent } from '@shared/protocol';
import type { BackendProvider, ChatMessage, RegisteredModel } from '@shared/types';

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
    }, 5000);
  });
}

// 1x1 PNG 的标准 base64（含 magic bytes）
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
  console.log('=== chat_attachments smoke ===');

  const agent = await ensureDefaultAgent();
  const convId = (await createSubConversation(agent.id, '新对话')).id;
  const port = await startWsServer();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'file://' });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  try {
    // 配置：anthropic provider + sonnet 4.6 (supportsVision=true)
    const providersAdd = await send<{ type: 'providers.state'; providers: BackendProvider[] }>(ws, {
      type: 'providers.add',
      provider: { type: 'anthropic', label: 'Anth', apiKey: 'sk-test' },
    });
    const provId = providersAdd.providers[0].id;

    const modelsAdd = await send<{ type: 'models.state'; models: RegisteredModel[] }>(ws, {
      type: 'models.add',
      model: {
        providerId: provId,
        modelId: 'claude-sonnet-4-6',
        label: 'Sonnet',
        contextWindow: 200_000,
        supportsVision: true,
        supportsPromptCache: true,
        supportsReasoning: true,
      },
    });
    const modelId = modelsAdd.models[0].id;

    await send(ws, { type: 'modelAssignments.update', usage: 'twinMain', modelId });

    // case 1: PNG 正常落盘
    // 注意：chat.send 服务端会异步起 LLM 调用——但 apiKey='sk-test' 立刻报错抛 chat.done 失败
    // 本 smoke 不关心 LLM 结果，仅看 user 消息是否带 attachments 进 history
    const ack1 = await send(ws, {
      type: 'chat.send',
      agentId: agent.id,
      conversationId: convId,
      text: '看看这张图',
      attachments: [
        {
          base64: PNG_1X1_BASE64,
          mediaType: 'image/png',
          filename: 'tiny.png',
          bytes: Buffer.from(PNG_1X1_BASE64, 'base64').length,
        },
      ],
    });
    assert(ack1.type === 'ack', 'chat.send 1 张 PNG 接受', ack1.type);

    // 等服务端落盘 user message（appendMessage 在 ack 之前已完成）
    await new Promise((r) => setTimeout(r, 100));

    const histRes = await send<{ type: 'conv.history.result'; messages: ChatMessage[] }>(ws, {
      type: 'conv.history',
      agentId: agent.id,
      conversationId: convId,
    });
    const userMsg = histRes.messages.find((m) => m.role === 'user' && m.text === '看看这张图');
    assert(!!userMsg, 'history 中能找到含图 user 消息');
    assert(
      userMsg?.attachments?.length === 1,
      'attachments 长度 = 1',
      String(userMsg?.attachments?.length),
    );
    const att = userMsg!.attachments![0];
    assert(att.kind === 'image', 'attachment.kind === image', att.kind);
    assert(att.mediaType === 'image/png', 'mediaType === image/png', att.mediaType);
    assert(att.relPath.endsWith('.png'), 'relPath 后缀正确', att.relPath);
    assert(att.relPath.startsWith(`${convId}-images/`), 'relPath 在 conv-images 目录下', att.relPath);
    assert(
      typeof att.displayUrl === 'string' && att.displayUrl.startsWith('oru-conv-img://'),
      'displayUrl 是 oru-conv-img:// URL',
      att.displayUrl,
    );

    // 物理文件存在
    const absPath = decodeURIComponent(new URL(att.displayUrl!).pathname);
    const stat = await fs.stat(absPath).catch(() => null);
    assert(stat !== null && stat.size > 0, '物理文件落盘成功', absPath);

    // case 1 起的回合（sk-test 的 LLM 异步失败前 conv 仍 running）必须先 abort 释放——否则后续校验
    // 用例在同 conv 上会被当 steering 入队（忙时忽略 attachments、不校验），观察不到拒收。
    // 之后每个校验失败用例都能起新回合走 saveAttachments 校验；校验失败会释放回合（见 chat.ts 修复），
    // 故同 conv 连发也都能起回合——本段同时回归守住「bail 释放回合」不再泄漏。
    await send(ws, { type: 'chat.abort', agentId: agent.id, conversationId: convId });

    // case 2: 超 5MB 但非真图（magic bytes 不匹配）→ DECODE_FAIL。
    // 注：G25 撤了「>5MB 直接拒收」——真图超限会被缩放压缩接受（离屏压缩逻辑由
    // tests/conversations/saveAttachmentsCompress.test.ts 单测覆盖）；这里的全 0x89 缓冲不是有效图，
    // 走到 magic-byte 校验被判非真图，属另一类失败，故断言 DECODE_FAIL 而非 TOO_LARGE。
    let err: Error | null = null;
    try {
      const huge = Buffer.alloc(5 * 1024 * 1024 + 100, 0x89).toString('base64');
      await send(ws, {
        type: 'chat.send',
        agentId: agent.id,
        conversationId: convId,
        text: '',
        attachments: [
          { base64: huge, mediaType: 'image/png', filename: 'huge.png', bytes: 5 * 1024 * 1024 + 100 },
        ],
      });
    } catch (e) {
      err = e as Error;
    }
    assert(
      err !== null && err.message.startsWith('ATTACHMENT_DECODE_FAIL'),
      '超 5MB 的非真图 → ATTACHMENT_DECODE_FAIL（真图超限则压缩，见单测）',
      err?.message,
    );

    // case 3: 9 张
    err = null;
    try {
      await send(ws, {
        type: 'chat.send',
        agentId: agent.id,
        conversationId: convId,
        text: '',
        attachments: Array.from({ length: 9 }, () => ({
          base64: PNG_1X1_BASE64,
          mediaType: 'image/png' as const,
          filename: 't.png',
          bytes: 70,
        })),
      });
    } catch (e) {
      err = e as Error;
    }
    assert(
      err !== null && err.message.startsWith('ATTACHMENT_TOO_MANY'),
      '9 张 → ATTACHMENT_TOO_MANY',
      err?.message,
    );

    // case 4: BAD_FORMAT (BMP)
    err = null;
    try {
      await send(ws, {
        type: 'chat.send',
        agentId: agent.id,
        conversationId: convId,
        text: '',
        attachments: [
          {
            base64: PNG_1X1_BASE64,
            // @ts-expect-error 故意越白名单
            mediaType: 'image/bmp',
            filename: 'x.bmp',
            bytes: 70,
          },
        ],
      });
    } catch (e) {
      err = e as Error;
    }
    assert(
      err !== null && err.message.startsWith('ATTACHMENT_BAD_FORMAT'),
      'BMP → ATTACHMENT_BAD_FORMAT',
      err?.message,
    );

    // case 5: 伪造 PNG（声明 PNG 实际是任意 base64）
    err = null;
    try {
      const fake = Buffer.from('this is not a png at all').toString('base64');
      await send(ws, {
        type: 'chat.send',
        agentId: agent.id,
        conversationId: convId,
        text: '',
        attachments: [{ base64: fake, mediaType: 'image/png', filename: 'fake.png', bytes: 24 }],
      });
    } catch (e) {
      err = e as Error;
    }
    assert(
      err !== null && err.message.startsWith('ATTACHMENT_DECODE_FAIL'),
      '伪造 PNG → ATTACHMENT_DECODE_FAIL',
      err?.message,
    );

    // case 6: 切到 OAuth 默认 → 贴图放行（fallback 模型 opus 支持视觉，router 兜底校验
    // 引用 factory 的 OAUTH_FALLBACK_SUPPORTS_VISION 单一事实源——换不支持视觉的 fallback
    // 模型时此 case 应同步翻转为"被拒"）。LLM 调用本身可能因前序对话仍 busy 被丢弃，不影响校验结论。
    await send(ws, { type: 'modelAssignments.update', usage: 'twinMain', modelId: null });
    err = null;
    let ack6: { type: string } | null = null;
    try {
      ack6 = await send(ws, {
        type: 'chat.send',
        agentId: agent.id,
        conversationId: convId,
        text: '',
        attachments: [{ base64: PNG_1X1_BASE64, mediaType: 'image/png', filename: 't.png', bytes: 70 }],
      });
    } catch (e) {
      err = e as Error;
    }
    assert(
      err === null && ack6?.type === 'ack',
      'OAuth fallback 支持视觉 → 贴图放行（兜底校验跟随单一事实源）',
      err?.message ?? ack6?.type,
    );

    // case 7: 清空 conversation → images 目录被 rm（main conv 不能 delete，用 clear）
    const imagesDir = join(absPath, '..');
    const dirExistsBefore = await fs.stat(imagesDir).then(() => true).catch(() => false);
    assert(dirExistsBefore, '清空 conv 之前 images 目录存在', imagesDir);

    await send(ws, { type: 'conv.clear', agentId: agent.id, conversationId: convId });
    const dirExistsAfter = await fs.stat(imagesDir).then(() => true).catch(() => false);
    assert(!dirExistsAfter, '清空 conv 之后 images 目录被 rm', imagesDir);
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
}

main().catch((e) => {
  console.error('smoke unhandled error:', e);
  process.exit(1);
});
