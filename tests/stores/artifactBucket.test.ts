// @vitest-environment jsdom

/**
 * artifactStore 分桶信号 / 对比态守卫（右栏多标签阶段4，§3.7 §3.8）
 *
 * 覆盖命令式读取点之外的两条按 artifactId 分桶不变量：
 *  - notifyIndexChanged 按 artifactId 路由 reloadSignal；对比态该 deck 跳过、不影响别的 deck；
 *  - syncSubmission(null) 只退该 deck 的对比态，别的 deck 对比态不动。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: vi.fn().mockResolvedValue({ type: 'ack' }),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useArtifactStore } from '@/stores/artifactStore';

beforeEach(() => {
  useArtifactStore.setState({
    compareStateByArtifactId: {},
    reloadSignalByArtifactId: {},
    submissionByArtifact: {},
  });
});

describe('notifyIndexChanged 按 artifactId 路由 reload 信号', () => {
  it('非对比态 → 该 deck 的 reloadSignal 自增，别的 deck 不动', () => {
    useArtifactStore.getState().notifyIndexChanged('A');
    const s = useArtifactStore.getState();
    expect(s.reloadSignalByArtifactId.A).toBe(1);
    expect(s.reloadSignalByArtifactId.B).toBeUndefined();
  });

  it('对比态的 deck → 跳过（reload 会丢对比视图），别的 deck 仍正常发', () => {
    useArtifactStore.setState({
      compareStateByArtifactId: { A: { beforeFile: 'b', afterFile: 'a', showing: 'before' } },
    });
    useArtifactStore.getState().notifyIndexChanged('A'); // A 在对比态 → 跳过
    useArtifactStore.getState().notifyIndexChanged('B'); // B 正常
    const s = useArtifactStore.getState();
    expect(s.reloadSignalByArtifactId.A).toBeUndefined();
    expect(s.reloadSignalByArtifactId.B).toBe(1);
  });
});

describe('syncSubmission(null) 只退该 deck 的对比态', () => {
  it('组解散退 A 的对比态，B 的对比态不受影响', () => {
    useArtifactStore.setState({
      compareStateByArtifactId: {
        A: { beforeFile: 'b', afterFile: 'a', showing: 'before' },
        B: { beforeFile: 'b', afterFile: 'a', showing: 'after' },
      },
    });
    useArtifactStore.getState().syncSubmission('A', null);
    const s = useArtifactStore.getState();
    expect(s.compareStateByArtifactId.A).toBeUndefined();
    expect(s.compareStateByArtifactId.B).toBeDefined();
  });
});
