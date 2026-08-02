/**
 * Loop 带图（2026-07-28「/loop 带图与普通消息同路」）——拆解回合的图通道。
 *
 * 承重事实只有一条：拆解回合的合成 user 轮必须挂上 /loop 消息的附件，且与 userMessage 同源
 * （同一段 prompt 文本）。挂上即通——HTTP 两后端经 historyAdapter 出 image block、claudeCode
 * 经 currentTurnImageAttachments 取 history 末条 user 的图，这里连着一起钉住，防「改一处漏一处」。
 *
 * 拆解直调 backend.runConversation、不经主对话装配（ensureCurrentTurnInHistory 不在这条链上），
 * 故测试直接 mock backend 看它收到什么。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatAttachment, ChatMessage } from '@shared/types';
import type { ConversationEvent, ConversationInput, AgentBackend } from '@shared/agent/backend';

vi.hoisted(() => {
  process.env.ORU_DIR = `${process.env.TMPDIR ?? '/tmp'}/oru-test-loopattach-${process.pid}`;
});

const { getBackendForMock } = vi.hoisted(() => ({
  getBackendForMock: vi.fn<(typeof import('../../electron/main/agent/backends'))['getBackendFor']>(),
}));
vi.mock('../../electron/main/agent/backends', async (orig) => ({
  ...(await orig()),
  getBackendFor: getBackendForMock,
}));
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({ getCurrentOwnerId: () => 'o1' }));

import { debugLogger } from '../../electron/main/debug/logger';
import { compileChecklist, COMPILE_SYSTEM_PROMPT } from '../../electron/main/loop/compileChecklist';
import { currentTurnImageAttachments } from '../../electron/main/agent/backends/claudeCode';
import { adaptHistory } from '../../electron/main/agent/backends/historyAdapter';

const img: ChatAttachment = {
  kind: 'image',
  relPath: 'attachments/msg_1/a.png',
  mediaType: 'image/png',
  bytes: 10,
  filename: 'a.png',
};

/** 记下 backend 收到的 input，事件流走「一句纯文本反问」终局（不牵扯工具）。 */
let captured: ConversationInput | null = null;
function stubBackend(): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic',
    runConversation: (input) => {
      captured = input;
      return {
        events: (async function* (): AsyncIterable<ConversationEvent> {
          yield { type: 'assistant_text', text: '图里的表格列名是哪几列？' };
          yield { type: 'result', resultText: '图里的表格列名是哪几列？', isError: false };
        })(),
      };
    },
    runOneShot: async () => ({ text: '' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: '' }),
  } satisfies AgentBackend;
}

async function compileWith(attachments?: ChatAttachment[]) {
  return compileChecklist({
    goal: '照这张图列的要点建表',
    agentId: 'a1',
    conversationId: 'loop_lp1_compile',
    agentName: 'oru',
    lang: 'zh',
    cwd: '/tmp',
    attachments,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  captured = null;
  debugLogger.setEnabled(false); // 显式关调试日志，不依赖「恰好没开」的默认值
  getBackendForMock.mockResolvedValue(stubBackend());
});

describe('拆解回合带图', () => {
  it('附件同源：history 末条 user 带 attachments，且 text 与 userMessage 同文本', async () => {
    await compileWith([img]);
    const last = captured!.history!.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.attachments).toEqual([img]);
    expect(last.text).toBe(captured!.userMessage);
    expect(last.text).toContain('照这张图列的要点建表');
  });

  it('没带图 → 合成 user 轮不长出空 attachments 字段', async () => {
    await compileWith();
    expect(captured!.history!.at(-1)!.attachments).toBeUndefined();
  });

  it('claudeCode 口径：拆解 history 的末条 user 就是唯一那条，图被当轮取到', async () => {
    await compileWith([img]);
    const out = currentTurnImageAttachments(captured!.history as ChatMessage[], captured!.userMessage);
    expect(out).toEqual([img]);
  });

  it('HTTP 后端口径：拆解 history 经 historyAdapter 出 image block', async () => {
    await compileWith([img]);
    const { messages } = adaptHistory({
      messages: captured!.history as ChatMessage[],
      targetProtocol: 'anthropic',
      targetSupportsVision: true,
      attachmentLoaderFor: () => async () => 'base64==',
    });
    expect(messages.at(-1)!.blocks.some((b) => b.type === 'image')).toBe(true);
  });

  it('无视觉回落：降级成占位文字、不炸（带图落盘后切到无视觉模型的历史场景）', async () => {
    await compileWith([img]);
    const { messages } = adaptHistory({
      messages: captured!.history as ChatMessage[],
      targetProtocol: 'anthropic',
      targetSupportsVision: false,
    });
    const blocks = messages.at(-1)!.blocks;
    expect(blocks.every((b) => b.type === 'text')).toBe(true);
    expect(blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')).toContain('a.png');
  });
});

describe('审查员盲区防线', () => {
  it('拆解 system prompt 明写「审查员看不到图」，要求图中内容落成文字判据', () => {
    // 审查员的 transcript 投影只抽文本（orchestrate.projectTurn），指图判据必然空转或幻觉判过。
    expect(COMPILE_SYSTEM_PROMPT).toContain('看不到');
    expect(COMPILE_SYSTEM_PROMPT).toMatch(/图/);
  });
});
