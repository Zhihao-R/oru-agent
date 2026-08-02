/**
 * runner 的 5 个评论字段全链路：
 *   - boardCurrentTaskId → ToolContext.boardCurrentTaskId
 *   - projectIdOverride: null → toolContext.activeProjectId 为 undefined（"无项目"模式）
 *   - extraStableSystemPrompt → 拼到 systemContext stable 段
 *   - extraDynamicSystemPrompt → 拼到 systemContext dynamic 段
 *   - extraToolDenylist → backend.runConversation 收到 disallowedTools
 *
 * 用 fake backend 捕获 runConversation 入参，断言。
 */
import './__smoke_isolate__';

import { newMessageId } from '@shared/ids';
import type { ChatMessage } from '@shared/types';
import type { AgentBackend, ConversationInput, ConversationEvent } from '@shared/agent/backend';
import { __setBackendFactoryForTest } from '../../electron/main/agent/backends/factory';
import { createSubConversation, appendMessage } from '../../electron/main/conversations/store';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { runChat } from '../../electron/main/agent/runner';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

const STABLE_SENTINEL = '__SMOKE_STABLE_SENTINEL_X1__';
const DYNAMIC_SENTINEL = '__SMOKE_DYNAMIC_SENTINEL_Y2__';

let captured: ConversationInput | null = null;

function makeCapturingBackend(): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'mdl_fake',
    providerId: 'prv_fake',
    runConversation: (input: ConversationInput) => {
      captured = input;
      return {
        events: (async function* (): AsyncIterable<ConversationEvent> {
          yield { type: 'session', sessionId: 's1' };
          yield { type: 'assistant_text', text: 'ok' };
          yield { type: 'result', resultText: 'ok', isError: false };
        })(),
      };
    },
    runOneShot: async () => ({ text: 'irrelevant' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'fake' }),
  };
}

async function main() {
  const restore = __setBackendFactoryForTest(async () => makeCapturingBackend());

  try {
    const agent = await ensureDefaultAgent();
    const conv = await createSubConversation(agent.id, '新对话');
    const userMsg: ChatMessage = {
      id: newMessageId(),
      conversationId: conv.id,
      role: 'user',
      text: 'override test',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    };
    await appendMessage(agent.id, conv.id, userMsg);

    await runChat({
      agent,
      conversation: conv,
      messageId: newMessageId(),
      userText: 'override test',
      emit: () => {},
      onSdkSessionId: async () => {},
      onProposal: async () => {},
      // 5 个评论字段
      boardCurrentTaskId: 'bt_smoke_x',
      projectIdOverride: null, // "无项目"模式
      extraStableSystemPrompt: STABLE_SENTINEL,
      extraDynamicSystemPrompt: DYNAMIC_SENTINEL,
      extraToolDenylist: ['Task', 'commit_changes'],
    });

    if (!captured) {
      assert(false, '应该捕获到一次 runConversation 调用');
    } else {
      const sysContext = captured.systemContext ?? '';
      const stableContext = captured.stableSystemContext ?? '';

      assert(sysContext.includes(STABLE_SENTINEL), 'systemContext 含 STABLE_SENTINEL');
      assert(stableContext.includes(STABLE_SENTINEL), 'stableSystemContext 含 STABLE_SENTINEL');
      assert(sysContext.includes(DYNAMIC_SENTINEL), 'systemContext 含 DYNAMIC_SENTINEL');
      assert(
        !stableContext.includes(DYNAMIC_SENTINEL),
        'stableSystemContext **不**含 DYNAMIC_SENTINEL（动态段不入 stable）',
      );
      assert(sysContext.startsWith(stableContext), 'systemContext.startsWith(stableSystemContext) 不变量');

      assert(
        captured.toolContext?.boardCurrentTaskId === 'bt_smoke_x',
        'toolContext.boardCurrentTaskId 注入',
      );
      assert(
        captured.toolContext?.activeProjectId === undefined,
        'projectIdOverride=null → toolContext.activeProjectId=undefined（"无项目"模式）',
      );
      const denylist = captured.disallowedTools ?? [];
      assert(
        denylist.includes('Task') && denylist.includes('commit_changes'),
        'disallowedTools 含 Task / commit_changes',
      );
    }
  } finally {
    restore();
  }

  // 汇总
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
