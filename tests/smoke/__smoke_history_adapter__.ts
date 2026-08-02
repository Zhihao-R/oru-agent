/**
 * historyAdapter smoke
 *
 * 验证决策 7.5 的三种形态：
 * 1. 同协议透传：assistant 的 toolCalls 翻译为 tool_use blocks，紧跟一条 user tool_result 消息
 * 2. 跨协议折叠：toolCalls 全部转成 assistant text，不发 protocol blocks
 * 3. 悬空 tool_use：result 缺失的 toolCall 只描述"未完成"，即使同协议也不发 tool_use block
 * 4. 老数据缺省 toolProtocol：按 'sdk-mcp' 处理
 *
 * 不打 Claude
 */
import './__smoke_isolate__';
import type { ChatMessage } from '@shared/types';
import { adaptHistory } from '../../electron/main/agent/backends/historyAdapter';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function makeUser(text: string): ChatMessage {
  return {
    id: `u_${Date.now()}_${Math.random()}`,
    conversationId: 'cnv_test',
    role: 'user',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  };
}

function makeAssistantWithToolCall(opts: {
  text: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: { isError: boolean; summary: string; detail?: string } | null;
  toolProtocol: 'sdk-mcp' | 'anthropic-native' | 'openai-fc';
  backendType?: 'claude-code' | 'anthropic' | 'openai-compatible';
}): ChatMessage {
  return {
    id: `a_${Date.now()}_${Math.random()}`,
    conversationId: 'cnv_test',
    role: 'assistant',
    text: opts.text,
    toolCalls: [
      {
        id: `tc_${Date.now()}_${Math.random()}`,
        name: opts.toolName,
        input: opts.toolInput,
        status: opts.toolResult ? (opts.toolResult.isError ? 'error' : 'success') : 'running',
        startedAt: Date.now(),
        finishedAt: opts.toolResult ? Date.now() : undefined,
        result: opts.toolResult
          ? {
              toolCallId: 'tc_x',
              isError: opts.toolResult.isError,
              summary: opts.toolResult.summary,
              detail: opts.toolResult.detail,
            }
          : undefined,
      },
    ],
    createdAt: Date.now(),
    done: true,
    backendType: opts.backendType,
    toolProtocol: opts.toolProtocol,
  };
}

async function main(): Promise<void> {
  console.log('=== history_adapter smoke ===');

  // case 1: 同协议透传——anthropic-native 历史 → 目标 anthropic-native
  const msgs1: ChatMessage[] = [
    makeUser('帮我看一下项目'),
    makeAssistantWithToolCall({
      text: '我先列项目',
      toolName: 'list_projects',
      toolInput: {},
      toolResult: { isError: false, summary: '共 1 个项目：foo' },
      toolProtocol: 'anthropic-native',
    }),
  ];
  const { messages: r1 } = adaptHistory({ messages: msgs1, targetProtocol: 'anthropic-native' });
  assert(r1.length === 3, '同协议：1 user + 1 assistant + 1 tool_result user', `len=${r1.length}`);
  if (r1.length === 3) {
    const second = r1[1];
    assert(
      second.role === 'assistant' &&
        second.blocks.some((b) => b.type === 'tool_use' && b.name === 'list_projects'),
      '同协议：assistant 含 tool_use block',
      JSON.stringify(second).slice(0, 200),
    );
    const third = r1[2];
    assert(
      third.role === 'user' && third.blocks.some((b) => b.type === 'tool_result'),
      '同协议：紧跟 user tool_result',
      JSON.stringify(third).slice(0, 200),
    );
  }

  // case 2: 跨协议折叠——sdk-mcp 历史 → 目标 anthropic-native
  const msgs2: ChatMessage[] = [
    makeUser('帮我列项目'),
    makeAssistantWithToolCall({
      text: '我先列项目',
      toolName: 'list_projects',
      toolInput: {},
      toolResult: { isError: false, summary: '共 1 个项目：foo' },
      toolProtocol: 'sdk-mcp',
      backendType: 'claude-code',
    }),
  ];
  const { messages: r2 } = adaptHistory({ messages: msgs2, targetProtocol: 'anthropic-native' });
  assert(r2.length === 2, '跨协议：1 user + 1 折叠后 assistant text（无 tool_result user）', `len=${r2.length}`);
  if (r2.length === 2) {
    const second = r2[1];
    assert(
      second.role === 'assistant' && second.blocks.every((b) => b.type === 'text'),
      '跨协议：assistant 只有 text block',
      JSON.stringify(second).slice(0, 200),
    );
    const text = (second.role === 'assistant' && second.blocks[0].type === 'text' && second.blocks[0].text) || '';
    assert(
      text.includes('list_projects') && text.includes('结果'),
      '跨协议：折叠 text 含工具名 + 结果描述',
      text.slice(0, 200),
    );
  }

  // case 3: 悬空 tool_use（result 缺失）—— 即使同协议也不发 tool_use block
  const msgs3: ChatMessage[] = [
    makeUser('帮我列项目'),
    makeAssistantWithToolCall({
      text: '',
      toolName: 'list_projects',
      toolInput: {},
      toolResult: null,
      toolProtocol: 'anthropic-native',
    }),
  ];
  const { messages: r3 } = adaptHistory({ messages: msgs3, targetProtocol: 'anthropic-native' });
  assert(r3.length === 2, '悬空 tool_use：1 user + 1 assistant 折叠（无 tool_result user）', `len=${r3.length}`);
  if (r3.length === 2) {
    const second = r3[1];
    assert(
      second.role === 'assistant' && second.blocks.every((b) => b.type === 'text'),
      '悬空：assistant 只发 text，不发 tool_use protocol block',
      JSON.stringify(second).slice(0, 200),
    );
    const text = (second.role === 'assistant' && second.blocks[0].type === 'text' && second.blocks[0].text) || '';
    assert(text.includes('未完成'), '悬空：text 描述含"未完成"', text.slice(0, 200));
  }

  // case 4: 老数据缺省 toolProtocol → 按 'sdk-mcp' 处理（跨协议折叠）
  const oldMsg: ChatMessage = {
    id: 'a_old',
    conversationId: 'cnv_test',
    role: 'assistant',
    text: '老数据',
    toolCalls: [
      {
        id: 'tc_old',
        name: 'list_projects',
        input: {},
        status: 'success',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        result: { toolCallId: 'tc_old', isError: false, summary: '共 1 个项目：foo' },
      },
    ],
    createdAt: Date.now(),
    done: true,
    // 注意：没设 backendType / toolProtocol
  };
  const { messages: r4 } = adaptHistory({ messages: [oldMsg], targetProtocol: 'anthropic-native' });
  assert(r4.length === 1, '老数据：缺省按 sdk-mcp 处理 → 跨协议折叠成单条 assistant', `len=${r4.length}`);
  if (r4.length === 1) {
    const m = r4[0];
    assert(
      m.role === 'assistant' && m.blocks.every((b) => b.type === 'text'),
      '老数据：折叠为 assistant text',
      JSON.stringify(m).slice(0, 200),
    );
  }

  // 总结
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
