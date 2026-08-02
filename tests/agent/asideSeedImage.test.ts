/**
 * 点睛种子截图随灌历史进 prompt 的回归测试（mock engine，不需要活模型）。
 *
 * 验证目标问题本身，两段都曾真实翻车（活模型 smoke __smoke_aside_seed_image__ 实测）：
 * 1. 种子指代卡的截图必须并入首轮 fresh-run 的 prompt 图片块——修复前
 *    currentTurnImageAttachments 碰不到历史里的卡，截图整条丢；
 * 2. seed 文本里该附件的占位句必须改口为「已附上」——默认占位是「当前模型不支持视觉」，
 *    图明明在 prompt 里，模型却顺着文本否认（"我看不见截图"），等于白送。
 *
 * ORU_DIR 范式：顶层先设 env、被测模块动态 import（仿 tests/conversations/store.test.ts）；
 * saveAttachments 走真实 fs——附件读盘正是被测链路的一环。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessage } from '@shared/types';
import type { ConversationInput } from '@shared/agent/backend';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';

const ORU_DIR = join(tmpdir(), `oru-test-aside-seed-image-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

// engine mock 范式同 runOneShotImages.test.ts：satisfies CodeExecutionEngine，接口加字段时不假绿
const { capturedRuns } = vi.hoisted(() => ({
  capturedRuns: [] as EngineRunInput[],
}));
vi.mock('../../electron/main/engine', () => {
  const engine = {
    run: (input: EngineRunInput): EngineRunHandle => {
      capturedRuns.push(input);
      return {
        events: (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'result', resultText: 'ok', isError: false };
        })(),
      };
    },
    mcp: {
      createServer: () => ({}),
      defineTool: () => ({}),
    },
  } satisfies CodeExecutionEngine;
  return { engine };
});

// 1×1 红色 PNG——足够让 saveAttachments 校验通过并真实落盘
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5CYII=';

describe('点睛种子截图随灌历史进 prompt', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('首轮 fresh run：图片块在 prompt 里，且 seed 文本占位句改口为「已附上」', async () => {
    const { ClaudeCodeBackend } = await import('../../electron/main/agent/backends/claudeCode');
    const { saveAttachments } = await import('../../electron/main/conversations/attachments');

    const agentId = 'twin';
    const convId = 'cnv-aside-seed';
    const atts = await saveAttachments(agentId, convId, 'card1', [
      {
        base64: PIXEL_PNG,
        mediaType: 'image/png',
        filename: 'aside-screenshot.png',
        bytes: Buffer.from(PIXEL_PNG, 'base64').length,
      },
    ]);

    // 复刻 aside.begin 出生形态：指代卡（带截图）→ 短评 → 用户开口
    const history: ChatMessage[] = [
      {
        id: 'card1',
        conversationId: convId,
        role: 'user',
        kind: 'aside-referent',
        text: '用户按住 Option 点击了界面上的一处空白。',
        toolCalls: [],
        createdAt: 1,
        done: true,
        attachments: atts,
      },
      { id: 'cm1', conversationId: convId, role: 'assistant', text: '短评', toolCalls: [], createdAt: 2, done: true },
      { id: 'u1', conversationId: convId, role: 'user', text: '图里有什么', toolCalls: [], createdAt: 3, done: true },
    ];

    const backend = new ClaudeCodeBackend('test-model', { supportsVision: true });
    const handle = backend.runConversation({
      agentId,
      conversationId: convId,
      userMessage: '图里有什么',
      history,
      cwd: process.cwd(),
      abortController: new AbortController(),
    } satisfies ConversationInput);
    for await (const _ of handle.events) {
      void _;
    }

    expect(capturedRuns).toHaveLength(1);
    const prompt = capturedRuns[0].prompt;
    // 回归 1：截图真进了 prompt——首块是 image 且带 base64（读盘失败会退化成 text 占位块）
    expect(Array.isArray(prompt)).toBe(true);
    const blocks = prompt as Array<{ type: string; base64?: string; text?: string }>;
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].base64).toBeTruthy();
    // 回归 2：seed 文本不得再宣称「不支持视觉」，必须改口「已附上」
    const seedText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    expect(seedText).not.toContain('当前模型不支持视觉');
    expect(seedText).toContain('截图已随本条消息一并附上');
    // 指代卡的回放措辞仍在历史文本里
    expect(seedText).toContain('用户按住 Option 点击了界面上的一处空白');
  });
});
