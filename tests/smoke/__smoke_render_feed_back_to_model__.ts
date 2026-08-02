/**
 * __smoke_render_feed_back_to_model__ —— 任务 1 头号风险的固化验证（PRD/技术设计决策 2）。
 *
 * 验证目标本身：工具返回带 image 的 ToolResult → 真实 ClaudeCodeBackend 的 buildToolsMcpServer
 * 把它转成 MCP image content → SDK 包成 tool_result image block → 模型**真看见**那张图。
 *
 * 跑法：走真实 sdk-mcp 链路 + 活模型（与 __smoke_chat__ 同模式，靠 Claude Code 登录态鉴权）。
 * 注册一个返回纯红图的工具，让模型描述颜色，断言它回答里出现"红/red"。
 * 这一条通了，"给分身一双眼睛"才算真落地——它通不过，决策 2 要走落盘退路。
 */
import './__smoke_isolate__';
import zlib from 'node:zlib';
import type { AgentTool } from '@shared/agent/backend';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';

/**
 * 生成一张按宽度均分成若干竖条的 PNG 的 base64（自给自足，不依赖 Electron / 二进制 fixture）。
 * 用竖条而非纯色：验证的不只是"模型看见图"，还有"在 1920 宽真实渲染尺寸下，模型能分辨
 * 空间细节（左中右是不同颜色），即截图经模型分辨率压缩后版式信息仍可读"——这是决策 8 的核心假设。
 */
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const bandW = w / bands.length;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const o = y * (w * 3 + 1);
    raw[o] = 0; // filter: none
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

// 真实渲染尺寸 1920×1080，左红 / 中绿 / 右蓝——模拟一张有空间布局的 deck 截图
const BANDED_PNG = bandedPng(1920, 1080, [
  [220, 30, 30],
  [30, 170, 30],
  [30, 30, 220],
]);

function makeImageTool(): AgentTool {
  return {
    name: 'show_test_image',
    description: '返回一张测试图片让你看。调用后请描述你看到的内容。',
    inputSchema: { type: 'object', properties: {} },
    persistPolicy: 'never',
    async execute() {
      return {
        text: '这是渲染出来的截图：',
        images: [{ base64: BANDED_PNG, mediaType: 'image/png' as const }],
      };
    },
  };
}

async function main(): Promise<void> {
  console.log('=== render_feed_back_to_model smoke（活模型）===');

  const backend = new ClaudeCodeBackend('claude-sonnet-4-6');
  const ready = await backend.isReady();
  if (!ready.ok) {
    console.error(`[SKIP] 无鉴权（${ready.hint}）——本 smoke 需要 Claude Code 登录态或 ANTHROPIC_API_KEY`);
    process.exit(2);
  }
  backend.registerTool(makeImageTool());

  // 注意：prompt 不点出任何颜色名，避免"提示泄漏"——模型必须真读图才能说出红/绿/蓝及其左右顺序，
  // 否则它可能照抄 prompt 里的颜色词而非真看图（决策 8 的验证才站得住）。
  const userMessage =
    '请调用 show_test_image 工具拿到一张图片，然后回答：图片从左到右依次是哪几种颜色？严格按你实际看到的回答。';
  const handle = backend.runConversation({
    agentId: 'smoke-agent',
    conversationId: 'cnv-render',
    userMessage,
    history: [
      { id: 'u1', conversationId: 'cnv-render', role: 'user', text: userMessage, toolCalls: [], createdAt: 1, done: true },
    ],
    cwd: process.cwd(),
    abortController: new AbortController(),
    allowedTools: ['mcp__oru__show_test_image'],
    toolContext: {
      conversationId: 'cnv-render',
      agentId: 'smoke-agent',
      ownerId: 'local-user',
      usage: 'twinMain',
      approvalMode: 'work',
      abortSignal: new AbortController().signal,
    },
  });

  let assistantText = '';
  let resultText = '';
  let toolCalled = false;
  for await (const ev of handle.events) {
    const e = ev as { type: string; text?: string; name?: string; resultText?: string };
    if (e.type === 'assistant_text' && e.text) assistantText += e.text;
    // claude-code SDK 的 tool_use.name 带 MCP 前缀（mcp__oru__show_test_image），用 includes 匹配
    if (e.type === 'tool_use' && e.name?.includes('show_test_image')) toolCalled = true;
    if (e.type === 'result' && typeof e.resultText === 'string') resultText = e.resultText;
  }

  const reply = resultText || assistantText;
  const said = reply.toLowerCase();
  console.log(`\n[模型回复] ${reply.slice(0, 300)}`);
  console.log(`[工具被调用] ${toolCalled}`);

  // 三色都说出 = 看见图（决策 2）；且左中右顺序正确 = 在 1920 宽下分辨出空间细节（决策 8）。
  // 取每种颜色词"最早一次"出现的位置（跨中英），比 Math.max 更贴"先提到谁"的语义。
  const firstIdx = (a: number, b: number) => (a < 0 ? b : b < 0 ? a : Math.min(a, b));
  const idxRed = firstIdx(said.indexOf('红'), said.indexOf('red'));
  const idxGreen = firstIdx(said.indexOf('绿'), said.indexOf('green'));
  const idxBlue = firstIdx(said.indexOf('蓝'), said.indexOf('blue'));
  const sawAllThree = idxRed >= 0 && idxGreen >= 0 && idxBlue >= 0;
  const orderOk = sawAllThree && idxRed < idxGreen && idxGreen < idxBlue;

  if (toolCalled && sawAllThree && orderOk) {
    console.log(
      '\n[PASS] 模型调用工具、说出红/绿/蓝且左→右顺序正确——' +
        'image content 通道成立（决策 2 主路）且 1920 宽截图压缩后空间细节仍可读（决策 8）。',
    );
    process.exit(0);
  }
  console.error(
    `\n[FAIL] toolCalled=${toolCalled} sawAllThree=${sawAllThree} orderOk=${orderOk}。` +
      '若 toolCalled=true 但没说出三色 → 图没真喂进模型视野，需走决策 2 落盘退路；' +
      '若说出三色但顺序错 → 决策 8 的"压缩后可读性"存疑，需重审 viewport 尺寸。',
  );
  process.exit(1);
}

main().catch((e) => {
  console.error('smoke unhandled error:', e);
  process.exit(1);
});
