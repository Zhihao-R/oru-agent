/**
 * __smoke_claude_user_image__ —— 验目标问题本身：走 ClaudeCodeBackend（本机 Claude 登录态）时，
 * 用户上传的图片能真正喂进模型让它"看见"。
 *
 * 这是 streaming-input 传图改动的端到端固化（区别于 __smoke_render_feed_back_to_model__——
 * 那条验的是"工具结果回传 image"，本条验的是"用户输入 image"，两条 SDK 路径不同）。
 *
 * 跑法：构造一张左红/中绿/右蓝的 PNG，经 saveAttachments 落盘 → 挂到末条 user 消息 →
 * ClaudeCodeBackend.runConversation 走带图分支（supportsVision:true + 本轮有新消息）→
 * 断言模型回答里出现红/绿/蓝且左→右顺序正确。需要 Claude Code 登录态或 ANTHROPIC_API_KEY，无则 SKIP。
 */
import './__smoke_isolate__';
import zlib from 'node:zlib';
import type { ChatMessage } from '@shared/types';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';
import { saveAttachments } from '../../electron/main/conversations/attachments';

/** 按宽度均分成竖条的 PNG base64（自给自足，不依赖二进制 fixture）。 */
function bandedPng(w: number, h: number, bands: Array<[number, number, number]>): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const bandW = w / bands.length;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = bands[Math.min(bands.length - 1, Math.floor(x / bandW))];
      const p = o + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

const BANDED_PNG = bandedPng(1920, 1080, [
  [220, 30, 30],
  [30, 170, 30],
  [30, 30, 220],
]);

async function main(): Promise<void> {
  console.log('=== claude_user_image smoke（活模型）===');

  const backend = new ClaudeCodeBackend('claude-opus-4-8', { supportsVision: true });
  const ready = await backend.isReady();
  if (!ready.ok) {
    console.error(`[SKIP] 无鉴权（${ready.hint}）——本 smoke 需要 Claude Code 登录态或 ANTHROPIC_API_KEY`);
    process.exit(2);
  }

  const agentId = 'smoke-agent';
  const convId = 'cnv-userimg';
  const msgId = 'u1';
  const atts = await saveAttachments(agentId, convId, msgId, [
    { base64: BANDED_PNG, mediaType: 'image/png', filename: 'banded.png', bytes: Buffer.from(BANDED_PNG, 'base64').length },
  ]);

  // prompt 不点出任何颜色名——模型必须真读图才能说出红/绿/蓝及左右顺序。
  const userMessage = '我刚发了一张图。请只根据你实际看到的回答：图片从左到右依次是哪三种颜色？';
  const history: ChatMessage[] = [
    { id: msgId, conversationId: convId, role: 'user', text: userMessage, toolCalls: [], createdAt: 1, done: true, attachments: atts },
  ];

  const handle = backend.runConversation({
    agentId,
    conversationId: convId,
    userMessage,
    history,
    cwd: process.cwd(),
    abortController: new AbortController(),
  });

  let assistantText = '';
  let resultText = '';
  for await (const ev of handle.events) {
    const e = ev as { type: string; text?: string; resultText?: string };
    if (e.type === 'assistant_text' && e.text) assistantText += e.text;
    if (e.type === 'result' && typeof e.resultText === 'string') resultText = e.resultText;
  }

  const reply = resultText || assistantText;
  const said = reply.toLowerCase();
  console.log(`\n[模型回复] ${reply.slice(0, 300)}`);

  const firstIdx = (a: number, b: number) => (a < 0 ? b : b < 0 ? a : Math.min(a, b));
  const idxRed = firstIdx(said.indexOf('红'), said.indexOf('red'));
  const idxGreen = firstIdx(said.indexOf('绿'), said.indexOf('green'));
  const idxBlue = firstIdx(said.indexOf('蓝'), said.indexOf('blue'));
  const sawAllThree = idxRed >= 0 && idxGreen >= 0 && idxBlue >= 0;
  const orderOk = sawAllThree && idxRed < idxGreen && idxGreen < idxBlue;

  if (sawAllThree && orderOk) {
    console.log('\n[PASS] 模型说出红/绿/蓝且左→右顺序正确——用户上传的图经 streaming input 真喂进了模型视野。');
    process.exit(0);
  }
  console.error(
    `\n[FAIL] sawAllThree=${sawAllThree} orderOk=${orderOk}。` +
      '说不出三色 → 用户图没真喂进模型（带图分支/SDK 转换有问题）；顺序错 → 图喂进了但空间细节丢失。',
  );
  process.exit(1);
}

main().catch((e) => {
  console.error('smoke unhandled error:', e);
  process.exit(1);
});
