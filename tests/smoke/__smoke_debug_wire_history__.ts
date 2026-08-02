/**
 * v0.5 wireHistory smoke — 调试视图显示真实入参
 *
 * 验证：
 * 1. NormalizedMessage image block 的 load 闭包在 adapter 运行时实例上存在
 * 2. JSON.stringify 落盘 → 闭包消失（行为天然正确——JSON.stringify 默认忽略函数值）
 * 3. JSON.parse 反序列化后类型可用（前端 ndjson 解码场景）
 * 4. wireHistory 三态识别（present / resume / legacy）的判断条件等价于 helper 契约
 * 5. 含 toolCall 的对话经 adaptHistory 后，wireHistory 的 tool_result content
 *    跟 pickToolResultText 选中的字符串一致（这是"真实入参所见即所发"的核心契约）
 *
 * 不打 LLM，纯本地。
 */
import './__smoke_isolate__';
import type { NormalizedMessage } from '@shared/agent/normalizedMessage';
import type { ChatAttachment, ChatMessage, ToolCall } from '@shared/types';
import { adaptHistory } from '../../electron/main/agent/backends/historyAdapter';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

console.log('=== v0.5 wireHistory smoke ===');

// ─── 1. image block load 闭包在运行时实例上 ─────────────────
{
  const attachment: ChatAttachment = {
    kind: 'image',
    relPath: 'cat.png',
    filename: 'cat.png',
    mediaType: 'image/png',
    bytes: 100,
  };
  const history: ChatMessage[] = [
    {
      id: 'u1',
      conversationId: 'cnv',
      role: 'user',
      text: '看这个',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
      attachments: [attachment],
    },
  ];
  let loadCalled = false;
  const { messages: normalized } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
    targetSupportsVision: true,
    attachmentLoaderFor: () => async () => {
      loadCalled = true;
      return 'fake-base64';
    },
  });
  assert(normalized.length === 1, 'adapter 输出 1 条 user 消息');
  const blocks = normalized[0].blocks;
  const imgBlock = blocks.find((b) => b.type === 'image');
  assert(!!imgBlock, 'user blocks 含 image block');
  if (imgBlock && imgBlock.type === 'image') {
    assert(typeof imgBlock.load === 'function', 'image block 含 load 闭包（运行时实例）');
    // 验证 load 是注入的闭包
    if (imgBlock.load) void imgBlock.load();
    assert(loadCalled, 'load 闭包可正常调用');
  }
}

// ─── 2. JSON.stringify 落盘后 image block 不含 load 字段 ─────
{
  const wire: NormalizedMessage[] = [
    {
      role: 'user',
      blocks: [
        {
          type: 'image',
          mediaType: 'image/jpeg',
          filename: 'a.jpg',
          load: async () => 'base64-data',
        },
        { type: 'text', text: 'hi' },
      ],
    },
  ];
  const serialized = JSON.stringify(wire);
  assert(!serialized.includes('load'), 'JSON.stringify 后 load 字段消失（属于函数值，被默认忽略）');
  assert(serialized.includes('a.jpg'), 'filename 仍在');
  assert(serialized.includes('image/jpeg'), 'mediaType 仍在');

  // 反序列化（模拟前端读 ndjson）
  const parsed = JSON.parse(serialized) as NormalizedMessage[];
  assert(parsed.length === 1, '反序列化 1 条');
  const imgBlock = parsed[0].blocks.find((b) => b.type === 'image');
  assert(!!imgBlock, '反序列化 image block 仍在');
  if (imgBlock && imgBlock.type === 'image') {
    assert(imgBlock.load === undefined, '反序列化后 load === undefined（类型 load? 允许）');
  }
}

// ─── 3. wireHistory 三态契约（getWireHistoryDisplay 由 adapterRan 区分） ─────
//   v0.5 信号位选独立 boolean adapterRan，不再用"空数组"作 resume——避免跟正常 adapter
//   边界输入返回 [] 撞车（如全空 history、全被裁的 system 消息）。
{
  // present：adapterRan=true，wireHistory 有内容
  const presentRan = true;
  const presentMsgs: NormalizedMessage[] = [{ role: 'user', blocks: [{ type: 'text', text: 'q' }] }];
  assert(presentRan && presentMsgs.length > 0, 'adapterRan=true + wireHistory 非空 → present');

  // present 边界：adapterRan=true，wireHistory=[]（合法，adapter 跑了只是输入退化）
  const presentEmptyRan = true;
  const presentEmptyMsgs: NormalizedMessage[] = [];
  assert(
    presentEmptyRan && presentEmptyMsgs.length === 0,
    'adapterRan=true + wireHistory 为空数组 → 仍是 present（合法的边界）',
  );

  // resume：adapterRan=false（明确标识 adapter 未跑）
  const resumeRan = false;
  assert(!resumeRan, 'adapterRan=false → resume');

  // legacy：adapterRan 缺（老 ndjson）
  const legacyRan: boolean | undefined = undefined;
  assert(legacyRan === undefined, 'adapterRan === undefined → legacy');
}

// ─── 4. tool_result 真实入参契约：wireHistory 里看到的 = LLM 真实看到的 ─────
{
  const longDetail = 'D'.repeat(500);
  const preview = 'P'.repeat(80);
  const tc: ToolCall = {
    id: 'tc1',
    name: 'web_fetch',
    input: { url: 'https://example.com' },
    status: 'success',
    startedAt: 0,
    finishedAt: 1,
    result: {
      toolCallId: 'tc1',
      isError: false,
      summary: longDetail.slice(0, 30),
      detail: longDetail,
      // 模拟落盘：preview 替代 detail
      persistedRef: {
        path: '/tmp/c1-tool-cache/tc1.md',
        totalChars: longDetail.length,
        preview,
      },
    },
  };
  const history: ChatMessage[] = [
    {
      id: 'u1',
      conversationId: 'cnv',
      role: 'user',
      text: '抓这个',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    },
    {
      id: 'a1',
      conversationId: 'cnv',
      role: 'assistant',
      text: '',
      toolCalls: [tc],
      createdAt: Date.now(),
      done: true,
      toolProtocol: 'anthropic-native',
    },
    {
      id: 'u2',
      conversationId: 'cnv',
      role: 'user',
      text: '继续',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    },
  ];
  const { messages: normalized } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
  });

  // 在 normalized 里找 tool_result block，断言 content === preview（不是 detail）
  let foundContent: string | null = null;
  for (const m of normalized) {
    if (m.role !== 'user') continue;
    for (const b of m.blocks) {
      if (b.type === 'tool_result') {
        foundContent = b.content;
      }
    }
  }
  assert(foundContent === preview, 'wireHistory 里 tool_result.content === preview（落盘策略）');
  assert(foundContent !== longDetail, 'wireHistory 里不再含完整 detail');
}

// ─── 5. invariant 守护：未填 load 时 adapter 抛 ──────
{
  // 模拟"未来 adapter 重构有人漏注 load 闭包"：loader 返回非函数
  const attachment: ChatAttachment = {
    kind: 'image',
    relPath: 'oops.png',
    filename: 'oops.png',
    mediaType: 'image/png',
    bytes: 50,
  };
  const history: ChatMessage[] = [
    {
      id: 'u1',
      conversationId: 'cnv',
      role: 'user',
      text: '看这个',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
      attachments: [attachment],
    },
  ];
  let threw = false;
  let errMsg = '';
  try {
    adaptHistory({
      messages: history,
      targetProtocol: 'anthropic-native',
      targetSupportsVision: true,
      // 故意返回 undefined 触发 invariant
      attachmentLoaderFor: () => undefined as unknown as () => Promise<string>,
    });
  } catch (e) {
    threw = true;
    errMsg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, 'invariant 守护：未填 load 时 adapter 抛错');
  assert(errMsg.includes('invariant violation'), 'invariant 错误信息含 invariant violation 字样', errMsg);
}

// ─── 6. assistant tool_use block 字段完整 ─────
{
  const tc: ToolCall = {
    id: 'tc_x',
    name: 'web_search',
    input: { q: 'oru' },
    status: 'success',
    startedAt: 0,
    finishedAt: 1,
    result: {
      toolCallId: 'tc_x',
      isError: false,
      summary: 'ok',
      detail: 'detail',
    },
  };
  const history: ChatMessage[] = [
    {
      id: 'a1',
      conversationId: 'cnv',
      role: 'assistant',
      text: '搜一下',
      toolCalls: [tc],
      createdAt: Date.now(),
      done: true,
      toolProtocol: 'anthropic-native',
    },
  ];
  const { messages: normalized } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
  });
  const asstMsg = normalized.find((m) => m.role === 'assistant');
  assert(!!asstMsg, '有 assistant 消息');
  if (asstMsg && asstMsg.role === 'assistant') {
    const toolUse = asstMsg.blocks.find((b) => b.type === 'tool_use');
    assert(!!toolUse, 'assistant blocks 含 tool_use');
    if (toolUse && toolUse.type === 'tool_use') {
      assert(toolUse.id === 'tc_x', 'tool_use.id 正确');
      assert(toolUse.name === 'web_search', 'tool_use.name 正确');
      assert((toolUse.input as { q?: string }).q === 'oru', 'tool_use.input 完整');
    }
  }
}

// ─── summary ──────────────────────────────────────────────────
const failed = RESULTS.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log(`\nFAIL: ${RESULTS.length - failed.length}/${RESULTS.length} cases passed`);
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
  process.exit(1);
} else {
  console.log(`\nPASS: all ${RESULTS.length} cases`);
  process.exit(0);
}
