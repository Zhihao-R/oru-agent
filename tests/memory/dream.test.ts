/**
 * dream 主流程单元测试 — 不打 LLM：测事件流统计（summarizeDreamEvents）+ 无数据早返回 skipped
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-dream-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

describe('runDream 没新对话时返回 skipped', () => {
  // 关键：不能撞到现有 "applyDreamOutput" 的 OWNER 数据；用全新的 ownerId + 干净 ORU_DIR
  const EMPTY_DIR = join(tmpdir(), `oru-test-dream-empty-${Date.now()}`);
  const EMPTY_OWNER = 'no-data-owner';

  beforeAll(async () => {
    await fs.mkdir(EMPTY_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(EMPTY_DIR, { recursive: true, force: true });
  });

  it('listAgents 返回空 → 早返回 kind=skipped/no-new-conversations（不调 LLM）', async () => {
    // 切到隔离的 ORU_DIR，避免拿到现有用户的 agents
    const prevOruDir = process.env.ORU_DIR;
    process.env.ORU_DIR = EMPTY_DIR;
    // 强制 reload 受 ORU_DIR 影响的模块：路径模块在 module top level 读 env
    vi.resetModules();
    try {
      const { runDream } = await import('../../electron/main/memory/dream');
      const r = await runDream({
        ownerId: EMPTY_OWNER,
        currentProjectId: null,
      });
      expect(r).toEqual({ kind: 'skipped', reason: 'no-new-conversations' });
    } finally {
      process.env.ORU_DIR = prevOruDir;
      vi.resetModules();
    }
  });
});

describe('summarizeDreamEvents', () => {
  async function* feed(evs: unknown[]): AsyncIterable<never> {
    for (const e of evs) yield e as never;
  }

  it('按 tool_use 统计 merge / 档案 write·edit（按 relPath）', async () => {
    const { summarizeDreamEvents } = await import('../../electron/main/memory/dream');
    const r = await summarizeDreamEvents(
      feed([
        { type: 'tool_use', id: '1', name: 'merge_episodes', input: { mergeInto: 'a', mergeFrom: ['b', 'c'] } },
        { type: 'tool_use', id: '2', name: 'edit_memory', input: { relPath: 'user/profile.md', oldText: 'x', newText: 'y' } },
        { type: 'tool_use', id: '3', name: 'write_memory', input: { relPath: 'agents/twin/self.md', content: 'z' } },
        { type: 'tool_use', id: '4', name: 'write_memory', input: { relPath: 'projects/p/profile.md', content: 'q' } },
        { type: 'result', resultText: 'done', isError: false },
      ]),
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.episodesMerged).toBe(2);
      expect(r.userFactsChanged).toBe(1); // user/profile.md
      expect(r.projectFieldsChanged).toBe(1); // projects/p/profile.md
      expect(r.profileWrites).toContain('user/profile.md');
      expect(r.profileWrites).toContain('agents/twin/self.md');
    }
  });

  it('result.isError → failed', async () => {
    const { summarizeDreamEvents } = await import('../../electron/main/memory/dream');
    const r = await summarizeDreamEvents(feed([{ type: 'result', resultText: null, isError: true }]));
    expect(r.kind).toBe('failed');
  });

  it('无任何写工具调用 → ok 但计数全 0', async () => {
    const { summarizeDreamEvents } = await import('../../electron/main/memory/dream');
    const r = await summarizeDreamEvents(
      feed([
        { type: 'tool_use', id: '1', name: 'query_episodes', input: {} },
        { type: 'result', resultText: '没有要整理的', isError: false },
      ]),
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.episodesMerged).toBe(0);
      expect(r.userFactsChanged).toBe(0);
      expect(r.profileWrites).toEqual([]);
    }
  });

  it('流结束但从未见 result 终态（超时/中断）→ failed，不误报 ok', async () => {
    const { summarizeDreamEvents } = await import('../../electron/main/memory/dream');
    const r = await summarizeDreamEvents(
      feed([
        { type: 'tool_use', id: '1', name: 'merge_episodes', input: { mergeInto: 'a', mergeFrom: ['b'] } },
        // 没有 result 事件——模拟 abort 后流直接断
      ]),
    );
    expect(r.kind).toBe('failed');
  });

  it('兼容 MCP 前缀工具名（claude-code 把 oru 工具暴露成 mcp__oru__*）', async () => {
    const { summarizeDreamEvents } = await import('../../electron/main/memory/dream');
    const r = await summarizeDreamEvents(
      feed([
        { type: 'tool_use', id: '1', name: 'mcp__oru__merge_episodes', input: { mergeInto: 'a', mergeFrom: ['b', 'c'] } },
        { type: 'tool_use', id: '2', name: 'mcp__oru__write_memory', input: { relPath: 'agents/twin/self.md', content: 'x' } },
        { type: 'tool_use', id: '3', name: 'mcp__oru__edit_memory', input: { relPath: 'user/profile.md', oldText: 'y', newText: 'z' } },
        { type: 'result', resultText: 'ok', isError: false },
      ]),
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.episodesMerged).toBe(2);
      expect(r.userFactsChanged).toBe(1);
      expect(r.profileWrites).toContain('agents/twin/self.md');
    }
  });
});

