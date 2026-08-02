/**
 * 评论 Oru 锁占用：
 *   - isConversationBusy 返 true 时第二次 send 应被拒
 *   - 用 fake backend 让 runChat 长跑（卡住 events 流），构造一个"在跑"状态
 *
 * 因为 isConversationBusy 来自 runner 内部 activeAbortControllers Map，
 * 直接 mock 也难以注入；这里通过真启动一次 runChat（fake backend 阻塞 events 流），
 * 并在它运行时第二次发同一 conv → isConversationBusy 应为 true。
 */
import './__smoke_isolate__';

import { newMessageId } from '@shared/ids';
import type { ChatMessage } from '@shared/types';
import type { AgentBackend, ConversationEvent } from '@shared/agent/backend';
import { __setBackendFactoryForTest } from '../../electron/main/agent/backends/factory';
import { createSubConversation, appendMessage } from '../../electron/main/conversations/store';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { isConversationBusy, runChat } from '../../electron/main/agent/runner';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function makeStallingBackend(release: Promise<void>): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'mdl_fake',
    providerId: 'prv_fake',
    runConversation: () => ({
      events: (async function* (): AsyncIterable<ConversationEvent> {
        // 阻塞——直到 release 解除才发 result
        await release;
        yield { type: 'session', sessionId: 's1' };
        yield { type: 'result', resultText: 'done', isError: false };
      })(),
    }),
    runOneShot: async () => ({ text: 'irrelevant' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'fake' }),
  };
}

async function main() {
  let releaseStall!: () => void;
  const stallPromise = new Promise<void>((resolve) => {
    releaseStall = resolve;
  });
  const restore = __setBackendFactoryForTest(async () => makeStallingBackend(stallPromise));

  try {
    const agent = await ensureDefaultAgent();
    const conv = await createSubConversation(agent.id, '新对话');
    // 准备一条 user msg（runChat 的 history 末尾必须是 user）
    const userMsg: ChatMessage = {
      id: newMessageId(),
      conversationId: conv.id,
      role: 'user',
      text: 'busy test',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    };
    await appendMessage(agent.id, conv.id, userMsg);

    assert(!isConversationBusy(agent.id, conv.id), '初始：isConversationBusy=false');

    // 起 runChat（不 await，让它阻塞在 release）
    const messageId = newMessageId();
    const runP = runChat({
      agent,
      conversation: conv,
      messageId,
      userText: 'busy test',
      emit: () => {},
      onSdkSessionId: async () => {},
      onProposal: async () => {},
    });

    // 等几个 tick 让 runChat 进到 activeAbortControllers.set 那步
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert(isConversationBusy(agent.id, conv.id), '运行中：isConversationBusy=true');

    // 释放，让 runChat 收尾
    releaseStall();
    await runP;

    assert(!isConversationBusy(agent.id, conv.id), 'runChat 完成：isConversationBusy=false');
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
