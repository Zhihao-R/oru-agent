/**
 * C1 后半：MCP 不可达提示的注入位置——出现在主对话 [运行时上下文] 块（动态层），
 * aside 回合按门控跳过（aside 白名单没有 MCP 工具，注入会与 bare 裁剪原则自相矛盾）。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock(
  '../../electron/main/projects/store',
  () =>
    ({
      listProjects: vi.fn(async () => ({ projects: [], activeId: null })),
      getProject: vi.fn(async () => {
        throw new Error('no project');
      }),
    }) satisfies Pick<typeof import('../../electron/main/projects/store'), 'listProjects' | 'getProject'>,
);
vi.mock(
  '../../electron/main/agent/mcpPrompt',
  () =>
    ({
      buildUnreachableNote: vi.fn(async () => '### 部分外部服务当前不可用\n\n- **天气服务**（状态：failed）'),
    }) satisfies Pick<typeof import('../../electron/main/agent/mcpPrompt'), 'buildUnreachableNote'>,
);

import { buildRuntimeContext } from '../../electron/main/agent/hooks';
import { setTasksGateway } from '../../electron/main/agent/tasksGateway';

/** buildRuntimeContext 的 ownerId/agentId 是必填（计划清单按对话取盘）——测试里给一对固定值即可 */
const OWNER = { ownerId: 'o', agentId: 'a' };

// 生产路径在 main/index.ts 启动期注入；测试给空实现（本测试不关心任务 hint）
setTasksGateway({
  listTasksForConversation: async () => [],
  markAnnounced: async () => {},
  getLastProgress: async () => null,
  getQuestions: async () => [],
});

describe('buildRuntimeContext 注入 MCP 不可达提示', () => {
  it('主对话回合：提示出现在 [运行时上下文] 块内', async () => {
    const ctx = await buildRuntimeContext('cnv-mcp-1', OWNER);
    expect(ctx).toContain('[运行时上下文]');
    expect(ctx).toContain('部分外部服务当前不可用');
    expect(ctx).toContain('天气服务');
  });

  it('aside 回合：按门控跳过，不含提示', async () => {
    const ctx = await buildRuntimeContext('cnv-mcp-2', { ...OWNER, asideMode: true });
    expect(ctx).toContain('[运行时上下文]');
    expect(ctx).not.toContain('部分外部服务当前不可用');
  });
});
