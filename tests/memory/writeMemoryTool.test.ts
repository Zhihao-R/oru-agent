/**
 * write_memory 工具单测 —— 整篇覆盖档案正文（与对话 write_file 对齐）
 *
 * 命中 user/profile.md（及 self）后照旧推 onMemoryRecord 卡片（record_memory 的回执行为
 * 下沉到 write/edit_memory）。越界沙箱优雅 isError，不抛穿。设计见 document-model §2。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const ORU_DIR = join(tmpdir(), `oru-test-writetool-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

function ctx(extras?: Partial<ToolContext>): ToolContext {
  return makeToolContext({ conversationId: 'conv-1', agentId: 'agent-1', ownerId: 'wt-owner', ...extras });
}

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('write_memory', () => {
  it('整篇写 user/profile.md，落盘 + 推 onMemoryRecord（scope=personal）', async () => {
    const { __makeWriteMemoryTool } = await import('../../electron/main/memory/tools');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    let pushed: { scope?: string; relPath?: string } | null = null;
    const tool = __makeWriteMemoryTool();
    const r = await tool.execute(
      { relPath: 'user/profile.md', content: '整体印象。\n\n## 饮食习惯\n糙米配豆类。' },
      ctx({ onMemoryRecord: async (p) => { pushed = p; } }),
    );
    expect(r.isError).not.toBe(true);
    const raw = await fs.readFile(join(memoryRoot('wt-owner'), 'user/profile.md'), 'utf-8');
    expect(raw).toContain('## 饮食习惯');
    expect(pushed).toMatchObject({ scope: 'personal', relPath: 'user/profile.md' });
  });

  it('命中 self.md → 卡片 scope=agent type=self', async () => {
    const { __makeWriteMemoryTool } = await import('../../electron/main/memory/tools');
    let pushed: { scope?: string; type?: string } | null = null;
    const tool = __makeWriteMemoryTool();
    await tool.execute(
      { relPath: 'agents/twin/self.md', content: '我日常对话偏活泼。' },
      ctx({ onMemoryRecord: async (p) => { pushed = p; } }),
    );
    expect(pushed).toMatchObject({ scope: 'agent', type: 'self' });
  });

  it('relPath 越界 → 优雅 isError，不抛穿', async () => {
    const { __makeWriteMemoryTool } = await import('../../electron/main/memory/tools');
    const tool = __makeWriteMemoryTool();
    const r = await tool.execute({ relPath: '../../evil.md', content: 'x' }, ctx());
    expect(r.isError).toBe(true);
  });

  it('缺 relPath / content → isError', async () => {
    const { __makeWriteMemoryTool } = await import('../../electron/main/memory/tools');
    const tool = __makeWriteMemoryTool();
    expect((await tool.execute({ content: 'x' } as never, ctx())).isError).toBe(true);
    expect((await tool.execute({ relPath: 'user/profile.md' } as never, ctx())).isError).toBe(true);
  });
});
