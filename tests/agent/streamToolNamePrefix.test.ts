/**
 * stream.ts 两座桥（toolStructured / toolVisuals）+ persistPolicy 查表在带前缀
 * 事件名下的回归。
 *
 * 目标问题：claude-code 后端的 tool_use 事件名带 mcp__oru__ 前缀，而工具 execute
 * stash / registry 注册用的是裸名——若按事件名原样查，键恒不匹配：ask_user_choice
 * 的结构化回答、图片工具的缩略图在该后端整体静默失效，persistPolicy 退化成 'auto'。
 * 修复 = 查表前归一工具名。
 *
 * 不打 LLM，直接喂 EngineEvent 流。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../electron/main/engine/types';
import type { AgentTool, ToolResult as BackendToolResult } from '../../shared/agent/backend';
import type { ToolCallVisual } from '../../shared/types';

// persistPolicy 用例要真落盘验证——先重定向 ORU_DIR 到 tmpdir，再动态 import，
// 避免 runtime/paths.ts 在模块加载时把 ~/.oru 锁死（同 tests/tasks/store.test.ts 范式）。
const ORU_DIR = join(tmpdir(), `oru-test-stream-toolname-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const { pipeSdkToEvents } = await import('../../electron/main/agent/stream');
const { stashToolStructured, __clearToolStructuredForTest } = await import(
  '../../electron/main/agent/agentTools/toolStructured'
);
const { stashToolVisual } = await import('../../electron/main/agent/agentTools/toolVisuals');
const { registerTool, unregisterTool } = await import(
  '../../electron/main/agent/backends/factory'
);

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

// StreamCtx 未导出——用参数类型透传（Pick<InnerType> 同一立场），emit 收事件不校验。
function makeCtx(conversationId: string) {
  return {
    conversationId,
    messageId: 'm1',
    ownerId: 'u1',
    agentId: 'a1',
    emit: () => {},
  } satisfies Parameters<typeof pipeSdkToEvents>[1];
}

function turnEvents(name: string, input: Record<string, unknown>): AsyncGenerator<EngineEvent> {
  return (async function* () {
    yield { type: 'tool_use', id: 't1', name, input } satisfies EngineEvent;
    yield { type: 'tool_result', toolUseId: 't1', isError: false, content: 'ok' } satisfies EngineEvent;
    yield { type: 'result', resultText: '完成', isError: false } satisfies EngineEvent;
  })();
}

describe('toolStructured 桥 · 事件名带 mcp__oru__ 前缀', () => {
  it('stash 用裸名、事件名带前缀，仍能取到结构化回答（claude-code 回归）', async () => {
    __clearToolStructuredForTest();
    const input = { questions: [{ header: '风格', options: ['简', '繁'] }] };
    const structured = { answers: [{ questionIndex: 0, selectedLabels: ['简'] }] };
    // 模拟 askUserChoice.execute：stash 键用裸名（agentTools/askUserChoice.ts:157 同款）
    stashToolStructured('conv-structured', 'ask_user_choice', input, structured);

    const out = await pipeSdkToEvents(
      turnEvents('mcp__oru__ask_user_choice', input),
      makeCtx('conv-structured'),
    );
    expect(out.toolCalls[0].result?.structured).toEqual(structured);
  });
});

describe('toolVisuals 桥 · 事件名带 mcp__oru__ 前缀', () => {
  it('stash 用裸名、事件名带前缀，缩略图仍能挂上 ToolCall.visual（claude-code 回归）', async () => {
    const input = { url: 'https://example.com/a.jpg' };
    const visual: ToolCallVisual = {
      kind: 'download_image',
      imgPath: '/tmp/a.jpg',
      relPath: 'images/a.jpg',
      sourceHost: 'example.com',
    };
    // 模拟 downloadImage.execute：stash 键用裸名（agentTools/downloadImage.ts:124 同款）
    stashToolVisual('conv-visual', 'download_image', input, visual);

    const out = await pipeSdkToEvents(
      turnEvents('mcp__oru__download_image', input),
      makeCtx('conv-visual'),
    );
    expect(out.toolCalls[0].visual).toEqual(visual);
  });
});

describe('persistPolicy 查表 · 事件名带 mcp__oru__ 前缀', () => {
  it('registry 注册裸名、事件名带前缀，persistPolicy=always 仍生效落盘（claude-code 回归）', async () => {
    // 只有归一后 getToolByName 才能命中——detail 只有 2 字符（'ok'），远低于 'auto' 阈值，
    // 落盘与否完全由查到的 persistPolicy 决定：查不到 → 不落盘 → persistedRef 为空 → 红。
    const fakeTool = {
      name: 'fake_always_persist',
      description: '测试用：persistPolicy=always 的假工具',
      inputSchema: { type: 'object' },
      mutatesEnvironment: false,
      persistPolicy: 'always',
      execute: async (): Promise<BackendToolResult> => ({ text: 'unused' }),
    } satisfies AgentTool;
    registerTool(fakeTool, ['twinMain']);
    try {
      const out = await pipeSdkToEvents(
        turnEvents('mcp__oru__fake_always_persist', {}),
        makeCtx('conv-persist'),
      );
      const ref = out.toolCalls[0].result?.persistedRef;
      expect(ref).toBeDefined();
      expect(ref!.path.startsWith(ORU_DIR)).toBe(true);
      // 落盘行为本身也验：文件真实存在且内容即 detail
      expect(await fs.readFile(ref!.path, 'utf-8')).toBe('ok');
    } finally {
      unregisterTool('fake_always_persist');
    }
  });
});
