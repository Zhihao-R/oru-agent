/**
 * Smoke：对话期 Subagent runner + 工具集 + sidecar 持久化 + 嵌套保护
 *
 * 验证：
 * 1. 基本派遣：mock backend 返回固定 text，runSubagent 拿到 finalText 返回给 Task 工具
 * 2. Sidecar 落盘 jsonl：subagent 内部 tool_use + tool_result + assistant_text 各落一行
 * 3. 前缀逐字一致：两次派遣的 system prompt 前缀逐字相等（cache 命中前提）
 * 4. Abort 透传：parent abort → subagent backend 收到 abort + chip status='error'
 * 5. 嵌套拒绝：subagent 工具集（disallowedTools 过滤后）不含 Task
 * 6. 副作用审批透传：subagent 内部触发 onProposal → parentOnProposal 被调用 + proposal.triggeredBySubagent 正确
 * 7. nominal type：buildStableSystemContext 出口返回 StableSystemContext brand
 *
 * 用法：tsx --tsconfig tsconfig.node.json tests/smoke/__smoke_subagent_chat__.ts
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import type {
  AgentBackend,
  ConversationEvent,
  ConversationHandle,
  ConversationInput,
  StableSystemContext,
} from '@shared/agent/backend';
import type { ActionProposal, ChatMessage } from '@shared/types';
import { runSubagent } from '../../electron/main/agent/subagentChat/runner';
import { readSidecar } from '../../electron/main/agent/subagentChat/sidecar';
import { buildStableSystemContext } from '../../electron/main/agent/stableSystemContext';
import { subagentSidecarFile } from '../../electron/main/runtime/paths';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

/** Mock backend：录入接收到的 system，按预设 events 流式 emit */
function makeMockBackend(opts: {
  events?: ConversationEvent[];
  /** 记录每次 runConversation 的入参，用于断言 */
  capturedInputs: ConversationInput[];
  /** 控制 abortable 模式：events 不结束，等 abort 信号到才退出 */
  awaitAbort?: boolean;
}): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'test-model',
    providerId: 'test-provider',
    runConversation(input: ConversationInput): ConversationHandle {
      opts.capturedInputs.push(input);
      const events: ConversationEvent[] = opts.events ?? [
        { type: 'assistant_text', text: 'mock subagent output' },
        { type: 'result', resultText: 'mock subagent output', isError: false },
      ];
      const awaitAbort = opts.awaitAbort ?? false;
      return {
        events: (async function* () {
          if (awaitAbort) {
            // 等到 abort 信号到达再 yield ——模拟长跑的 subagent
            await new Promise<void>((resolve, reject) => {
              if (input.abortController.signal.aborted) {
                reject(new Error('aborted'));
                return;
              }
              input.abortController.signal.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              );
            }).catch((e) => {
              throw e;
            });
          }
          for (const ev of events) {
            yield ev;
          }
        })(),
      };
    },
    runOneShot: async () => ({ text: 'noop' }),
    registerTool: () => undefined,
    unregisterTool: () => undefined,
    isReady: async () => ({ ok: true, hint: '' }),
  };
}

async function main(): Promise<void> {
  console.log('=== subagent_chat smoke ===');

  const OWNER = 'local-user';
  const AGENT = 'twin';
  const CONV = 'smoke-conv-1';
  const stable = ('STABLE_PREFIX_' + 'a'.repeat(200)) as StableSystemContext;
  const capturedInputs: ConversationInput[] = [];

  // ─── 用例 1: 基本派遣 + 返回 ─────────────────────────────────────
  {
    const backend = makeMockBackend({ capturedInputs });
    const chips: ChatMessage[] = [];
    const persisted: ChatMessage[] = [];
    const result = await runSubagent(
      { description: 'writer 角色', prompt: '写一个程序员相亲笑话' },
      {
        conversationId: CONV,
        agentId: AGENT,
        ownerId: OWNER,
        backend,
        parentStableSystemContext: stable,
        cwd: '/tmp',
        approvalMode: 'work',
        abortSignal: new AbortController().signal,
        inherited: {},
        broadcastChip: (c) => chips.push(c),
        persistChip: async (c) => {
          persisted.push(c);
        },
      },
    );
    assert(
      result.text === 'mock subagent output' && !result.isError,
      'case#1 基本派遣返回 finalText',
      `text=${JSON.stringify(result.text)} isError=${result.isError}`,
    );
    assert(
      persisted.length === 1 && persisted[0].kind === 'subagent' && persisted[0].subagent?.status === 'completed',
      'case#1 最终 chip 落盘 status=completed',
    );
    assert(chips.length >= 1, 'case#1 至少广播过一次 running chip');
  }

  // ─── 用例 3: 前缀逐字一致（连派两次） ──────────────────────────
  {
    const backend2 = makeMockBackend({ capturedInputs });
    for (let i = 0; i < 2; i += 1) {
      await runSubagent(
        { description: `audience ${i}`, prompt: 'react!' },
        {
          conversationId: CONV,
          agentId: AGENT,
          ownerId: OWNER,
          backend: backend2,
          parentStableSystemContext: stable,
          cwd: '/tmp',
          abortSignal: new AbortController().signal,
          inherited: {},
          broadcastChip: () => undefined,
          persistChip: async () => undefined,
        },
      );
    }
    // capturedInputs[1..3] = 这两次 subagent 的请求（case#1 一次 + 这里两次 = 共 3 次）
    const last2 = capturedInputs.slice(-2);
    const sys0 = last2[0].systemContext ?? '';
    const sys1 = last2[1].systemContext ?? '';
    assert(sys0 === sys1, 'case#3 两次 subagent 派遣的 system prompt 前缀逐字相等');
    assert(sys0.startsWith(stable as string), 'case#3 前缀以 parentStableSystemContext 起始');
  }

  // ─── 用例 5: 嵌套拒绝（disallowedTools 含 Task） ───────────────
  {
    const last = capturedInputs[capturedInputs.length - 1];
    assert(
      Array.isArray(last.disallowedTools) && last.disallowedTools.includes('Task'),
      'case#5 subagent 调用 backend 时禁用了 Task 工具（嵌套保护）',
      `disallowed=${JSON.stringify(last.disallowedTools)}`,
    );
  }

  // ─── 用例 2: Sidecar jsonl 落盘 ─────────────────────────────────
  {
    const innerEvents: ConversationEvent[] = [
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/a.md' } },
      { type: 'tool_result', toolUseId: 'tu_1', isError: false, content: 'file content' },
      { type: 'assistant_text', text: 'after reading file: done' },
      { type: 'result', resultText: 'after reading file: done', isError: false },
    ];
    const backend = makeMockBackend({ capturedInputs, events: innerEvents });
    let capturedTaskId: string | null = null;
    await runSubagent(
      { description: 'reader', prompt: 'read /a.md' },
      {
        conversationId: CONV,
        agentId: AGENT,
        ownerId: OWNER,
        backend,
        parentStableSystemContext: stable,
        cwd: '/tmp',
        approvalMode: 'work',
        abortSignal: new AbortController().signal,
        inherited: {},
        broadcastChip: (c) => {
          if (c.subagent && capturedTaskId === null) capturedTaskId = c.subagent.taskId;
        },
        persistChip: async () => undefined,
      },
    );
    if (!capturedTaskId) {
      assert(false, 'case#2 拿到 taskId');
    } else {
      const messages = await readSidecar(OWNER, AGENT, CONV, capturedTaskId);
      const sidecarPath = subagentSidecarFile(OWNER, AGENT, CONV, capturedTaskId);
      assert(existsSync(sidecarPath), 'case#2 sidecar 文件存在', sidecarPath);
      // 期待至少 3 条：tool_use chip / tool_result / 最终 assistant_text
      assert(
        messages.length >= 3,
        'case#2 sidecar 至少含 3 条 inner message',
        `count=${messages.length}`,
      );
      const hasToolCall = messages.some((m) => m.toolCalls.length > 0);
      // tool_result 用 role='system'，text 前缀 '[tool_result]'（ChatRole 不含 'tool'）
      const hasToolResult = messages.some((m) => m.role === 'system' && m.text.startsWith('[tool_result'));
      const hasFinalText = messages.some((m) => m.role === 'assistant' && m.text.includes('done'));
      assert(hasToolCall, 'case#2 sidecar 含 tool_use 记录');
      assert(hasToolResult, 'case#2 sidecar 含 tool_result 记录');
      assert(hasFinalText, 'case#2 sidecar 含最终 assistant text');
      // jsonl 格式：文件内容按 \n 分割且每行可独立 parse
      const raw = await fs.readFile(sidecarPath, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const allParseable = lines.every((l) => {
        try {
          JSON.parse(l);
          return true;
        } catch {
          return false;
        }
      });
      assert(allParseable && lines.length >= 3, 'case#2 sidecar 是合法 jsonl（每行可独立 parse）');
    }
  }

  // ─── 用例 4: Abort 透传 + AbortError 区分 ───────────────────────
  {
    const backend = makeMockBackend({ capturedInputs, awaitAbort: true });
    const abortCtrl = new AbortController();
    const persisted: ChatMessage[] = [];
    // 50ms 后触发 abort
    setTimeout(() => abortCtrl.abort(), 50);
    const result = await runSubagent(
      { description: 'long-running', prompt: 'think forever' },
      {
        conversationId: CONV,
        agentId: AGENT,
        ownerId: OWNER,
        backend,
        parentStableSystemContext: stable,
        cwd: '/tmp',
        approvalMode: 'work',
        abortSignal: abortCtrl.signal,
        inherited: {},
        broadcastChip: () => undefined,
        persistChip: async (c) => {
          persisted.push(c);
        },
      },
    );
    assert(result.isError === true, 'case#4 abort 后 ToolResult.isError=true');
    assert(
      persisted.length === 1 && persisted[0].subagent?.status === 'error',
      'case#4 abort 后 chip status=error',
    );
    assert(
      persisted[0].subagent?.errorMessage === '用户取消',
      'case#4 abort 错误信息标记为"用户取消"（区分网络错）',
      `errorMessage=${JSON.stringify(persisted[0].subagent?.errorMessage)}`,
    );
  }

  // ─── 用例 6: parentOnProposal 透传 + triggeredBySubagent ───────
  {
    let backendInput: ConversationInput | null = null;
    const innerEvents: ConversationEvent[] = [
      { type: 'assistant_text', text: 'ok' },
      { type: 'result', resultText: 'ok', isError: false },
    ];
    const backend: AgentBackend = {
      backendType: 'anthropic',
      toolProtocol: 'anthropic-native',
      runConversation(input: ConversationInput): ConversationHandle {
        backendInput = input;
        return {
          events: (async function* () {
            for (const ev of innerEvents) yield ev;
          })(),
        };
      },
      runOneShot: async () => ({ text: '' }),
      registerTool: () => undefined,
      unregisterTool: () => undefined,
      isReady: async () => ({ ok: true, hint: '' }),
    };

    const captured: ActionProposal[] = [];
    const onProposal = async (p: ActionProposal) => {
      captured.push(p);
    };

    await runSubagent(
      { description: 'writer', prompt: 'do x' },
      {
        conversationId: CONV,
        agentId: AGENT,
        ownerId: OWNER,
        backend,
        parentStableSystemContext: stable,
        cwd: '/tmp',
        approvalMode: 'work',
        abortSignal: new AbortController().signal,
        inherited: { onProposal },
        broadcastChip: () => undefined,
        persistChip: async () => undefined,
      },
    );

    assert(backendInput !== null, 'case#6 backend 收到 runConversation 调用');
    if (backendInput) {
      const ctx = (backendInput as ConversationInput).toolContext;
      assert(
        !!ctx && ctx.usage === 'twinSubagent',
        'case#6 subagent toolContext.usage = twinSubagent',
      );
      assert(
        !!ctx && ctx.conversationId === CONV,
        'case#6 subagent toolContext.conversationId 是主对话 ID（不是子级 ID）',
      );
      assert(
        !!ctx && typeof ctx.onProposal === 'function',
        'case#6 subagent toolContext 挂了包装后的 onProposal',
      );
      assert(
        !!ctx && ctx.runSubagent === undefined,
        'case#6 subagent toolContext 不挂 runSubagent（嵌套保护双层）',
      );
      // 模拟 subagent 内部工具调到 onProposal —— 应该走到 parentOnProposal + 带 triggeredBySubagent
      const fakeProposal = {
        id: 'p1',
        ownerId: OWNER,
        conversationId: CONV,
        title: 't',
        description: 'd',
        createdAt: Date.now(),
        status: 'pending' as const,
        kind: 'code' as const,
        targetProjectId: null,
        risk: 'low' as const,
        rollbackable: true,
        rawPlan: 'plan',
      };
      await ctx!.onProposal!(fakeProposal as ActionProposal);
      assert(captured.length === 1, 'case#6 parentOnProposal 被调用一次');
      const augmented = captured[0];
      assert(
        augmented.triggeredBySubagent?.description === 'writer',
        'case#6 augmented proposal 含 triggeredBySubagent.description',
      );
      assert(
        typeof augmented.triggeredBySubagent?.taskId === 'string' &&
          augmented.triggeredBySubagent!.taskId.startsWith('sub_'),
        'case#6 triggeredBySubagent.taskId 是 sub_ 开头',
      );
    }
  }

  // ─── 用例 8: cache stable 段不含 SUFFIX（命中主对话 cache 的前提） ─
  {
    // 取最后一次 capturedInputs（subagent 派遣）的 stableSystemContext
    const last = capturedInputs[capturedInputs.length - 1];
    assert(
      last.stableSystemContext === (stable as string),
      'case#8 subagent stableSystemContext 跟 parentStable 逐字一致（不含 SUBAGENT_ROLE_SUFFIX）',
      `stableLen=${last.stableSystemContext?.length} parentLen=${(stable as string).length}`,
    );
    assert(
      (last.systemContext ?? '').startsWith((stable as string)),
      'case#8 systemContext 仍是 stable + SUFFIX 完整段（cache 命中后 SUFFIX 作为 dynamic）',
    );
    assert(
      (last.systemContext ?? '').length > (stable as string).length,
      'case#8 systemContext 真的拼了 SUFFIX 进去',
    );
  }

  // ─── 用例 9: factory 层自动让 twinSubagent 工具集 = twinMain - Task ─
  {
    // 用现有 factory_tool_register smoke 同款工具：清空注册表，注册一个虚拟工具到 twinMain
    const { __clearToolRegistryForTest, __listRegisteredToolsForTest, getBackendFor, registerTool } =
      await import('../../electron/main/agent/backends');
    __clearToolRegistryForTest();
    // 注册"未来才会加的工具"到 twinMain，**不**追加 'twinSubagent'
    const futureTool = {
      name: 'future_tool',
      description: 'a tool added later',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ text: 'noop' }),
    };
    registerTool(futureTool, ['twinMain']);
    // 再注册 Task（用于验证它会从 twinSubagent 桶被排除）
    const taskTool = {
      name: 'Task',
      description: 'spawn subagent',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ text: 'noop' }),
    };
    registerTool(taskTool, ['twinMain']);
    assert(__listRegisteredToolsForTest().length === 2, 'case#9 注册了 2 个 twinMain 工具');

    const subBackend = await getBackendFor('twinSubagent');
    const toolNames = Array.from(
      (subBackend as unknown as { tools: Map<string, unknown> }).tools.keys(),
    ).sort();
    assert(
      toolNames.includes('future_tool'),
      'case#9 未来加到 twinMain 的工具自动出现在 twinSubagent 桶（不需要单独追加）',
      `subagent tools=${toolNames.join(',')}`,
    );
    assert(
      !toolNames.includes('Task'),
      'case#9 Task 工具自动从 twinSubagent 桶排除（嵌套保护）',
    );
  }

  // ─── 用例 7: nominal type 出口返回 StableSystemContext ─────────
  {
    const s = await buildStableSystemContext({
      agentSystemPromptAppend: null,
      memoryBPathInstruction: '## Memory',
      mcpPrompt: '',
    });
    // 运行时 s 仍是 string，但 TypeScript 编译时拥有 brand。
    // 这里仅断言运行时形态是 string、且非空——编译保护见 ts compile（CI typecheck 兜底）
    assert(typeof s === 'string' && s.length > 0, 'case#7 buildStableSystemContext 返回带 brand 的非空 string');
  }

  // ─── 总结 ────────────────────────────────────────────────────
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
