// ⚠️ 禁止顶部静态 import 读 ORU_DIR 的模块（runtime/paths 在 module load 时 freeze ORU_DIR）——全用 await import。
// 只读重构 PRD 决策六迁移测试：存量 'strict' / 旧 requireApproval 落 'work'；新建分身默认 'work'。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-approvalmode-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

async function writeIndex(agents: Array<Record<string, unknown>>): Promise<void> {
  const { agentsIndex, agentsDir } = await import('../../electron/main/runtime/paths');
  const { getCurrentOwnerId } = await import('../../electron/main/identity/getCurrentOwnerId');
  const ownerId = getCurrentOwnerId();
  await fs.mkdir(agentsDir(ownerId), { recursive: true });
  await fs.writeFile(agentsIndex(ownerId), JSON.stringify({ agents, activeId: 'twin' }, null, 2), 'utf-8');
}

describe('审批挡位迁移（strict 退场 → work）', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });
  afterEach(async () => {
    const { __clearCacheForTest } = await import('../../electron/main/agent/store/agents');
    __clearCacheForTest();
  });

  it("存量 approvalMode:'strict' 读出后落 'work'", async () => {
    await writeIndex([{ id: 'twin', name: 'T', homePath: '/tmp/h', approvalMode: 'strict' }]);
    const { getAgent, __clearCacheForTest } = await import('../../electron/main/agent/store/agents');
    __clearCacheForTest();
    expect((await getAgent('twin')).approvalMode).toBe('work');
  });

  it('更老的 requireApproval 时代数据（无 approvalMode 字段）落 work', async () => {
    await writeIndex([{ id: 'twin', name: 'T', homePath: '/tmp/h', requireApproval: true }]);
    const { getAgent, __clearCacheForTest } = await import('../../electron/main/agent/store/agents');
    __clearCacheForTest();
    expect((await getAgent('twin')).approvalMode).toBe('work');
  });

  it("readonly / work / danger 原样保留", async () => {
    await writeIndex([
      { id: 'twin', name: 'T', homePath: '/tmp/h', approvalMode: 'readonly' },
      { id: 'a2', name: 'T2', homePath: '/tmp/h2', approvalMode: 'danger' },
    ]);
    const { getAgent, __clearCacheForTest } = await import('../../electron/main/agent/store/agents');
    __clearCacheForTest();
    expect((await getAgent('twin')).approvalMode).toBe('readonly');
    expect((await getAgent('a2')).approvalMode).toBe('danger');
  });

  it('新建默认分身挡位 = work', async () => {
    // 清掉上面写的 index，让 ensureDefaultAgent 走新建分支
    const { agentsIndex } = await import('../../electron/main/runtime/paths');
    const { getCurrentOwnerId } = await import('../../electron/main/identity/getCurrentOwnerId');
    await fs.rm(agentsIndex(getCurrentOwnerId()), { force: true });
    const { ensureDefaultAgent, __clearCacheForTest } = await import('../../electron/main/agent/store/agents');
    __clearCacheForTest();
    expect((await ensureDefaultAgent()).approvalMode).toBe('work');
  });
});
