/**
 * D2 工具图回传集成测试——真打 OpenRouter 验「视觉回路端到端」
 *
 * 默认 skip：仅在 OPENROUTER_API_KEY 存在时才跑。
 *
 * 运行方式（由控制方用真实 key 执行）：
 *   OPENROUTER_API_KEY=sk-or-v1-xxx npx vitest run tests/agent/openaiCompatibleImages.integration.test.ts
 *
 * 覆盖：
 *   构造一个「工具带明显白底图」的 conversation，assert 模型回答不为空——
 *   证明视觉回路在真实 API 下确实打通（image_url wire 通路真实可达）。
 *
 * 注：图为 wire-only，不写持久层；不验落盘。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTool, ConversationInput, ToolResultImage } from '@shared/agent/backend';
import type { ChatMessage } from '@shared/types';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';

// ─── 仅在有真实 key 时跑 ────────────────────────────────────────

const HAS_KEY = Boolean(process.env.OPENROUTER_API_KEY);

// ─── 测试用图 ─────────────────────────────────────────────────────
//
// 测试图：白底黑字「DECKTEST」PNG（由 Pillow 生成）。断言模型回答含 DECKTEST，
// 证明模型确实「看到」了图（OCR 出文字），而非仅 wire 未崩。

const TEST_IMAGE: ToolResultImage = {
  base64:
    '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',
  mediaType: 'image/png',
};

/** 模拟 view_slide/render_html 行为的工具 */
function visionTool(): AgentTool {
  return {
    name: 'view_slide',
    description: '渲染幻灯片并截图，返回页面截图',
    inputSchema: {
      type: 'object' as const,
      properties: { page: { type: 'number', description: '页码' } },
    },
    mutatesEnvironment: false, // 渲染/截图类，纯读
    async execute() {
      return { text: '第1页截图已生成', images: [TEST_IMAGE] };
    },
  } satisfies AgentTool;
}

/** 消费对话事件，返回最终 resultText（或在 30s 内 abort） */
async function runAndGetResult(backend: OpenAICompatibleBackend, input: ConversationInput): Promise<string> {
  for await (const ev of backend.runConversation(input).events) {
    const e = ev as Record<string, unknown>;
    if (e.type === 'result') return (e.resultText as string) ?? '';
  }
  return '';
}

// ─── 集成测试主体 ────────────────────────────────────────────────

describe.skipIf(!HAS_KEY)('D2 集成：OpenRouter 真打多模态模型验视觉回路', () => {
  it(
    '模型收到工具截图后给出回答（证明 image_url wire 通路端到端可达）',
    async () => {
      /**
       * 端到端真实路径（不是预构造 wire，而是跑生产 round-trip）：
       *   history=[user 让它调 view_slide 并只回截图文字]
       *   → 模型 tool_call(view_slide) → 工具回执 text + images=[DECKTEST 图]
       *   → executeToolSafe 透出 images → appendToolResults 落 role:'user' image_url 消息
       *   → 模型下一轮看到图 → 回答里出现 DECKTEST
       * 断言回答含 DECKTEST = 模型确实「看到」了工具回执图（OCR 出文字），而非仅 wire 未崩。
       */
      const backend = new OpenAICompatibleBackend({
        apiKey: process.env.OPENROUTER_API_KEY!,
        defaultModel: 'google/gemini-2.5-flash', // 可换任意 OpenRouter 多模态模型
        baseURL: 'https://openrouter.ai/api/v1',
        providerType: 'openrouter',
        supportsVision: true,
      });
      backend.registerTool(visionTool());

      // 当前用户消息须进 history（backend 从 history 构造 wire；userMessage 仅便利字段）。
      const userTurn: ChatMessage = {
        id: 'u1',
        conversationId: 'integration-test-conv',
        role: 'user',
        text: '请先调用 view_slide 工具查看第 1 页，然后只回答你在那张截图里看到的文字内容（逐字照抄，不要解释）。',
        toolCalls: [],
        createdAt: 0,
        done: true,
      };
      const input: ConversationInput = {
        agentId: 'integration-test',
        conversationId: 'integration-test-conv',
        userMessage: userTurn.text,
        history: [userTurn],
        cwd: process.cwd(),
        abortController: new AbortController(),
        toolContext: {
          conversationId: 'integration-test-conv',
          agentId: 'integration-test',
          ownerId: 'test-owner',
          approvalMode: 'work',
          usage: 'twinMain',
          abortSignal: new AbortController().signal,
        },
      };

      const result = await runAndGetResult(backend, input);
      // 真证据：模型回答含图中文字 DECKTEST → 证明它确实「看到」了工具回执图
      expect(result.toUpperCase()).toContain('DECKTEST');
    },
    30_000, // 30s timeout：真实 API 调用
  );
});
