/**
 * v0.5 wireHistory resume 路径 smoke
 *
 * 验证 claudeCode resume 路径的 onInferenceView 回调契约：
 * - adapterRan === false（adapter 没跑）
 * - wireHistory === []（空数组，跟 adapterRan 配套）
 * - savings 全 0（没有裁剪可言）
 *
 * 不起真实 SDK——通过 toolContext 注入 callback 验证回调契约。
 * 走 ClaudeCodeBackend.runConversation 的非 seed-history 分支（shouldSeedHistory=false）。
 */
import './__smoke_isolate__';
import type { ConversationInput } from '@shared/agent/backend';
import type { NormalizedMessage } from '@shared/agent/normalizedMessage';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

console.log('=== v0.5 wireHistory resume smoke ===');

// ─── 触发 claudeCode resume 路径：history 为空 + 无 resumeSessionId ────────
//     按 claudeCode.ts 的逻辑：!resumeSessionId && history.length === 0 → shouldSeedHistory=false
//     进入 !shouldSeedHistory 分支调 onInferenceView
{
  let captured:
    | { enabled: boolean; adapterRan: boolean; savings: unknown; wireHistory: NormalizedMessage[] }
    | null = null;

  const backend = new ClaudeCodeBackend();

  const ac = new AbortController();
  // 触发后立刻 abort——只要 onInferenceView 在 runConversation 内被同步调用即可
  const input: ConversationInput = {
    agentId: 'a1',
    conversationId: 'c1',
    userMessage: 'hi',
    history: [], // 空历史 + 无 resumeSessionId → 走 resume 分支
    cwd: '/tmp',
    abortController: ac,
    onInferenceView: (info) => {
      captured = info;
    },
  };

  // 起 runConversation 但立刻 abort——onInferenceView 在 engine.run 之前被调
  const handle = backend.runConversation(input);
  ac.abort();
  // 消费一次事件流让 generator 跑到回调点；用 setTimeout 0 等微任务
  (async () => {
    try {
      // for-await 一下，吞掉 abort 异常
      for await (const _ev of handle.events) {
        void _ev;
      }
    } catch {
      // 预期会被 abort 终止，不算失败
    }
  })();

  // 给微任务一点时间
  await new Promise((r) => setTimeout(r, 50));

  assert(captured !== null, 'onInferenceView 被调用（resume 路径）');
  if (captured) {
    const c = captured as {
      enabled: boolean;
      adapterRan: boolean;
      savings: {
        systemMessagesFiltered: number;
        persistedReplaced: number;
        persistedCharsReduced: number;
        writeAckDeduped: number;
        writeAckCharsReduced: number;
      };
      wireHistory: NormalizedMessage[];
    };
    assert(c.adapterRan === false, 'adapterRan === false');
    assert(Array.isArray(c.wireHistory) && c.wireHistory.length === 0, 'wireHistory === []', String(c.wireHistory));
    assert(c.savings.systemMessagesFiltered === 0, 'savings.systemMessagesFiltered === 0');
    assert(c.savings.persistedReplaced === 0, 'savings.persistedReplaced === 0');
    assert(c.savings.persistedCharsReduced === 0, 'savings.persistedCharsReduced === 0');
    assert(c.savings.writeAckDeduped === 0, 'savings.writeAckDeduped === 0');
    assert(c.savings.writeAckCharsReduced === 0, 'savings.writeAckCharsReduced === 0');
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
