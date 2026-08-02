/**
 * renderSeedPrompt + historyAdapter forceCollapse smoke
 *
 * 验证从 anthropic / openai backend 切回 ClaudeCode 时的"灌历史"输出：
 * - 历史里 anthropic-native 的 tool_use 不被透传给 SDK
 * - 历史末尾的 user 消息被切掉，单独贴在 prompt 尾部
 * - 包含明确的中文角色标记和分隔符
 *
 * 不打 SDK。
 */
import './__smoke_isolate__';
import type { ChatMessage, ToolCall } from '@shared/types';
import { renderSeedPrompt } from '../../electron/main/agent/backends/claudeCode';
import { adaptHistory } from '../../electron/main/agent/backends/historyAdapter';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

function mkUser(text: string): ChatMessage {
  return {
    id: `u_${text}`,
    conversationId: 'cnv',
    role: 'user',
    text,
    toolCalls: [],
    createdAt: 0,
    done: true,
  };
}

function mkAsst(text: string, calls: ToolCall[] = [], protocol: 'anthropic-native' | 'sdk-mcp' = 'anthropic-native'): ChatMessage {
  return {
    id: `a_${text}`,
    conversationId: 'cnv',
    role: 'assistant',
    text,
    toolCalls: calls,
    createdAt: 0,
    done: true,
    backendType: protocol === 'anthropic-native' ? 'anthropic' : 'claude-code',
    toolProtocol: protocol,
  };
}

console.log('=== seed_prompt smoke ===');

// 1. forceCollapse：anthropic-native 的 toolCall 应被折叠成 assistant text
{
  const tc: ToolCall = {
    id: 'tu_1',
    name: 'list_projects',
    input: {},
    status: 'success',
    startedAt: 0,
    finishedAt: 0,
    result: { toolCallId: 'tu_1', isError: false, summary: '3 个项目', detail: 'project list' },
  };
  const { messages: out } = adaptHistory({
    messages: [mkAsst('我帮你查一下', [tc], 'anthropic-native')],
    targetProtocol: 'anthropic-native',
    forceCollapse: true,
  });
  // 折叠后应只有 assistant text，没有 tool_use blocks
  const allBlocks = out.flatMap((m) => m.blocks as Array<{ type: string; text?: string }>);
  const hasToolUse = allBlocks.some((b) => b.type === 'tool_use');
  assert(!hasToolUse, 'forceCollapse: 没有 tool_use 块', JSON.stringify(allBlocks));
  const assistantText = allBlocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('|');
  assert(assistantText.includes('list_projects'), 'forceCollapse: 文本含工具名', assistantText.slice(0, 100));
}

// 2. forceCollapse=false（默认）：anthropic-native targetProtocol 透传 tool_use
{
  const tc: ToolCall = {
    id: 'tu_2',
    name: 'list_projects',
    input: {},
    status: 'success',
    startedAt: 0,
    finishedAt: 0,
    result: { toolCallId: 'tu_2', isError: false, summary: 'ok' },
  };
  const { messages: out } = adaptHistory({
    messages: [mkAsst('查一下', [tc], 'anthropic-native')],
    targetProtocol: 'anthropic-native',
  });
  const hasToolUse = out
    .flatMap((m) => m.blocks as Array<{ type: string }>)
    .some((b) => b.type === 'tool_use');
  assert(hasToolUse, '默认（forceCollapse=false）: tool_use 块透传', '');
}

// 3. renderSeedPrompt：历史 + 当前消息分两段，分隔符正确
{
  const history: ChatMessage[] = [
    mkUser('你好'),
    mkAsst('你好，我是 Twin', [], 'anthropic-native'),
    mkUser('帮我列一下项目'),
    mkAsst('好的', [], 'anthropic-native'),
    mkUser('再加一个项目叫 X'), // 当前消息（最后一条 user）
  ];
  const seed = renderSeedPrompt(history, '再加一个项目叫 X', 'agt_smoke');
  assert(seed.includes('历史回顾'), 'seed: 含历史回顾导语', '');
  assert(seed.includes('【用户】') && seed.includes('【你】'), 'seed: 含中文角色标签', '');
  assert(seed.includes('---'), 'seed: 含分隔符', '');
  assert(seed.includes('再加一个项目叫 X'), 'seed: 包含当前消息', '');
  assert(seed.indexOf('再加一个项目叫 X') === seed.lastIndexOf('再加一个项目叫 X'),
    'seed: 当前消息只出现一次（不与历史重复）',
    '');
  assert(seed.indexOf('---') < seed.indexOf('再加一个项目叫 X'),
    'seed: 当前消息在分隔符之后',
    '');
}

// 4. renderSeedPrompt：history 为空 → 只输出 userMessage 不加任何包装
{
  const seed = renderSeedPrompt([], 'hi', 'agt_smoke');
  assert(seed === 'hi', 'seed: 空历史不加包装', JSON.stringify(seed));
}

// 5. renderSeedPrompt：history 只有 1 条 user（首轮）→ 切掉它后历史段为空
{
  const seed = renderSeedPrompt([mkUser('你好')], '你好', 'agt_smoke');
  assert(!seed.includes('历史回顾'), 'seed: 只有当前 user 时无历史段', seed);
  assert(seed === '你好', 'seed: 只剩当前消息', seed);
}

const passed = RESULTS.filter((r) => r.ok).length;
const total = RESULTS.length;
if (passed === total) {
  console.log(`\nPASS: all ${total} cases`);
  process.exit(0);
} else {
  console.log(`\nFAIL: ${passed}/${total} cases`);
  process.exit(1);
}
