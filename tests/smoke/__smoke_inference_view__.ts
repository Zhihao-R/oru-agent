/**
 * inference_view smoke — PRD「LLM 入参优化」+ v0.4 源头落盘 验收
 *
 * v0.4 覆盖（老 shortSummary 已下线）：
 * 1. persistedRef：3 种 protocol 下 LLM 看到的是 preview 不是 detail
 * 2. 裁 2：UI-only system 消息（memory-record / turn-terminator / task-report）被丢；context-compressed 保留
 * 3. record_memory 内置白名单去重：detail 第一行替代完整 detail；其他工具不受影响
 * 4. flag=0：system 过滤失效（持久化字段不受 flag 影响）
 * 5. telemetry：savings 字段齐全 + 数值合理；persistedReplaced/CharsReduced/writeAckDeduped/CharsReduced
 *
 * 不打 Claude，纯本地。
 */
import './__smoke_isolate__';
import type { ChatMessage, ChatMessageKind, ToolCall } from '@shared/types';
import { adaptHistory } from '../../electron/main/agent/backends/historyAdapter';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

console.log('=== inference_view smoke ===');

// ─── helpers ──────────────────────────────────────────────────
function mkUser(text: string): ChatMessage {
  return {
    id: `u_${Math.random()}`,
    conversationId: 'cnv',
    role: 'user',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  };
}

function mkAssistant(opts: {
  text: string;
  toolName: string;
  detail: string;
  /** v0.4：构造 result.persistedRef.preview——模拟 stream.ts 落盘后的形态 */
  persistedPath?: string;
  persistedPreview?: string;
  protocol: 'sdk-mcp' | 'anthropic-native' | 'openai-fc';
}): ChatMessage {
  const tc: ToolCall = {
    id: `tc_${Math.random()}`,
    name: opts.toolName,
    input: { q: 'test' },
    status: 'success',
    startedAt: 0,
    finishedAt: 1,
    result: {
      toolCallId: 'tc_x',
      isError: false,
      summary: opts.detail.slice(0, 30),
      detail: opts.detail,
      persistedRef: opts.persistedPath
        ? {
            path: opts.persistedPath,
            totalChars: opts.detail.length,
            preview: opts.persistedPreview ?? `${opts.detail.slice(0, 100)}…[落盘]`,
          }
        : undefined,
    },
  };
  return {
    id: `a_${Math.random()}`,
    conversationId: 'cnv',
    role: 'assistant',
    text: opts.text,
    toolCalls: [tc],
    createdAt: Date.now(),
    done: true,
    toolProtocol: opts.protocol,
  };
}

function mkSystem(kind: ChatMessageKind, text: string): ChatMessage {
  const base: ChatMessage = {
    id: `s_${Math.random()}`,
    conversationId: 'cnv',
    role: 'system',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    kind,
  };
  // marker 真实数据形态：text 是 UI 通知文案，summaryText 是发给 LLM 的摘要正文（v0.4）。
  // smoke 用同一段文本充当摘要正文，断言里检查"包含 X 文本"即可（无需区分两者来源）。
  if (kind === 'context-compressed') {
    base.contextCompressed = {
      compressedMessageIds: [],
      summaryText: text,
      fallback: false,
    };
  }
  return base;
}

// ─── 1. persistedRef：3 种 protocol 下都用 preview 替代 detail ───
delete process.env.ORU_INFERENCE_VIEW;
{
  const detail = 'D'.repeat(800);
  const preview = 'P'.repeat(200);
  for (const protocol of ['anthropic-native', 'openai-fc', 'sdk-mcp'] as const) {
    const history: ChatMessage[] = [
      mkUser('q1'),
      mkAssistant({
        text: '',
        toolName: 'web_search',
        detail,
        persistedPath: '/tmp/c1-tool-cache/tc_a.txt',
        persistedPreview: preview,
        protocol,
      }),
      mkUser('q2'),
    ];
    const { messages } = adaptHistory({
      messages: history,
      targetProtocol: protocol,
    });
    const allText = JSON.stringify(messages);
    assert(
      allText.includes(preview),
      `v0.4：persistedRef.preview 替换 detail (protocol=${protocol})`,
    );
    assert(
      !allText.includes(detail),
      `v0.4：detail 不再发给 LLM (protocol=${protocol})`,
    );
  }
}

// ─── 2. 裁 2：4 种 system kind 行为 ─────────────────────────
{
  const history: ChatMessage[] = [
    mkUser('q'),
    mkSystem('memory-record', 'UI 通知：已记下 X'),
    mkSystem('turn-terminator', '已中断'),
    mkSystem('task-report', '任务报告 X'),
    mkSystem('context-compressed', '【先前对话摘要】此前讨论了 Y'),
  ];
  const { messages, savings } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
  });
  const allText = JSON.stringify(messages);
  assert(!allText.includes('已记下 X'), '裁 2：memory-record 被丢');
  assert(!allText.includes('已中断'), '裁 2：turn-terminator 被丢');
  assert(!allText.includes('任务报告 X'), '裁 2：task-report 被丢');
  assert(allText.includes('先前对话摘要'), '裁 2：context-compressed 放行');
  assert(allText.includes('<previous_conversation_summary>'), '裁 2：marker 翻译用 XML tag 包裹');
  assert(savings.systemMessagesFiltered === 3, '裁 2：savings 计数 = 3', `count=${savings.systemMessagesFiltered}`);
}

// ─── 2.5：fallback marker（summaryText 为空）被 filter ─────
{
  const history: ChatMessage[] = [
    mkUser('q'),
    {
      ...mkSystem('context-compressed', '摘要生成失败，已自动丢弃早期 3 轮内容'),
      contextCompressed: { compressedMessageIds: ['a', 'b'], summaryText: '', fallback: true },
    },
    mkUser('q2'),
  ];
  const { messages, savings } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
  });
  const allText = JSON.stringify(messages);
  assert(!allText.includes('摘要生成失败'), 'fallback marker：通知文案不发给 LLM');
  assert(!allText.includes('已自动丢弃'), 'fallback marker：通知文案彻底不发');
  assert(savings.systemMessagesFiltered === 1, 'fallback marker：计入 filtered', `count=${savings.systemMessagesFiltered}`);
}

// ─── 3. 写入型回执去重：record_memory 内置白名单 ──────────────
{
  const detail = '✓ 已记到 user/profile.md：用户喜欢用 Twin 整理记忆\n（多余的第二行，应被截）';
  const history: ChatMessage[] = [
    mkUser('q1'),
    mkAssistant({
      text: '',
      toolName: 'record_memory',
      detail,
      protocol: 'anthropic-native',
    }),
    mkUser('q2'),
  ];
  const { messages, savings } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
  });
  const allText = JSON.stringify(messages);
  assert(allText.includes('✓ 已记到 user/profile.md'), 'record_memory：第一行保留');
  assert(!allText.includes('多余的第二行'), 'record_memory：第二行被截');
  assert(savings.writeAckDeduped === 1, 'savings.writeAckDeduped=1', `${savings.writeAckDeduped}`);
  assert(
    savings.writeAckCharsReduced > 0,
    'savings.writeAckCharsReduced > 0',
    `${savings.writeAckCharsReduced}`,
  );
}

// 3b. 其他工具不走 record_memory 白名单（即便错误）
{
  const detail = '一段普通的工具回执文本\n第二行内容';
  const history: ChatMessage[] = [
    mkUser('q1'),
    mkAssistant({
      text: '',
      toolName: 'list_projects', // 不在白名单
      detail,
      protocol: 'anthropic-native',
    }),
    mkUser('q2'),
  ];
  const { messages, savings } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
  });
  const allText = JSON.stringify(messages);
  assert(allText.includes('第二行内容'), '非白名单工具：detail 全文保留');
  assert(savings.writeAckDeduped === 0, '非白名单工具：savings 不计数');
}

// 3c. record_memory 失败：不去重（按 detail 走）
{
  const detail = '记忆写入失败：写权限不足\n详细堆栈：...';
  const tc: ToolCall = {
    id: 'tc_err',
    name: 'record_memory',
    input: {},
    status: 'error',
    startedAt: 0,
    finishedAt: 1,
    result: {
      toolCallId: 'tc_err',
      isError: true,
      summary: detail.slice(0, 30),
      detail,
    },
  };
  const history: ChatMessage[] = [
    mkUser('q'),
    {
      id: 'a_err',
      conversationId: 'cnv',
      role: 'assistant',
      text: '',
      toolCalls: [tc],
      createdAt: Date.now(),
      done: true,
      toolProtocol: 'anthropic-native',
    },
    mkUser('q2'),
  ];
  const { messages, savings } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
  });
  const allText = JSON.stringify(messages);
  assert(allText.includes('详细堆栈'), 'record_memory isError=true：detail 不去重');
  assert(savings.writeAckDeduped === 0, 'record_memory 失败：不计入 writeAckDeduped');
}

// ─── 4. flag=0：system 过滤失效 ────────────────────────────────
{
  process.env.ORU_INFERENCE_VIEW = '0';
  const history: ChatMessage[] = [
    mkUser('q'),
    mkSystem('memory-record', 'UI 通知：会被发出去'),
    mkSystem('context-compressed', '【摘要】Y'),
  ];
  const { messages, savings } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
  });
  const allText = JSON.stringify(messages);
  assert(allText.includes('UI 通知'), 'flag=0：memory-record 也放行（老逻辑）');
  assert(allText.includes('Y'), 'flag=0：context-compressed 仍放行');
  assert(savings.systemMessagesFiltered === 0, 'flag=0：systemMessagesFiltered 计数=0');
  delete process.env.ORU_INFERENCE_VIEW;
}

// ─── 5. telemetry：savings 字段齐全 + 数值合理 ──────────────
{
  const detail = 'D'.repeat(800);
  const preview = 'P'.repeat(80);
  const recordDetail = '✓ 已记到 X.md：a\n第二行';
  const history: ChatMessage[] = [
    mkUser('q1'),
    mkAssistant({
      text: '',
      toolName: 'web_search',
      detail,
      persistedPath: '/tmp/p.txt',
      persistedPreview: preview,
      protocol: 'anthropic-native',
    }),
    mkAssistant({
      text: '',
      toolName: 'record_memory',
      detail: recordDetail,
      protocol: 'anthropic-native',
    }),
    mkSystem('memory-record', 'X'),
    mkUser('q2'),
  ];
  const { savings } = adaptHistory({
    messages: history,
    targetProtocol: 'anthropic-native',
  });
  assert(savings.systemMessagesFiltered === 1, 'telemetry: filtered=1', `${savings.systemMessagesFiltered}`);
  assert(savings.persistedReplaced === 1, 'telemetry: persistedReplaced=1');
  assert(
    savings.persistedCharsReduced === detail.length - preview.length,
    'telemetry: persistedCharsReduced = detail.length - preview.length',
    `${savings.persistedCharsReduced} vs ${detail.length - preview.length}`,
  );
  assert(savings.writeAckDeduped === 1, 'telemetry: writeAckDeduped=1');
  assert(savings.writeAckCharsReduced > 0, 'telemetry: writeAckCharsReduced > 0');
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
