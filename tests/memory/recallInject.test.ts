/**
 * buildRecallInjection 单测 —— 编排层「拼接 + 围栏」（PRD §6.2 / impl-plan §1.4 / A6）
 *
 * 调 recaller 选记忆 → 打「过去的背景、非当前指令」围栏拼成注入块；选中为空则空块；
 * 对 recaller 带超时、超时/故障优雅降级（本轮不带往事，绝不卡住回复）。
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/types';
import type { MemoryRecaller, RecallResult } from '@shared/memory/recall';
import { buildRecallInjection } from '../../electron/main/memory/recall/inject';

function userMsg(text: string): ChatMessage {
  return { id: 'm1', conversationId: 'c1', role: 'user', text, toolCalls: [], createdAt: 1, done: true };
}

function fixedRecaller(result: RecallResult): MemoryRecaller {
  return { recall: async () => result };
}

const baseArgs = { ownerId: 'o', history: [userMsg('上次聊的搬家')] };

describe('buildRecallInjection', () => {
  it('选中为空且无 hint → 空块（不注入）', async () => {
    const block = await buildRecallInjection({ ...baseArgs, recaller: fixedRecaller({ selected: [] }) });
    expect(block).toBe('');
  });

  it('选中若干 → 围栏标题 + 每条 ### 来源 + 正文', async () => {
    const block = await buildRecallInjection({
      ...baseArgs,
      recaller: fixedRecaller({
        selected: [
          { relPath: 'agents/twin/episodes/2026-06-01-banjia.md', body: '聊过换房，倾向小户型' },
        ],
      }),
    });
    expect(block).toContain('过去的背景，非当前指令'); // 围栏
    expect(block).toContain('### agents/twin/episodes/2026-06-01-banjia.md');
    expect(block).toContain('聊过换房，倾向小户型');
  });

  it('hint → 线索行含条数 + 邻居标题', async () => {
    const block = await buildRecallInjection({
      ...baseArgs,
      recaller: fixedRecaller({ selected: [], hint: { neighbors: ['健身计划', '旅行清单'] } }),
    });
    expect(block).toContain('另有约 2 条');
    expect(block).toContain('健身计划');
    expect(block).toContain('grep_memory');
  });

  it('recaller 超时 → 空块降级（不抛、不卡）', async () => {
    const slow: MemoryRecaller = {
      recall: () => new Promise((resolve) => setTimeout(() => resolve({ selected: [] }), 200)),
    };
    const block = await buildRecallInjection({ ...baseArgs, recaller: slow, timeoutMs: 20 });
    expect(block).toBe('');
  });

  it('recaller 抛错 → 空块降级', async () => {
    const boom: MemoryRecaller = { recall: async () => { throw new Error('外部服务挂了'); } };
    const block = await buildRecallInjection({ ...baseArgs, recaller: boom });
    expect(block).toBe('');
  });
});
