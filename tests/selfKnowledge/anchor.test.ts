/**
 * 常驻锚点（子系统 B）装配单测（techdoc §B / §I）。
 *
 * 验：领域线索含全部领域名、**不含可直接作答的能力明细 / 格式词**（B.2 开关非清单）、
 * **含 B.3「相关能力会自动带来」指引**（子系统 C 已上线，S35·G05）、同输入字节稳定（确定性）、
 * registry 未就绪时降级为纯声明、bare 模式产物不含锚点。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import {
  initSelfKnowledge,
  getAreas,
  __resetForTest,
} from '../../electron/main/selfKnowledge/registry';
import { buildSelfKnowledgePrompt } from '../../electron/main/prompts/selfKnowledge';

beforeEach(() => initSelfKnowledge());
afterEach(() => __resetForTest());

describe('buildSelfKnowledgePrompt', () => {
  it('段首是身份纠正：你是 Oru、不是 Claude Code', () => {
    const p = buildSelfKnowledgePrompt();
    expect(p).toContain('你是 Oru');
    expect(p).toContain('不是 Claude Code');
    // 身份段必须在最前——给它最大权重（claude-code 后端对抗最强）
    expect(p.indexOf('不是 Claude Code')).toBeLessThan(p.indexOf('领域'));
  });

  it('含保守默认：拿不准就保守、绝不现编', () => {
    const p = buildSelfKnowledgePrompt();
    expect(p).toContain('拿不准');
    expect(p).toContain('绝不现编');
  });

  it('领域线索含全部领域名', () => {
    const p = buildSelfKnowledgePrompt();
    for (const a of getAreas()) {
      expect(p).toContain(a.name);
    }
  });

  it('B.3：含"相关能力会自动带来"指引（子系统 C 已上线，S35·G05）', () => {
    const p = buildSelfKnowledgePrompt();
    // 指引模型优先用注入来的能力详情、没带来就保守——推送已实现，兑现得了这个承诺
    expect(p).toContain('自动带');
    expect(p).toContain('你的相关能力');
  });

  it('是开关不是清单：不含可直接作答的格式词（PPT/PDF/xlsx 等）', () => {
    const p = buildSelfKnowledgePrompt();
    for (const word of ['PPT', 'PDF', 'xlsx', 'Markdown', 'CSV']) {
      expect(p).not.toContain(word);
    }
  });

  it('同输入装配字节稳定（确定性排序）', () => {
    expect(buildSelfKnowledgePrompt()).toBe(buildSelfKnowledgePrompt());
  });

  it('registry 未就绪 → 降级为纯声明、不抛错、不带领域线索', () => {
    __resetForTest();
    const p = buildSelfKnowledgePrompt();
    expect(p).toContain('你是 Oru'); // 身份锚点在异常态仍在
    expect(p).not.toContain('演示稿'); // 但不带任何领域名
    expect(p).not.toContain('你的能力大致分布');
  });
});

describe('stableSystemContext 接线', () => {
  it('bare 模式产物不含自我认知锚点（aside 不做能力问答）', async () => {
    const { buildStableSystemContext } = await import('../../electron/main/agent/stableSystemContext');
    const bare = await buildStableSystemContext({
      agentSystemPromptAppend: '人格占位',
      memoryBPathInstruction: '',
      mcpPrompt: '',
      bare: true,
    });
    expect(bare).not.toContain('你是谁、怎么谈论自己的能力');
    expect(bare).toBe('人格占位');
  });

  it('非 bare 模式产物含自我认知锚点', async () => {
    const { buildStableSystemContext } = await import('../../electron/main/agent/stableSystemContext');
    const full = await buildStableSystemContext({
      agentSystemPromptAppend: '人格占位',
      memoryBPathInstruction: '',
      mcpPrompt: '',
      bare: false,
    });
    expect(full).toContain('你是谁、怎么谈论自己的能力');
    expect(full).toContain('不是 Claude Code');
  });
});
