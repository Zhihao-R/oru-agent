/**
 * C2 项目 CLAUDE.md 从第一层移到第二层：projectClaudeMdSection 随"当前关注项目"变，
 * 留在第一层意味着用户在侧栏点一下别的项目就击穿第一断点（含子 agent 共享缓存）。
 * 迁移后由 project-claude-md 能力（第二层 capabilityPrompt）承载：切项目只击穿第二层。
 *
 * 第一层不随项目变由构造保证——buildStableSystemContext 已无 activeProjectId 入参，
 * 类型层面杜绝（比"传不同项目断言字节相同"更强）；本文件验能力侧的承载。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '../../electron/main/projects/store',
  () =>
    ({
      getProject: vi.fn(async () => ({
        id: 'proj-1',
        ownerId: 'local-user',
        name: '测试项目',
        path: '/fake/project',
        addedAt: 0,
        lastOpenedAt: 0,
        hasClaudeMd: true,
      })),
      // 其余能力（联网/配图等）的 buildPrompt 读 settings——给空对象走"未启用"分支
      getSettings: vi.fn(async () => ({})),
    }) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getProject' | 'getSettings'>,
);
vi.mock(
  '../../electron/main/projects/claudeMd',
  () =>
    ({
      loadProjectClaudeMd: vi.fn(async () => '项目规范：禁止裸写 proposal.status'),
    }) satisfies Pick<typeof import('../../electron/main/projects/claudeMd'), 'loadProjectClaudeMd'>,
);

import { projectClaudeMdCapability } from '../../electron/main/agent/capabilities/builtins/projectClaudeMd';
import { registerBuiltinCapabilities, provisionAgent } from '../../electron/main/agent/capabilities';
import { __clearCapabilityRegistryForTest } from '../../electron/main/agent/capabilities/registry';
import { __clearToolRegistryForTest } from '../../electron/main/agent/backends';

const HEADING = '## 当前项目说明（CLAUDE.md）';

beforeEach(() => {
  __clearToolRegistryForTest();
  __clearCapabilityRegistryForTest();
  registerBuiltinCapabilities();
});
afterEach(() => {
  __clearToolRegistryForTest();
  __clearCapabilityRegistryForTest();
});

describe('project-claude-md 能力', () => {
  it('audience 收拢为 twinMain + twinSubagent + subagentCoder', () => {
    expect([...projectClaudeMdCapability.audience].sort()).toEqual([
      'subagentCoder',
      'twinMain',
      'twinSubagent',
    ]);
  });

  it('twinMain / twinSubagent 的 capabilityPrompt 含项目 CLAUDE.md 段', async () => {
    for (const usage of ['twinMain', 'twinSubagent'] as const) {
      const p = await provisionAgent({ usage, searchBudgetId: 'b', activeProjectId: 'proj-1' });
      expect(p.capabilityPrompt, usage).toContain(HEADING);
      expect(p.capabilityPrompt, usage).toContain('禁止裸写 proposal.status');
    }
  });

  it('无 active project 时不注入该段（评论场景 projectIdOverride=null 同路径）', async () => {
    const p = await provisionAgent({ usage: 'twinMain', searchBudgetId: 'b', activeProjectId: null });
    expect(p.capabilityPrompt).not.toContain(HEADING);
  });
});
