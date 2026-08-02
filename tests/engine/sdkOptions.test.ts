/**
 * engine → SDK 选项映射回归。
 *
 * 锁的目标问题：`strictMcpConfig` 必须恒为 true。settingSources 含 'user'/'project' 时，
 * claude-code 子进程会**自行加载**用户全局 ~/.claude.json 与项目 .mcp.json 里的 MCP server
 * ——那批工具不在 Oru 的 toolRegistry、不过任何闸，且每回合新起进程，让 chrome-devtools
 * 这类按连接进程授权的下游反复弹授权框（2026-07-27 实测：不透传时子进程仍连上三个 server）。
 * 这一行是「Chrome 每回合弹授权」的唯一修复点，删了或改了不该静默通过。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    captured.options.push(args.options);
    return (async function* () {
      /* 空流：本测试只看入参 */
    })();
  },
  createSdkMcpServer: vi.fn(),
  tool: vi.fn(),
}));

import { engine } from '../../electron/main/engine';
import type { EngineRunInput } from '../../electron/main/engine/types';

function runInput(overrides: Partial<EngineRunInput> = {}): EngineRunInput {
  return {
    prompt: 'hi',
    cwd: process.cwd(),
    abortController: new AbortController(),
    systemPrompt: { preset: 'claude_code' },
    permissionMode: 'default',
    ...overrides,
  } satisfies EngineRunInput;
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of events) {
    /* 只为耗尽流 */
  }
}

beforeEach(() => {
  captured.options.length = 0;
});

describe('toSdkOptions — MCP 配置来源收口', () => {
  it('默认路径：strictMcpConfig 为 true，子进程不自行加载用户/项目的 MCP 配置', async () => {
    await drain(engine.run(runInput()).events);

    expect(captured.options).toHaveLength(1);
    expect(captured.options[0].strictMcpConfig).toBe(true);
    // 前提确认：settingSources 仍加载（CLAUDE.md / hooks / permissions 照常生效），
    // 收口只针对 MCP——两者一起关是超出目标的做法，不该被误改成那样
    expect(captured.options[0].settingSources).toEqual(['user', 'project', 'local']);
  });

  it('受限回合（loadSettingSources:false）同样 strict，不因不加载 settings 就放松', async () => {
    await drain(engine.run(runInput({ loadSettingSources: false })).events);

    expect(captured.options[0].strictMcpConfig).toBe(true);
    expect(captured.options[0].settingSources).toBeUndefined();
  });

  it('Oru 显式透传的 mcpServers 不受 strict 影响（收口只挡「自行加载」，不挡「显式给」）', async () => {
    const mcpServers = { oru: { type: 'stdio' as const, command: 'x', args: [] } };
    await drain(engine.run(runInput({ mcpServers })).events);

    expect(captured.options[0].strictMcpConfig).toBe(true);
    expect(captured.options[0].mcpServers).toEqual(mcpServers);
  });
});
