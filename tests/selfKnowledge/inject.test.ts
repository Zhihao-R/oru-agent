/**
 * buildSelfKnowledgeInjection 单测 —— 自我认知按相关性注入（子系统 C，S35·G05）
 *
 * 每轮读能力候选简介 + 对话窗口挑相关能力、注入其详情；无对话窗口 / 未选中 / registry 未就绪 / 超时
 * 一律空块降级；能力块不打「非当前指令」围栏（是关于 Oru 自己的当前权威事实）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { vi } from 'vitest';
import type { ChatMessage } from '@shared/types';
import type { AgentBackend, OneShotResult } from '@shared/agent/backend';
import {
  initSelfKnowledge,
  candidateSummaries,
  getByIds,
  __resetForTest,
} from '../../electron/main/selfKnowledge/registry';
import { buildSelfKnowledgeInjection } from '../../electron/main/selfKnowledge/inject';

function userMsg(text: string): ChatMessage {
  return { id: 'm1', conversationId: 'c1', role: 'user', text, toolCalls: [], createdAt: 1, done: true };
}

/** mock 挑选器后端：回一段固定 JSON（selected/hints）——满足 PickerBackend 的四字段 */
function mockBackend(selected: string[]): Pick<AgentBackend, 'runOneShot' | 'backendType' | 'modelId' | 'providerId'> {
  return {
    backendType: 'anthropic',
    modelId: 'test',
    providerId: 'test',
    runOneShot: async (): Promise<OneShotResult> => ({ text: JSON.stringify({ selected, hints: [] }) }),
  };
}

beforeEach(() => initSelfKnowledge());
afterEach(() => __resetForTest());

describe('buildSelfKnowledgeInjection', () => {
  const history = [userMsg('你能不能帮我做这件事')];

  it('挑中一条能力 → 注入其标题 + 正文，且不打「非当前指令」围栏', async () => {
    const picked = candidateSummaries()[0].id; // 取一个真实能力 id
    const entry = getByIds([picked])[0];
    const block = await buildSelfKnowledgeInjection({
      ownerId: 'o',
      history,
      pickerBackend: mockBackend([picked]),
    });
    expect(block).toContain('你的相关能力'); // 能力块标题
    expect(block).toContain(`### ${entry.title}`);
    expect(block).toContain(entry.body.slice(0, 20));
    // 关键：能力是当前事实、不是"过去背景"，不打记忆块那种围栏
    expect(block).not.toContain('过去的背景，非当前指令');
  });

  it('未选中任何能力 → 空块（高精度、常为 0）', async () => {
    const block = await buildSelfKnowledgeInjection({
      ownerId: 'o',
      history,
      pickerBackend: mockBackend([]),
    });
    expect(block).toBe('');
  });

  it('幻觉 id（不在候选内）被过滤 → 空块', async () => {
    const block = await buildSelfKnowledgeInjection({
      ownerId: 'o',
      history,
      pickerBackend: mockBackend(['nonexistent-capability-id']),
    });
    expect(block).toBe('');
  });

  it('无对话窗口 → 空块（无上下文可判相关性，不白跑小模型）', async () => {
    const block = await buildSelfKnowledgeInjection({
      ownerId: 'o',
      history: [],
      pickerBackend: mockBackend([candidateSummaries()[0].id]),
    });
    expect(block).toBe('');
  });

  it('registry 未就绪 → 空块降级（常驻锚点仍在别处兜底）', async () => {
    __resetForTest();
    const block = await buildSelfKnowledgeInjection({
      ownerId: 'o',
      history,
      pickerBackend: mockBackend(['whatever']),
    });
    expect(block).toBe('');
  });

  it('挑选器超时 → 空块降级（不抛、不卡回复）', async () => {
    const slow: Pick<AgentBackend, 'runOneShot' | 'backendType' | 'modelId' | 'providerId'> = {
      backendType: 'anthropic',
      modelId: 'test',
      providerId: 'test',
      runOneShot: () => new Promise((resolve) => setTimeout(() => resolve({ text: '{}' }), 200)),
    };
    const block = await buildSelfKnowledgeInjection({
      ownerId: 'o',
      history,
      pickerBackend: slow,
      timeoutMs: 20,
    });
    expect(block).toBe('');
  });
});
