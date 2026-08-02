/**
 * __smoke_aside_seed_image__ —— 验目标问题本身：点睛（aside）对话首轮走 ClaudeCodeBackend 时，
 * 种子指代卡上的截图必须真喂进模型视野。
 *
 * 回归背景：指代卡是对话出生时落的历史消息，截图挂在它身上、永远不是"本轮最后一条 user
 * 消息"——修复前 currentTurnImageAttachments 碰不到它、灌历史又是纯文本，截图整条丢，
 * 模型顺着指代文字硬聊、被追问才承认"图我看不见"。本 smoke 固化 seedReferentImageAttachments
 * 并入种子图后的端到端行为（区别于 __smoke_claude_user_image__——那条验"用户当轮上传的图"，
 * 本条验"出生即在历史里的种子图"，取图口径是两条不同通路）。
 *
 * 跑法：构造左红/中绿/右蓝 PNG，经 saveAttachments 落盘 → 挂到 kind:'aside-referent' 的
 * 种子卡上 → 历史 = [指代卡, 短评, 用户提问] → runConversation（无 resumeSessionId，
 * 走 fresh-run 灌历史分支）→ 断言模型说出红/绿/蓝且左→右顺序正确。
 * 需要 Claude Code 登录态或 ANTHROPIC_API_KEY，无则 SKIP。
 */
import './__smoke_isolate__';
import zlib from 'node:zlib';
import type { ChatMessage } from '@shared/types';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';
import { saveAttachments } from '../../electron/main/conversations/attachments';

/** 按宽度均分成竖条的 PNG base64（与 __smoke_claude_user_image__ 同型自给自足，不依赖二进制 fixture）。 */
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
  console.log('=== aside_seed_image smoke（活模型）===');

  const backend = new ClaudeCodeBackend('claude-opus-4-8', { supportsVision: true });
  const ready = await backend.isReady();
  if (!ready.ok) {
    console.error(`[SKIP] 无鉴权（${ready.hint}）——本 smoke 需要 Claude Code 登录态或 ANTHROPIC_API_KEY`);
    process.exit(2);
  }

  const agentId = 'smoke-agent';
  const convId = 'cnv-asideseed';
  const cardId = 'card1';
  const atts = await saveAttachments(agentId, convId, cardId, [
    { base64: BANDED_PNG, mediaType: 'image/png', filename: 'aside-screenshot.png', bytes: Buffer.from(BANDED_PNG, 'base64').length },
  ]);

  // 复刻 aside.begin 的出生形态：指代卡（带截图）→ 短评 → 用户开口。
  // 用户提问不点出任何颜色名——模型必须真看到种子卡的截图才答得出。
  const userMessage = '请只根据你实际看到的截图回答：它从左到右依次是哪三种颜色？';
  const history: ChatMessage[] = [
    {
      id: cardId,
      conversationId: convId,
      role: 'user',
      kind: 'aside-referent',
      text: '用户按住 Option 点击了界面上的一处空白。',
      toolCalls: [],
      createdAt: 1,
      done: true,
      attachments: atts,
    },
    { id: 'cm1', conversationId: convId, role: 'assistant', text: '这片空白挺有性格。', toolCalls: [], createdAt: 2, done: true },
    { id: 'u1', conversationId: convId, role: 'user', text: userMessage, toolCalls: [], createdAt: 3, done: true },
  ];

  // 不传 resumeSessionId → fresh-run 灌历史分支，正是回归的目标路径
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
    console.log('\n[PASS] 模型说出红/绿/蓝且左→右顺序正确——种子指代卡的截图随灌历史真喂进了模型视野。');
    process.exit(0);
  }
  console.error(
    `\n[FAIL] sawAllThree=${sawAllThree} orderOk=${orderOk}。` +
      '说不出三色 → 种子卡截图没并入首轮（seedReferentImageAttachments/灌历史带图分支回归）；顺序错 → 图喂进了但空间细节丢失。',
  );
  process.exit(1);
}

main().catch((e) => {
  console.error('smoke unhandled error:', e);
  process.exit(1);
});
