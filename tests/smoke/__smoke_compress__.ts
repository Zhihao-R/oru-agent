/**
 * compress.ts smoke (v0.4)
 *
 * 验证 compressIfNeeded：
 * - 阈值未达到 → 返回 null
 * - 主路径：≥6 user，触发压缩；保留段 = 最近 5 轮 user 起
 * - 递减兜底：N=5 装不下 → N=4 装下（通知卡仍按 N=5 算 X 轮）
 * - N=1 仍超 → 抛 PostCompressOverflowError
 * - userIdxs<N → 抛 PostCompressOverflowError（不再走 fallback 硬丢，避免无限循环）
 * - 摘要 backend 抛错 → fallback=true（仍返回 trimmedHistory）
 * - 摘要 backend 缺失 → fallback
 * - 递增式：history 已含 context-compressed → previousSummary 喂回 prompt
 * - 切大窗口模型保留段恒定 5 轮
 *
 * 不打真 LLM——用 __setBackendFactoryForTest 替换。
 */
import './__smoke_isolate__';
import { compressIfNeeded, PostCompressOverflowError } from '../../electron/main/agent/context/compress';
import { __setBackendFactoryForTest } from '../../electron/main/agent/backends/factory';
import type { AgentBackend } from '@shared/agent/backend';
import type { ChatMessage } from '@shared/types';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== compress smoke ===');

function mkUser(id: string, text: string): ChatMessage {
  return {
    id,
    conversationId: 'c1',
    role: 'user',
    text,
    toolCalls: [],
    createdAt: 0,
    done: true,
  };
}
function mkAsst(id: string, text: string): ChatMessage {
  return {
    id,
    conversationId: 'c1',
    role: 'assistant',
    text,
    toolCalls: [],
    createdAt: 0,
    done: true,
  };
}

function makeMockBackend(opts: {
  oneShotResult?: string;
  oneShotThrows?: boolean;
  onPrompt?: (p: string) => void;
}): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'mdl_summary',
    providerId: 'prv_summary',
    runConversation: () => {
      throw new Error('not used');
    },
    runOneShot: async (input) => {
      opts.onPrompt?.(input.prompt);
      if (opts.oneShotThrows) throw new Error('summary failed');
      return { text: opts.oneShotResult ?? '生成的摘要' };
    },
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  };
}

async function expectThrow(fn: () => Promise<unknown>, name: string): Promise<unknown> {
  try {
    await fn();
    assert(false, `${name}: 期望抛错但没有`);
    return undefined;
  } catch (e) {
    return e;
  }
}

async function run() {
  // ─── 1. 阈值未达到 → null ─────────────────────────────────
  {
    const restore = __setBackendFactoryForTest(async () => makeMockBackend({}));
    try {
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history: [mkUser('u1', '短'), mkAsst('a1', '回答')],
        systemContext: '短',
        threshold: 100_000 * 0.8,
        force: false,
      });
      assert(result === null, '阈值未达到 → null');
    } finally {
      restore();
    }
  }

  // ─── 2. 主路径：6 user 触发压缩，保留 5 轮 ──────────────────
  {
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend({ oneShotResult: '【摘要内容】关键决策记录' }),
    );
    try {
      // 6 个 user + 5 assistant + 一个当前 user — 共 6 user 6 assist
      const history: ChatMessage[] = [
        mkUser('u1', 'OLD_MSG_'.repeat(40)),
        mkAsst('a1', 'OLD_REPLY_'.repeat(40)),
        mkUser('u2', 'OLD_MSG_'.repeat(40)),
        mkAsst('a2', 'OLD_REPLY_'.repeat(40)),
        mkUser('u3', 'OLD_MSG_'.repeat(40)),
        mkAsst('a3', 'OLD_REPLY_'.repeat(40)),
        mkUser('u4', 'M_'.repeat(40)),
        mkAsst('a4', 'R_'.repeat(40)),
        mkUser('u5', 'M_'.repeat(40)),
        mkAsst('a5', 'R_'.repeat(40)),
        mkUser('u6', '当前轮'),
      ];
      // 6 user：最近 5 个起 = u2..u6
      // toCompress = [u1, a1]（idx 0..1）
      // effectiveWindow=5000 → 阈值 4000，足够装下 N=5 保留段
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: 'system',
        threshold: 5000 * 0.8,
        force: true,
      });
      assert(result !== null, '主路径：触发压缩');
      assert(result?.fallback === false, 'fallback=false');
      assert(
        result?.notificationMessage.contextCompressed?.summaryText === '【摘要内容】关键决策记录',
        '通知卡 summaryText 正确',
      );
      // 保留段起点应是 u2
      assert(
        result?.trimmedHistory[1].id === 'u2',
        'trimmedHistory[1] = u2（5 user 起）',
        result?.trimmedHistory[1].id,
      );
      assert(
        result?.trimmedHistory[result.trimmedHistory.length - 1].id === 'u6',
        'trimmedHistory 末尾 = u6 当前轮',
      );
      // 通知卡文案"压缩了 1 轮"——startToCompress 含 1 user(u1)
      assert(
        result?.notificationMessage.text.includes('1 轮') === true,
        '通知卡按 user 轮数显示',
        result?.notificationMessage.text,
      );
    } finally {
      restore();
    }
  }

  // ─── 3. 递减兜底：N=5 装不下 → N=4 装下 ────────────────────
  {
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend({ oneShotResult: '摘要_短' }),
    );
    try {
      // 7 user + 6 assistant — 最后第 5 个 user 是很长内容,N=5 装不下
      // 两阶段后第一阶段按 SUMMARY_TOKEN_BUDGET=2250 占位选 n:
      // effectiveWindow=10000 → 阈值 8000;u3≈5850 token 撑爆 N=5(5850+2250>8000);
      // N=4 起算从 u4 起,缺 u3 那一大块,能装下
      const LONG = '长'.repeat(3900); // ~5850 token
      const SHORT = '短';
      const history: ChatMessage[] = [
        mkUser('u1', SHORT),
        mkAsst('a1', SHORT),
        mkUser('u2', SHORT),
        mkAsst('a2', SHORT),
        mkUser('u3', LONG),  // ← 最近第 5 个 user;装进 N=5 会撑爆
        mkAsst('a3', SHORT),
        mkUser('u4', SHORT), // ← 最近第 4 个 user
        mkAsst('a4', SHORT),
        mkUser('u5', SHORT),
        mkAsst('a5', SHORT),
        mkUser('u6', SHORT),
        mkAsst('a6', SHORT),
        mkUser('u7', '当前'),
      ];
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        threshold: 10_000 * 0.8, // 0.8 * 10000 = 8000 阈值
        force: true,
      });
      assert(result !== null, '递减：仍能压成功');
      // 期望 keepFromIdx 是 u4 那条而非 u3
      const firstAfterNotice = result?.trimmedHistory[1];
      assert(
        firstAfterNotice?.id === 'u4',
        '递减触发：保留段起点 = u4（N=4）',
        firstAfterNotice?.id,
      );
      // 通知卡按 final n（递减后实际生效的 n）的 user 轮数算——
      // N=5 装不下 → 递减到 N=4 装下。N=4 时 toCompress=[u1..u3 之前],即 [u1, a1, u2, a2, u3, a3]
      // = 3 个 user。这保证通知卡 compressedMessageIds 与 trimmedHistory 互补。
      assert(
        result?.notificationMessage.text.includes('3 轮') === true,
        '通知卡按 final n 的 user 轮数算（N=4 → toCompress 含 u1/u2/u3 = 3 user）',
        result?.notificationMessage.text,
      );
    } finally {
      restore();
    }
  }

  // ─── 4. N=1 仍超 → 抛 PostCompressOverflowError ────────────
  {
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend({ oneShotResult: '摘要' }),
    );
    try {
      // 5 user 都很短,但当前 user(u6)超大单条 + 历史 5 个 user 总和也大
      // 让 effectiveWindow 极小,即便 N=1(只保留 u6)也超 0.8 阈值
      const BIG = '大'.repeat(500); // ~750 token
      const history: ChatMessage[] = [
        mkUser('u1', BIG),
        mkAsst('a1', '短'),
        mkUser('u2', BIG),
        mkAsst('a2', '短'),
        mkUser('u3', BIG),
        mkAsst('a3', '短'),
        mkUser('u4', BIG),
        mkAsst('a4', '短'),
        mkUser('u5', BIG),
        mkAsst('a5', '短'),
        mkUser('u6', BIG), // 当前
      ];
      const err = await expectThrow(
        () =>
          compressIfNeeded({
            conversationId: 'c1',
            history,
            systemContext: '',
            threshold: 100 * 0.8, // 0.8 * 100 = 80 阈值; BIG 单条就超
            force: true,
          }),
        'N=1 仍超',
      );
      assert(err instanceof PostCompressOverflowError, 'N=1 抛 PostCompressOverflowError');
    } finally {
      restore();
    }
  }

  // ─── 5. userIdxs < N + force=true → 返回 null（让 runner 走 dropOldestTurns 兜底）─────
  {
    const restore = __setBackendFactoryForTest(async () => makeMockBackend({}));
    try {
      // 3 个 user — 不足 5
      const history: ChatMessage[] = [
        mkUser('u1', '内容'.repeat(80)),
        mkAsst('a1', 'R'.repeat(80)),
        mkUser('u2', '内容'.repeat(80)),
        mkAsst('a2', 'R'.repeat(80)),
        mkUser('u3', '当前'),
      ];
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        threshold: 50 * 0.8, // 阈值低,触发但 user 数不够
        force: true,
      });
      assert(
        result === null,
        'userIdxs<N + force=true → null（不抛错;runner 走 dropOldestTurns 兜底）',
      );
    } finally {
      restore();
    }
  }

  // ─── 6. userIdxs < N + 阈值未达 + force=false → null ────────
  {
    const restore = __setBackendFactoryForTest(async () => makeMockBackend({}));
    try {
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history: [mkUser('u1', '短'), mkAsst('a1', '短'), mkUser('u2', '短')],
        systemContext: '',
        threshold: 100_000 * 0.8,
        force: false,
      });
      assert(result === null, 'userIdxs<N + 阈值未达 → null（不触发也不抛）');
    } finally {
      restore();
    }
  }

  // ─── 7. 摘要 backend 抛错 → fallback=true ────────────────
  {
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend({ oneShotThrows: true }),
    );
    try {
      // 6 user 满足 N=5;摘要 backend 抛错
      const history: ChatMessage[] = [
        mkUser('u1', 'X'.repeat(40)),
        mkAsst('a1', 'Y'.repeat(40)),
        mkUser('u2', 'X'.repeat(40)),
        mkAsst('a2', 'Y'.repeat(40)),
        mkUser('u3', 'X'.repeat(40)),
        mkAsst('a3', 'Y'.repeat(40)),
        mkUser('u4', 'X'.repeat(40)),
        mkAsst('a4', 'Y'.repeat(40)),
        mkUser('u5', 'X'.repeat(40)),
        mkAsst('a5', 'Y'.repeat(40)),
        mkUser('u6', '当前'),
      ];
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        // 两阶段后窗口须先装得下 SUMMARY_TOKEN_BUDGET 占位,否则第一阶段直接抛 overflow
        threshold: 10_000 * 0.8,
        force: true,
      });
      assert(result !== null, '失败时仍返回 result');
      assert(result?.fallback === true, 'fallback=true');
      assert(
        result?.notificationMessage.text.includes('生成失败') === true,
        '通知卡含"生成失败"',
      );
    } finally {
      restore();
    }
  }

  // ─── 8. 摘要 backend 缺失 → fallback ─────────────────────
  {
    const restore = __setBackendFactoryForTest(async () => {
      throw new Error('no backend configured');
    });
    try {
      const history: ChatMessage[] = [
        mkUser('u1', 'X'.repeat(40)),
        mkAsst('a1', 'Y'.repeat(40)),
        mkUser('u2', 'X'.repeat(40)),
        mkAsst('a2', 'Y'.repeat(40)),
        mkUser('u3', 'X'.repeat(40)),
        mkAsst('a3', 'Y'.repeat(40)),
        mkUser('u4', 'X'.repeat(40)),
        mkAsst('a4', 'Y'.repeat(40)),
        mkUser('u5', 'X'.repeat(40)),
        mkAsst('a5', 'Y'.repeat(40)),
        mkUser('u6', '当前'),
      ];
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        threshold: 100 * 0.8,
        force: true,
      });
      assert(result !== null, '没 backend 时仍返回 result');
      assert(result?.fallback === true, '没 backend 时 fallback=true');
    } finally {
      restore();
    }
  }

  // ─── 9. 递增式摘要 ────────────────────────────────────────
  {
    let receivedPrompt = '';
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend({
        oneShotResult: '新摘要 v2',
        onPrompt: (p) => {
          receivedPrompt = p;
        },
      }),
    );
    try {
      const oldSummaryCard: ChatMessage = {
        id: 'cc_old',
        conversationId: 'c1',
        role: 'system',
        text: '已压缩',
        toolCalls: [],
        createdAt: 0,
        done: true,
        kind: 'context-compressed',
        contextCompressed: {
          compressedMessageIds: ['oldid1'],
          summaryText: '【上次摘要】之前的对话讲了 X',
          fallback: false,
        },
      };
      // 上次摘要 + 6 user 让 N=5 切到 u2
      const history: ChatMessage[] = [
        oldSummaryCard,
        mkUser('u1', 'NEW_USER_'.repeat(30)),
        mkAsst('a1', 'NEW_ASST_'.repeat(30)),
        mkUser('u2', 'NEW_USER_'.repeat(30)),
        mkAsst('a2', 'NEW_ASST_'.repeat(30)),
        mkUser('u3', 'NEW_USER_'.repeat(30)),
        mkAsst('a3', 'NEW_ASST_'.repeat(30)),
        mkUser('u4', 'NEW_USER_'.repeat(30)),
        mkAsst('a4', 'NEW_ASST_'.repeat(30)),
        mkUser('u5', 'NEW_USER_'.repeat(30)),
        mkAsst('a5', 'NEW_ASST_'.repeat(30)),
        mkUser('u6', '当前 user'),
      ];
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        // 两阶段后窗口须先装得下 SUMMARY_TOKEN_BUDGET 占位,否则第一阶段直接抛 overflow
        threshold: 10_000 * 0.8,
        force: true,
      });
      assert(result !== null, '递增式：触发压缩');
      assert(
        receivedPrompt.includes('【上次摘要】之前的对话讲了 X'),
        '递增式：previousSummary 喂回 prompt',
        receivedPrompt.slice(0, 200),
      );
      assert(
        !receivedPrompt.includes('oldid1'),
        '递增式：旧的被压缩消息 id 不再喂回',
      );
    } finally {
      restore();
    }
  }

  // ─── 10. 切大窗口模型回归：保留段恒定 5 轮 ───────────────
  {
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend({ oneShotResult: '摘要' }),
    );
    try {
      const history: ChatMessage[] = [
        mkUser('u1', 'X'.repeat(40)),
        mkAsst('a1', 'Y'.repeat(40)),
        mkUser('u2', 'X'.repeat(40)),
        mkAsst('a2', 'Y'.repeat(40)),
        mkUser('u3', 'X'.repeat(40)),
        mkAsst('a3', 'Y'.repeat(40)),
        mkUser('u4', 'X'.repeat(40)),
        mkAsst('a4', 'Y'.repeat(40)),
        mkUser('u5', 'X'.repeat(40)),
        mkAsst('a5', 'Y'.repeat(40)),
        mkUser('u6', 'X'.repeat(40)),
        mkAsst('a6', 'Y'.repeat(40)),
        mkUser('u7', '当前'),
      ];
      // 小窗口下保留段（小但够装 N=5；不触发递减）
      const small = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        threshold: 5000 * 0.8,
        force: true,
      });
      const smallKept = small?.trimmedHistory.filter((m) => m.role === 'user').length;

      // 大窗口下 force=true 也应保留同样 5 个 user（保留段不随 window 变）
      const large = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        threshold: 200_000 * 0.8,
        force: true,
      });
      const largeKept = large?.trimmedHistory.filter((m) => m.role === 'user').length;
      assert(
        smallKept === largeKept,
        '切大窗口保留段 user 数恒定',
        `small=${smallKept} large=${largeKept}`,
      );
      assert(smallKept === 5, '保留段恰好 5 个 user', String(smallKept));
    } finally {
      restore();
    }
  }
}

run().then(() => {
  const passed = RESULTS.filter((r) => r.ok).length;
  const total = RESULTS.length;
  if (passed === total) {
    console.log(`\nPASS: all ${total} cases`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: ${passed}/${total} cases`);
    for (const r of RESULTS.filter((x) => !x.ok)) {
      console.log(`  FAIL: ${r.name} — ${r.detail ?? ''}`);
    }
    process.exit(1);
  }
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
