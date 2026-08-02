/**
 * 只读挡声明式分类回归（只读重构 · 声明式统一拦截）。
 *
 * 旧实现靠每个写工具 execute 入口手调 readonlyWriteReject（漏一个=静默放行，曾漏四轮）。现改为：
 * 写工具在定义处标 `mutatesEnvironment: true`，三个 backend 的工具分发统一经 executeAgentTool，只读挡下
 * 在触达 execute **之前**拒。本测试锁两件事：
 *  ① 分类正确——会改持久状态的工具一律 mutatesEnvironment=true（防未来误标 false 重新开洞）；
 *     纯读/渲染/会话级工具 false（防误标 true 把只读挡下的正常查看也拦了）。
 *  ② 攻击者场景——只读挡 + 标记写工具经 executeAgentTool 直接拒、真实副作用不可达。
 * 字段必填由编译器强制（忘标即编译错），本测试补「标了但标错值」这一层语义。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@shared/agent/backend';
import type { Agent } from '@shared/types';
import { makeToolContext } from '../helpers/toolContext';

const state = vi.hoisted(() => ({ mode: 'work' as Agent['approvalMode'] }));
vi.mock('../../electron/main/agent/store/agents', () => ({
  realtimeApprovalModeFor: vi.fn(async (_id: string, fallback: Agent['approvalMode']) => state.mode ?? fallback),
  // 只读拒绝理由（D4 接个体名）用 getAgent——返回 null 即回落物种名 Oru。
  getAgent: vi.fn(async () => null),
}));
// 拒绝理由按 owner 语言取词；固定中文以验「只读」字样（避开 electron app）。
vi.mock('../../electron/main/i18n/effectiveLang', () => ({ resolveEffectiveLang: () => 'zh' }));

import { executeAgentTool } from '../../electron/main/agent/agentTools/approvalGate';
import { makeCommitChangesTool } from '../../electron/main/agent/agentTools/commitChanges';
import { makeGenerateDeckTool } from '../../electron/main/agent/agentTools/generateDeck';
import { makeFinalizeSubmissionTool } from '../../electron/main/agent/agentTools/finalizeSubmission';
import {
  makeArtifactHistoryListTool,
  makeArtifactHistoryCheckoutTool,
} from '../../electron/main/agent/agentTools/deckHistory';
import {
  makeListTasksTool,
  makeCreateTaskTool,
  makeUpdateTaskTool,
  makeDeleteTaskTool,
  makeRestoreTaskTool,
} from '../../electron/main/agent/agentTools/taskboard';
import {
  makeMcpInstallTool,
  makeMcpUpdateTool,
  makeMcpDeleteTool,
  makeMcpListTool,
} from '../../electron/main/agent/agentTools/mcp';
import {
  makeProposePluginInstallTool,
  makeProposeSkillInstallTool,
  makeProposePluginUninstallTool,
} from '../../electron/main/agent/agentTools/plugin';
import { makeSkillManageTool } from '../../electron/main/agent/agentTools/skillManage';
import { makeDownloadImageTool } from '../../electron/main/agent/agentTools/downloadImage';
import {
  makeBrowserNavigateTool,
  makeBrowserSnapshotTool,
  makeBrowserClickTool,
  makeBrowserTypeTool,
  makeBrowserScrollTool,
  makeBrowserBackTool,
} from '../../electron/main/agent/agentTools/browserControl';
import { makeReadFileTool } from '../../electron/main/agent/agentTools/readFile';
import { makeGlobTool } from '../../electron/main/agent/agentTools/glob';
import { makeRenderHtmlTool } from '../../electron/main/agent/agentTools/renderHtml';
import { createMemoryTools } from '../../electron/main/memory/tools';

function ctx(): ToolContext {
  return makeToolContext({ conversationId: 'c', agentId: 'twin', ownerId: 'local-user' });
}

const memory = createMemoryTools();
const mem = (name: string) => memory.find((t) => t.name === name)!;

const WRITE_TOOLS = [
  makeCommitChangesTool(),
  makeGenerateDeckTool(),
  makeFinalizeSubmissionTool(),
  makeArtifactHistoryCheckoutTool(),
  makeCreateTaskTool(),
  makeUpdateTaskTool(),
  makeDeleteTaskTool(),
  makeRestoreTaskTool(),
  makeMcpInstallTool(),
  makeMcpUpdateTool(),
  makeMcpDeleteTool(),
  makeProposePluginInstallTool(),
  makeProposeSkillInstallTool(),
  makeProposePluginUninstallTool(),
  makeSkillManageTool(),
  makeDownloadImageTool(),
  mem('record_memory'),
  mem('edit_memory'),
  // 浏览器操控（S33 §7 + 2026-07-31 PM 拍板）：页面内交互四件只读挡全拒；
  // navigate 进站即「看」，只读挡放行（挪入下方 READ_TOOLS）
  makeBrowserClickTool(),
  makeBrowserTypeTool(),
  makeBrowserScrollTool(),
  makeBrowserBackTool(),
];

const READ_TOOLS = [
  makeReadFileTool(),
  makeGlobTool(),
  makeRenderHtmlTool(),
  makeArtifactHistoryListTool(),
  makeListTasksTool(),
  makeMcpListTool(),
  mem('read_memory'),
  mem('grep_memory'),
  mem('query_episodes'),
  makeBrowserSnapshotTool(), // 读当前页结构不改环境（S33 §7）
  makeBrowserNavigateTool(), // 进站即「看」：只读挡放行（2026-07-31 PM 拍板：只读可搜索可看网页）
];

describe('只读挡声明式分类', () => {
  it('会改持久状态的工具一律标 mutatesEnvironment=true', () => {
    for (const t of WRITE_TOOLS) {
      expect(t.mutatesEnvironment, `${t.name} 应标 true`).toBe(true);
    }
  });

  it('纯读/渲染/列出类工具标 mutatesEnvironment=false', () => {
    for (const t of READ_TOOLS) {
      expect(t.mutatesEnvironment, `${t.name} 应标 false`).toBe(false);
    }
  });
});

describe('只读挡攻击者场景：标记写工具经中央闸直接拒', () => {
  for (const t of WRITE_TOOLS) {
    it(`只读挡：${t.name} 经 executeAgentTool 返回只读拒绝、真实副作用不可达`, async () => {
      state.mode = 'readonly';
      const r = await executeAgentTool(t, {}, ctx());
      expect(r.text).toContain('只读');
    });
  }

  it('工作挡：写工具不被只读闸拦，放行到各自真实逻辑', async () => {
    state.mode = 'work';
    // commit_changes 在 work 挡放行到 commitTask（不存在的 task 回 isError，但不是只读拒）
    const r = await executeAgentTool(makeCommitChangesTool(), { task_id: 'nope', message: 'm' }, ctx());
    expect(r.text).not.toContain('只读');
  });
});
