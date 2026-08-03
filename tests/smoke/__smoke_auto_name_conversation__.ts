/**
 * autoNameConversation smoke
 *
 * 命名前置：在用户首条消息（尚无 assistant 回复）落盘后即时触发。验证：
 * 1. 命名成功 → conv title 被替换（只凭首条 user 消息）
 * 2. LLM 抛错 → title 保留默认，不影响主流程
 * 3. 用户已改过名 → 不覆盖
 * 4. 非首条（已有 assistant 回复）不再命名（assistantCount > 0）
 * 5. 未配置 conversationTitle 模型 → 完全不调 backend
 * 6. sanitize：去引号 / 截断 / 取第一行
 * 7. LLM 返回空白 → 放弃
 * 8. disableReasoning: true 透传
 *
 * 不打真 LLM——用 __setBackendFactoryForTest 替换。
 */
import './__smoke_isolate__';
import { maybeAutoNameConversation } from '../../electron/main/agent/autoNameConversation';
import { __setBackendFactoryForTest } from '../../electron/main/agent/backends/factory';
import {
  appendMessage,
  createSubConversation,
  getConversation,
  renameConversation,
} from '../../electron/main/conversations/store';
import { updateSettings, __clearCacheForTest } from '../../electron/main/projects/store';
import { newMessageId } from '@shared/ids';
import { DEFAULT_NEW_CONV_TITLE, type Settings } from '@shared/types';
import type { AgentBackend } from '@shared/agent/backend';
import type { ConvStateEvent } from '@shared/protocol';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

const AGENT_ID = 'agent_autoname';

console.log('=== autoNameConversation smoke ===');

function mkMockBackend(opts: {
  oneShotResult?: string;
  oneShotThrows?: Error;
  onPrompt?: (p: string) => void;
  onInput?: (i: { prompt: string; disableReasoning?: boolean }) => void;
}): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'mdl_title',
    providerId: 'prv_title',
    runConversation: () => {
      throw new Error('not used');
    },
    runOneShot: async (input) => {
      opts.onPrompt?.(input.prompt);
      opts.onInput?.(input);
      if (opts.oneShotThrows) throw opts.oneShotThrows;
      return { text: opts.oneShotResult ?? '默认标题' };
    },
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  };
}

/**
 * 给 conv 落一条 user 消息——模拟「用户刚发首条消息、尚无 assistant 回复」的命名现场
 */
async function seedFirstUser(convId: string, userText: string) {
  await appendMessage(AGENT_ID, convId, {
    id: newMessageId(),
    conversationId: convId,
    role: 'user',
    text: userText,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  });
}

/** 落一条 assistant 回复——用于造「已有一轮」的现场（不该再命名） */
async function seedAssistantReply(convId: string, text: string) {
  await appendMessage(AGENT_ID, convId, {
    id: newMessageId(),
    conversationId: convId,
    role: 'assistant',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  });
}

/** 设置 modelAssignments.conversationTitle 为某 model id（非 null） */
async function setTitleModel(modelId: string | null): Promise<void> {
  __clearCacheForTest();
  // updateSettings 用浅 merge，必须传完整 modelAssignments
  const patch: Partial<Settings> = {
    modelAssignments: {
      twinMain: null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: null,
      conversationSummary: null,
      conversationTitle: modelId,
    },
  };
  await updateSettings(patch);
}

async function run() {
  // ─── 1. 命名成功（只凭首条 user 消息）─────────────────────
  {
    await setTitleModel('mdl_title');
    const conv = await createSubConversation(AGENT_ID, DEFAULT_NEW_CONV_TITLE);
    await seedFirstUser(conv.id, '我想做一个个人理财 app');
    let promptSeen = '';
    const restore = __setBackendFactoryForTest(async () =>
      mkMockBackend({ oneShotResult: '理财 app 设计', onPrompt: (p) => (promptSeen = p) }),
    );
    const broadcasts: ConvStateEvent[] = [];
    try {
      await maybeAutoNameConversation({
        agentId: AGENT_ID,
        conversationId: conv.id,
        userText: '我想做一个个人理财 app',
        broadcast: (ev) => broadcasts.push(ev),
      });
    } finally {
      restore();
    }
    const updated = await getConversation(AGENT_ID, conv.id);
    assert(updated.title === '理财 app 设计', '命名成功：title 被替换', updated.title);
    assert(promptSeen.includes('我想做一个个人理财 app'), 'prompt 含 user text');
    assert(!promptSeen.includes('assistant'), 'prompt 只凭首条消息（不含 assistant 段）');
    assert(broadcasts.length === 1 && broadcasts[0].type === 'conv.state', '广播了一次 conv.state');
  }

  // ─── 2. LLM 抛错 → 保留默认名 ─────────────────────────────
  {
    await setTitleModel('mdl_title');
    const conv = await createSubConversation(AGENT_ID, DEFAULT_NEW_CONV_TITLE);
    await seedFirstUser(conv.id, 'q');
    const restore = __setBackendFactoryForTest(async () =>
      mkMockBackend({ oneShotThrows: new Error('模拟 LLM 故障') }),
    );
    const broadcasts: ConvStateEvent[] = [];
    try {
      await maybeAutoNameConversation({
        agentId: AGENT_ID,
        conversationId: conv.id,
        userText: 'q',
        broadcast: (ev) => broadcasts.push(ev),
      });
    } finally {
      restore();
    }
    const updated = await getConversation(AGENT_ID, conv.id);
    assert(updated.title === DEFAULT_NEW_CONV_TITLE, 'LLM 抛错：title 保留默认', updated.title);
    assert(broadcasts.length === 0, '失败时不广播');
  }

  // ─── 3. 用户已改过名 → 不覆盖 ────────────────────────────
  {
    await setTitleModel('mdl_title');
    const conv = await createSubConversation(AGENT_ID, DEFAULT_NEW_CONV_TITLE);
    await renameConversation(AGENT_ID, conv.id, '我自己起的名');
    await seedFirstUser(conv.id, 'q');
    let oneShotCalled = false;
    const restore = __setBackendFactoryForTest(async () => {
      oneShotCalled = true;
      return mkMockBackend({ oneShotResult: 'LLM 想覆盖的名字' });
    });
    try {
      await maybeAutoNameConversation({
        agentId: AGENT_ID,
        conversationId: conv.id,
        userText: 'q',
        broadcast: () => {},
      });
    } finally {
      restore();
    }
    const updated = await getConversation(AGENT_ID, conv.id);
    assert(updated.title === '我自己起的名', '用户改过名：保留用户的名字', updated.title);
    assert(oneShotCalled === false, '用户改过名：连 backend 都不取（早返回）');
  }

  // ─── 4. 非首条（已有 assistant 回复）不再命名 ──────────────
  {
    await setTitleModel('mdl_title');
    const conv = await createSubConversation(AGENT_ID, DEFAULT_NEW_CONV_TITLE);
    // 现场：已有一轮完整对话（user1 + assistant1），又发一条 user2 → assistantCount>0，不该命名
    await seedFirstUser(conv.id, 'q1');
    await seedAssistantReply(conv.id, 'a1');
    let oneShotCalled = false;
    const restore = __setBackendFactoryForTest(async () => {
      oneShotCalled = true;
      return mkMockBackend({ oneShotResult: '不该被写入' });
    });
    try {
      await maybeAutoNameConversation({
        agentId: AGENT_ID,
        conversationId: conv.id,
        userText: 'q2',
        broadcast: () => {},
      });
    } finally {
      restore();
    }
    const updated = await getConversation(AGENT_ID, conv.id);
    assert(updated.title === DEFAULT_NEW_CONV_TITLE, '非首条：title 不变', updated.title);
    assert(oneShotCalled === false, '非首条：不调 backend');
  }

  // ─── 5. 未配置 conversationTitle → 完全不调 backend ───────
  {
    await setTitleModel(null);
    const conv = await createSubConversation(AGENT_ID, DEFAULT_NEW_CONV_TITLE);
    await seedFirstUser(conv.id, 'q');
    let oneShotCalled = false;
    const restore = __setBackendFactoryForTest(async () => {
      oneShotCalled = true;
      return mkMockBackend({ oneShotResult: '不该被调' });
    });
    try {
      await maybeAutoNameConversation({
        agentId: AGENT_ID,
        conversationId: conv.id,
        userText: 'q',
        broadcast: () => {},
      });
    } finally {
      restore();
    }
    const updated = await getConversation(AGENT_ID, conv.id);
    assert(updated.title === DEFAULT_NEW_CONV_TITLE, '未配置：title 不变');
    assert(oneShotCalled === false, '未配置：不调 backend');
  }

  // ─── 6. sanitize：去引号 / 截断 / 取第一行 ───────────────
  {
    await setTitleModel('mdl_title');
    const cases: Array<{ raw: string; expect: string; label: string }> = [
      { raw: '"带英文引号"', expect: '带英文引号', label: '去英文引号' },
      { raw: '「带中文引号」', expect: '带中文引号', label: '去中文引号' },
      { raw: '《书名号》', expect: '书名号', label: '去书名号' },
      {
        raw: '这是一个非常非常非常非常非常长的标题超过二十四个字符肯定要截断',
        expect: '这是一个非常非常非常非常非常长的标题超过二十四个',
        label: '截断到 24 字符',
      },
      { raw: '第一行标题\n第二行是解释', expect: '第一行标题', label: '只取第一行' },
      { raw: '   两边带空格   ', expect: '两边带空格', label: '去首尾空白' },
    ];
    for (const { raw, expect, label } of cases) {
      const conv = await createSubConversation(AGENT_ID, DEFAULT_NEW_CONV_TITLE);
      await seedFirstUser(conv.id, 'q');
      const restore = __setBackendFactoryForTest(async () =>
        mkMockBackend({ oneShotResult: raw }),
      );
      try {
        await maybeAutoNameConversation({
          agentId: AGENT_ID,
          conversationId: conv.id,
          userText: 'q',
          broadcast: () => {},
        });
      } finally {
        restore();
      }
      const updated = await getConversation(AGENT_ID, conv.id);
      assert(updated.title === expect, `sanitize: ${label}`, `got=${updated.title}`);
    }
  }

  // ─── 7. sanitize：空字符串放弃 ──────────────────────────
  {
    await setTitleModel('mdl_title');
    const conv = await createSubConversation(AGENT_ID, DEFAULT_NEW_CONV_TITLE);
    await seedFirstUser(conv.id, 'q');
    const restore = __setBackendFactoryForTest(async () =>
      mkMockBackend({ oneShotResult: '   ' }),
    );
    try {
      await maybeAutoNameConversation({
        agentId: AGENT_ID,
        conversationId: conv.id,
        userText: 'q',
        broadcast: () => {},
      });
    } finally {
      restore();
    }
    const updated = await getConversation(AGENT_ID, conv.id);
    assert(
      updated.title === DEFAULT_NEW_CONV_TITLE,
      'LLM 返回空白：保留默认名',
      updated.title,
    );
  }

  // ─── 8. 关 reasoning：autoName 调用必须透 disableReasoning:true ─
  //
  // 这条 smoke 是为 2026-05-26 那次 bug 加的回归——hy3-preview 这类 OR reasoning 模型，
  // runOneShot 不显式关 thinking 会 1500+ reasoning tokens / 20-30s 调用 / 超时静默失败。
  // 盯**入口意图**：autoName 模块自己有没有把 disableReasoning 标志透下去。改 autoName 时
  // 少传这个字段就会让修复倒退——但 typecheck 看不出来（字段 optional），只有这条 smoke 能挡。
  {
    await setTitleModel('mdl_title');
    const conv = await createSubConversation(AGENT_ID, DEFAULT_NEW_CONV_TITLE);
    await seedFirstUser(conv.id, 'q');
    let seenInput: { prompt: string; disableReasoning?: boolean } | null = null;
    const restore = __setBackendFactoryForTest(async () =>
      mkMockBackend({
        oneShotResult: '不带思考的标题',
        onInput: (i) => (seenInput = i),
      }),
    );
    try {
      await maybeAutoNameConversation({
        agentId: AGENT_ID,
        conversationId: conv.id,
        userText: 'q',
        broadcast: () => {},
      });
    } finally {
      restore();
    }
    assert(
      seenInput !== null && seenInput!.disableReasoning === true,
      'autoName 透 disableReasoning:true 给 backend',
      `got=${JSON.stringify(seenInput)}`,
    );
  }

  // ─── 汇总 ───────────────────────────────────────────────
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n${RESULTS.length - failed.length}/${RESULTS.length} 通过`);
  if (failed.length > 0) {
    console.log('失败：');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

void run();
