/**
 * 代码执行引擎 — Claude Agent SDK 实现
 *
 * 把 ./types.ts 定义的中性接口转成 SDK 调用。
 * 业务代码不应直接 import 本文件——只应通过 ./index.ts 导出的默认 engine 用。
 */
import {
  query as sdkQuery,
  createSdkMcpServer,
  tool as sdkTool,
  type Options as SdkOptions,
  type SDKMessage,
  type SDKUserMessage,
  type HookCallback,
  type HookCallbackMatcher,
  type SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineHookContext,
  EngineHookHandler,
  EngineMcpFactory,
  EnginePromptBlock,
  EngineRunHandle,
  EngineRunInput,
  EngineToolGateHandler,
  EngineToolObserverHandler,
} from './types';

function adaptHook(handler: EngineHookHandler): HookCallbackMatcher {
  const cb: HookCallback = async (input) => {
    if (input.hook_event_name !== 'UserPromptSubmit' && input.hook_event_name !== 'SessionStart') {
      return {} as SyncHookJSONOutput;
    }
    const ctx: EngineHookContext = { eventName: input.hook_event_name };
    const r = await handler(ctx);
    if (!r || !r.additionalContext) return {} as SyncHookJSONOutput;
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: r.additionalContext,
      },
    };
  };
  return { hooks: [cb] };
}

/** PreToolUse 闸门：handler 返回 deny → 回 permissionDecision:'deny' 拦下工具（权限层之前生效，bypass 无效化它）。 */
function adaptPreToolUse(handler: EngineToolGateHandler): HookCallbackMatcher {
  const cb: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {} as SyncHookJSONOutput;
    const r = await handler(input.tool_name);
    if (!r || !r.deny) return {} as SyncHookJSONOutput;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: r.reason ?? `工具 ${input.tool_name} 在当前模式下不可用`,
      },
    };
  };
  return { hooks: [cb] };
}

/**
 * PostToolUse 观察者：工具成功后把 (tool_name, tool_input) 交给 handler，纯旁路——
 * 恒回空输出、handler 抛错吞掉（观察失败不能变成 hook 失败打断回合）。
 */
function adaptPostToolUse(handler: EngineToolObserverHandler): HookCallbackMatcher {
  const cb: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {} as SyncHookJSONOutput;
    try {
      await handler(input.tool_name, input.tool_input);
    } catch {
      // 静默：观察者自身兜错是第一道，这里是防御第二道
    }
    return {} as SyncHookJSONOutput;
  };
  return { hooks: [cb] };
}

function toSdkOptions(input: EngineRunInput): SdkOptions {
  const opts: SdkOptions = {
    cwd: input.cwd,
    abortController: input.abortController,
    resume: input.resume,
    settingSources: input.loadSettingSources === false ? undefined : ['user', 'project', 'local'],
    // 恒开，不给开关：settingSources 含 'user'/'project' 时，子进程会自行加载用户全局
    // ~/.claude.json 与项目 .mcp.json 里的 MCP server（实测：Oru 完全不透传时它仍连上
    // chrome-devtools / context7 / playtest-cdp）。那批工具不在 Oru 的 toolRegistry、不在
    // disallowedTools、不过 executeAgentTool 中央闸，与「模型能调的工具集由 Oru 决定」直接冲突；
    // 且每回合新起进程，让 chrome-devtools 这类按进程授权的下游反复弹授权框。
    // 收口只认 Oru 显式透传的那份——CLAUDE.md / hooks 等仍由 settingSources 正常加载。
    // ⚠ SDK 类型 doc 把这个字段说成「严格校验 MCP 配置，非法配置报错而非告警」，与实际行为不符：
    // 它被翻译成 CLI 的 --strict-mcp-config，语义是「只用 --mcp-config 给的那份、不读任何配置文件」。
    // 照类型 doc 读会以为这行无关紧要而顺手删掉——删掉即回归。行为以实测为准（见上）。
    strictMcpConfig: true,
    systemPrompt: {
      type: 'preset',
      preset: input.systemPrompt.preset,
      append: input.systemPrompt.append,
    },
    permissionMode: input.permissionMode === 'bypass' ? 'bypassPermissions' : 'default',
    allowDangerouslySkipPermissions: input.permissionMode === 'bypass' ? true : undefined,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    // SDK 0.1.77 实测语义（runtimeTypes.d.ts）：allowedTools 只是"免权限确认"、
    // disallowedTools 是黑名单；真正限定内置工具基集的是 tools 选项，[] = 全部禁用。
    // 不影响 mcpServers 挂载的工具（CLI --tools 文档：available tools from the built-in set）。
    // ⚠ 该语义随 SDK 版本可能漂移，升级时复核。
    tools: input.builtinTools,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mcpServers: input.mcpServers as any,
    // 逐 token 流式：子进程额外吐 stream_event 增量（adaptEvents 转 assistant_text）。
    // per-run，由 caller 按"有没有人在实时看"决定（见 EngineRunInput.streaming）。
    includePartialMessages: input.streaming,
    env: input.env,
    model: input.model,
    // SDK 0.1.77 实测（2026-06-11，opus 4.8）：默认下自适应思考非确定地触发（同 prompt
    // 有时带 thinking 块有时不带）；maxThinkingTokens: 0 能稳定压住——对照组默认臂出
    // thinking 块、0 臂同 prompt 无 thinking 块且输出 token 回落。
    // ⚠ 该语义随 SDK 版本可能漂移，升级时复核。
    maxThinkingTokens: input.maxThinkingTokens,
  };
  if (input.hooks) {
    const hooks: NonNullable<SdkOptions['hooks']> = {};
    if (input.hooks.onUserPromptSubmit) {
      hooks.UserPromptSubmit = [adaptHook(input.hooks.onUserPromptSubmit)];
    }
    if (input.hooks.onSessionStart) {
      hooks.SessionStart = [adaptHook(input.hooks.onSessionStart)];
    }
    if (input.hooks.onPreToolUse) {
      hooks.PreToolUse = [adaptPreToolUse(input.hooks.onPreToolUse)];
    }
    if (input.hooks.onPostToolUse) {
      hooks.PostToolUse = [adaptPostToolUse(input.hooks.onPostToolUse)];
    }
    opts.hooks = hooks;
  }
  return opts;
}

/**
 * SDKMessage → EngineEvent 适配。
 *
 * streaming（= EngineRunInput.streaming，对应 SDK includePartialMessages）控制文本来源：
 * - true：文本走 stream_event 的 text_delta 逐段发；末尾完整 assistant 的 text 块**跳过**
 *   （SDK 把 partial 叠加在完整消息之上，两者都发，不跳过就文本翻倍）。
 * - false：无 stream_event，文本走 assistant 整块（现状，行为不变）。
 * 两个分支都从完整 assistant 消息取 tool_use——增量里 tool_use 的 input 是 input_json_delta
 * 碎片、不可解析，故工具一律等完整消息（与 anthropic.ts 的 content_block_stop 才 parse 同理）。
 */
export async function* adaptEvents(
  iter: AsyncIterable<SDKMessage>,
  streaming = false,
): AsyncIterable<EngineEvent> {
  let lastSeenSessionId: string | null = null;
  // streaming 下跟踪当前 content block 是不是 text——只有 text 块的 text_delta 算正文，
  // 挡掉 thinking_delta / signature_delta 混进 assistant_text（照 anthropic.ts 的 builders 思路）。
  let inTextBlock = false;
  for await (const msg of iter) {
    // 抓 session_id（顶层字段，多种 message 上可能出现）
    if ('session_id' in msg && typeof (msg as { session_id?: unknown }).session_id === 'string') {
      const sid = (msg as { session_id: string }).session_id;
      if (sid && sid !== lastSeenSessionId) {
        lastSeenSessionId = sid;
        yield { type: 'session', sessionId: sid };
      }
    }
    switch (msg.type) {
      case 'stream_event': {
        // includePartialMessages 关时不会有此消息；防御性地仅在 streaming 下处理。
        if (!streaming) break;
        const ev = msg.event;
        if (ev.type === 'content_block_start') {
          inTextBlock = ev.content_block.type === 'text';
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta' && inTextBlock && ev.delta.text) {
            yield { type: 'assistant_text', text: ev.delta.text };
          }
        } else if (ev.type === 'content_block_stop') {
          inTextBlock = false;
        }
        break;
      }
      case 'assistant': {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            // streaming 下文本已由 stream_event 增量发过，整块跳过避免翻倍；
            // 非 streaming 下这里是文本的唯一来源。
            if (!streaming && block.text) yield { type: 'assistant_text', text: block.text };
          } else if (block.type === 'tool_use') {
            yield {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: (block.input ?? {}) as Record<string, unknown>,
            };
          }
        }
        break;
      }
      case 'user': {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              (block as { type?: string }).type === 'tool_result'
            ) {
              const b = block as {
                tool_use_id: string;
                content: unknown;
                is_error?: boolean;
              };
              yield {
                type: 'tool_result',
                toolUseId: b.tool_use_id,
                isError: Boolean(b.is_error),
                content: b.content,
              };
            }
          }
        }
        break;
      }
      case 'result': {
        const resultText =
          'result' in msg && typeof msg.result === 'string' ? msg.result : null;
        // result.modelUsage 按模型给出整轮累计 token（ModelUsage 是 SDK 聚合值，非单条 message）；
        // 跨模型求和即整轮总量，单模型时其 key 就是实际生效的 model。填进 final_answer 汇总。
        const models = 'modelUsage' in msg ? Object.entries(msg.modelUsage) : [];
        const usage = models.length
          ? {
              inputTokens: models.reduce((s, [, m]) => s + m.inputTokens, 0),
              outputTokens: models.reduce((s, [, m]) => s + m.outputTokens, 0),
              actualModel: models.length === 1 ? models[0][0] : undefined,
            }
          : undefined;
        yield { type: 'result', resultText, isError: Boolean(msg.is_error), usage };
        break;
      }
      default:
        break;
    }
  }
}

const mcpFactory: EngineMcpFactory = {
  createServer: (config) =>
    createSdkMcpServer({
      name: config.name,
      version: config.version,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: config.tools as any,
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineTool: (name, description, schema, handler) => sdkTool(name as any, description, schema, handler),
};

/** EnginePromptBlock[] → SDK user message 的 content 数组（文/图块翻译）。 */
function toSdkUserContent(blocks: EnginePromptBlock[]): SDKUserMessage['message']['content'] {
  return blocks.map((b) =>
    b.type === 'text'
      ? { type: 'text' as const, text: b.text }
      : {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: b.mediaType, data: b.base64 },
        },
  );
}

/** 一条 user 消息块 → SDKUserMessage（session_id 仅类型必填，CLI 以子进程回吐为准，不影响 resume）。 */
function toSdkUserMessage(blocks: EnginePromptBlock[], resume: string | undefined): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: toSdkUserContent(blocks) },
    parent_tool_use_id: null,
    session_id: resume ?? '',
  };
}

/**
 * 多模态 prompt → SDK streaming input：发一条 user 消息（文+图）后即结束流，SDK 随即开跑。
 * session_id 仅类型必填；CLI 忽略输入值、以子进程回吐的 session_id 为准——故带图轮照常续传（resume 不受影响）。
 */
async function* toUserMessageStream(
  blocks: EnginePromptBlock[],
  resume: string | undefined,
): AsyncIterable<SDKUserMessage> {
  yield toSdkUserMessage(blocks, resume);
}

/**
 * Steering 活流通道：持续开着的 streaming-input 流——首条消息起跑后不关闭，push 可继续推入新 user
 * 消息（喂进 SDK 起新轮），close 收尾让 for-await 终止。spike v5（push/notify 模式）实测可行。
 *
 * 与 toUserMessageStream（单发即结束）的区别：本流在 close 前一直等下一条，是 interrupt + 续喂的载体。
 */
export type LiveInputChannel = {
  stream: AsyncGenerator<SDKUserMessage>;
  /** 推入一条 user 消息（多模态块）；流若已 close 则忽略。 */
  push: (blocks: EnginePromptBlock[]) => void;
  /** 收尾：唤醒等待中的流并让它 return，结束 for-await。 */
  close: () => void;
};

export function createLiveInputChannel(
  first: EnginePromptBlock[],
  resume: string | undefined,
): LiveInputChannel {
  const inbox: SDKUserMessage[] = [toSdkUserMessage(first, resume)];
  let notify: (() => void) | null = null;
  let closed = false;
  function wake() {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  }
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (inbox.length > 0) yield inbox.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (notify = r));
    }
  }
  return {
    stream: stream(),
    push: (blocks) => {
      if (closed) return;
      inbox.push(toSdkUserMessage(blocks, resume));
      wake();
    },
    close: () => {
      closed = true;
      wake();
    },
  };
}

/** 进程退出类错误的 message 特征——SDK 在子进程非正常退出时抛这几种。 */
export const PROCESS_EXIT_ERROR_RE =
  /Claude Code process (exited with code|terminated by signal)|Failed to spawn Claude Code/;

export type StderrTail = { push: (data: string) => void; text: () => string };

/**
 * 累积子进程 stderr，只保留末尾 capChars 字符。
 * SDK 默认把子进程 stderr 设为 "ignore" 直接丢弃；崩溃时前端只剩一句 "exited with code 1"，
 * 真因（鉴权失败 / 模型不可用 / 配置加载崩）全在 stderr 里。这里把它接住，fatal 一般在末尾。
 */
export function createStderrTail(capChars = 4000): StderrTail {
  let buf = '';
  return {
    push: (data) => {
      buf += data;
      if (buf.length > capChars) buf = buf.slice(-capChars);
    },
    text: () => buf.trim(),
  };
}

/**
 * 透传事件流；若底层 SDK 抛「子进程退出」类错误，把接住的 stderr 末尾补进 error.message，
 * 让 classifyError → 前端 banner 能看到真因，而不是干巴巴的退出码。
 * 非进程退出错误原样抛，不污染。
 */
export async function* enrichProcessExitError(
  events: AsyncIterable<EngineEvent>,
  stderrTail: StderrTail,
): AsyncIterable<EngineEvent> {
  try {
    yield* events;
  } catch (e) {
    if (e instanceof Error && PROCESS_EXIT_ERROR_RE.test(e.message)) {
      const tail = stderrTail.text();
      if (tail) {
        console.error(`[claude-code] 子进程异常退出，stderr 末尾：\n${tail}`);
        e.message = `${e.message}\n\nClaude Code 子进程 stderr（末尾）：\n${tail}`;
      }
    }
    throw e;
  }
}

export const claudeAgentSdkEngine: CodeExecutionEngine = {
  run(input: EngineRunInput): EngineRunHandle {
    const opts = toSdkOptions(input);
    // 接住子进程 stderr（SDK 默认丢弃）——崩溃时由 enrichProcessExitError 把真因补进错误
    const stderrTail = createStderrTail();
    opts.stderr = (data) => stderrTail.push(data);

    // Steering 活流模式：持续输入流 + 暴露 interrupt/appendInput（claude-code 近似中途转向）。
    // 仅主对话 steering 路径传 live=true；其余路径保持下方单发 prompt，行为零变化。
    if (input.live) {
      const firstBlocks: EnginePromptBlock[] =
        typeof input.prompt === 'string' ? [{ type: 'text', text: input.prompt }] : input.prompt;
      const channel = createLiveInputChannel(firstBlocks, input.resume);
      const q = sdkQuery({ prompt: channel.stream, options: opts });
      // events 流终止（正常结束 / abort / 错误）时关闭活流通道，避免其 await 悬挂泄漏。
      async function* closingEvents(): AsyncIterable<EngineEvent> {
        try {
          yield* enrichProcessExitError(adaptEvents(q, input.streaming), stderrTail);
        } finally {
          channel.close();
        }
      }
      return {
        events: closingEvents(),
        appendInput: (blocks) => channel.push(blocks),
        interrupt: () => q.interrupt(),
      };
    }

    const prompt =
      typeof input.prompt === 'string'
        ? input.prompt
        : toUserMessageStream(input.prompt, input.resume);
    const iter = sdkQuery({ prompt, options: opts });
    return { events: enrichProcessExitError(adaptEvents(iter, input.streaming), stderrTail) };
  },
  mcp: mcpFactory,
};
