/**
 * serverId 与工具名的三条硬约束（2026-07-28，外部 MCP 归一到反射之后）。
 *
 * 锁的承重不变量：
 *  - **`oru` 是保留 serverId**。它是 claude-code 桥接自有工具那个 in-process MCP server 的固定
 *    名字；用户建出同名 server 后，第三方工具名会变成 mcp__oru__<tool>，与自有工具的桥名同形，
 *    normalizeToolName 只剥一层会把它剥成裸名当自有工具处理（只读挡兜底判定失效、查表走错分支）。
 *  - **反射名撞上接口约束（64 字符 / `[a-zA-Z0-9_-]`）时改写，不丢工具**。这个名字是 Oru 自己
 *    合成的别名，我们对它有完全自由度；出厂预设 id 就有 22 字符，chrome-devtools 最长的工具
 *    拼完 66 > 64——按「跳过」处理会丢掉旗舰用例的能力。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerConfig, McpServerStatus, Settings } from '@shared/types';
import type { McpServerClient } from '../../electron/main/mcp/client';

vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
  updateSettings: vi.fn(async () => {}),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings' | 'updateSettings'>);

vi.mock('../../electron/main/agent/backends', () => ({
  registerTool: vi.fn(),
  unregisterTool: vi.fn(),
}) satisfies Pick<typeof import('../../electron/main/agent/backends'), 'registerTool' | 'unregisterTool'>);

import { getSettings } from '../../electron/main/projects/store';
import { makeSettings } from '../helpers/settings';
import { registerTool } from '../../electron/main/agent/backends';
import {
  createServer,
  startServer,
  foreignNamesNotOurs,
  __resetForTest,
  __setClientFactoryForTest,
} from '../../electron/main/mcp/registry';
import { reflectedToolName } from '../../electron/main/mcp/reflectTool';

type FakeClientShape = Pick<
  McpServerClient,
  'config' | 'status' | 'tools' | 'lastError' | 'start' | 'close'
>;

/** 起手即 connected_ready、暴露指定工具名的 fake client。 */
function makeFakeClientFactory(toolNames: string[]) {
  return (config: McpServerConfig): McpServerClient => {
    const fake = {
      config,
      status: 'idle' as McpServerStatus,
      tools: toolNames.map((name) => ({ name, description: '', inputSchema: { type: 'object' } })),
      lastError: undefined,
      start: async () => {
        (fake as { status: McpServerStatus }).status = 'connected_ready';
      },
      close: async () => {},
    } satisfies FakeClientShape;
    return fake as unknown as McpServerClient;
  };
}

beforeEach(() => {
  __resetForTest();
  vi.mocked(getSettings).mockResolvedValue(makeSettings({ mcpServers: [] }));
  vi.mocked(registerTool).mockClear();
});

describe('serverId 保留名', () => {
  it('label 叫 "Oru" 不会生成 serverId `oru`，走既有撞名机制退让', async () => {
    const created = await createServer({
      label: 'Oru',
      command: 'echo',
      args: [],
      enabled: false,
    });

    expect(created.id).not.toBe('oru');
    expect(created.id).toBe('oru-2');
  });

  it('中文 label 保留中文 id（wire 名的合法性由反射层解决，不必牺牲 id 可读性）', async () => {
    const created = await createServer({
      label: '飞书',
      command: 'echo',
      args: [],
      enabled: false,
    });

    expect(created.id).toBe('飞书');
  });

  it('不影响其它名字（只挡保留名，不误伤）', async () => {
    const created = await createServer({
      label: 'Linear',
      command: 'echo',
      args: [],
      enabled: false,
    });

    expect(created.id).toBe('linear');
  });
});

describe('反射工具名合法化（撞上接口约束改写，不丢工具）', () => {
  const cfg: McpServerConfig = {
    id: 'srv',
    label: 'Srv',
    command: 'echo',
    args: [],
    enabled: true,
  };

  it('出厂预设 id + 最长的 chrome-devtools 工具：改写后可用，不被丢掉', () => {
    // preset-chrome-devtools(22) 下 performance_analyze_insight 的原始 wire 名是 66 > 64
    const name = reflectedToolName('preset-chrome-devtools', 'performance_analyze_insight');
    expect(`mcp__oru__${name}`.length).toBeLessThanOrEqual(64);
    // 压的是 serverId 那段，工具名原样保留——模型靠它挑工具
    expect(name).toContain('performance_analyze_insight');
  });

  it('中文 serverId / toolName 合法化后仍不撞名（只换下划线会让「飞书」「钉钉」变成同一个名字）', () => {
    const feishu = reflectedToolName('飞书', 'send');
    const dingding = reflectedToolName('钉钉', 'send');

    for (const n of [feishu, dingding]) {
      expect(n).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(`mcp__oru__${n}`.length).toBeLessThanOrEqual(64);
    }
    expect(feishu).not.toBe(dingding);
    // 同一台 server 的不同工具也不撞
    expect(reflectedToolName('飞书', '发送')).not.toBe(reflectedToolName('飞书', '接收'));
  });

  it('纯函数：同样输入恒得同样输出（unregister 靠重算找回同一个名字）', () => {
    const a = reflectedToolName('preset-chrome-devtools', 'performance_analyze_insight');
    const b = reflectedToolName('preset-chrome-devtools', 'performance_analyze_insight');
    expect(a).toBe(b);
    // 不同 server 的同名工具不撞
    expect(reflectedToolName('srv-a', 'run')).not.toBe(reflectedToolName('srv-b', 'run'));
  });

  it('toolName 自身超预算时截断 + 尾哈希，仍不超限且不同工具不撞', () => {
    const long1 = 'x'.repeat(80);
    const long2 = 'x'.repeat(80) + 'y';
    const n1 = reflectedToolName('srv', long1);
    const n2 = reflectedToolName('srv', long2);
    expect(`mcp__oru__${n1}`.length).toBeLessThanOrEqual(64);
    expect(n1).not.toBe(n2);
  });

  it('名字需要改写的工具照常注册（不再有跳过分支）', async () => {
    __setClientFactoryForTest(makeFakeClientFactory(['ok_tool', '发送消息', 'z'.repeat(80)]));

    await startServer(cfg);

    const registered = vi.mocked(registerTool).mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(registered).toHaveLength(3);
    for (const n of registered) {
      expect(`mcp__oru__${n}`.length).toBeLessThanOrEqual(64);
      expect(n).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});

/**
 * 「你在别处配过、Oru 没有」的比对。锁的目标问题：出厂预设的 id（preset-chrome-devtools）与
 * label（中文）都不等于别处那份的名字（chrome-devtools），只比名字会让每个装过 Claude Code 的
 * 用户都被误告知「Oru 不会加载 chrome-devtools」——而 Oru 出厂就带着它。
 */
describe('别处配置比对', () => {
  const preset: McpServerConfig = {
    id: 'preset-chrome-devtools',
    label: 'Chrome DevTools（读社媒/登录态页面）',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
    enabled: true,
  };

  it('名字对不上但命令行是同一台 server → 不误报，真没有的才报', () => {
    expect(foreignNamesNotOurs(['chrome-devtools', 'context7'], [preset])).toEqual(['context7']);
  });

  it('id 或 label 直接相等也算有（大小写不敏感）', () => {
    const mine: McpServerConfig = { id: 'linear', label: 'Linear', command: 'x', args: [], enabled: true };
    expect(foreignNamesNotOurs(['Linear', 'LINEAR'], [mine])).toEqual([]);
  });

  it('一个都没装时全部如实报出', () => {
    expect(foreignNamesNotOurs(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});
