/**
 * tests/helpers 三件套自测——这些是承重测试基建，形态被大量文件依赖，先锁住契约。
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { sandboxOruDir, assertOruDirIsolated } from './oruDirSandbox';
import { makeToolContext } from './toolContext';
import { captureBroadcast } from './broadcast';
import type { ServerEvent } from '@shared/protocol';

describe('sandboxOruDir', () => {
  it('创建 tmpdir 内的真实目录并指向 env', () => {
    const dir = sandboxOruDir('helpers-selftest');
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(process.env.ORU_DIR).toBe(dir);
  });

  it('assertOruDirIsolated：tmpdir 内放行、外面抛', () => {
    expect(() => assertOruDirIsolated(sandboxOruDir('guard-ok'))).not.toThrow();
    expect(() => assertOruDirIsolated('/Users/someone/.oru')).toThrow(/隔离失效/);
  });
});

describe('makeToolContext', () => {
  it('默认给齐必填 6 字段 + onProposal', () => {
    const ctx = makeToolContext();
    expect(ctx.conversationId).toBeTruthy();
    expect(ctx.agentId).toBeTruthy();
    expect(ctx.ownerId).toBeTruthy();
    expect(ctx.approvalMode).toBe('work');
    expect(ctx.usage).toBe('twinMain');
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect(typeof ctx.onProposal).toBe('function');
  });

  it('override 覆盖默认，abortSignal 每次新建不共享', () => {
    const ctx = makeToolContext({ approvalMode: 'readonly', conversationId: 'c9' });
    expect(ctx.approvalMode).toBe('readonly');
    expect(ctx.conversationId).toBe('c9');
    expect(makeToolContext().abortSignal).not.toBe(makeToolContext().abortSignal);
  });
});

describe('captureBroadcast', () => {
  const executing: ServerEvent = { type: 'proposal.statusChanged', proposalId: 'p', status: 'executing' };
  const executed: ServerEvent = { type: 'proposal.statusChanged', proposalId: 'p', status: 'executed' };
  const convState = { type: 'conv.state', agentId: 'a' } as unknown as ServerEvent;

  it('捕获顺序、types、statuses', () => {
    const cap = captureBroadcast();
    cap.broadcast(executing);
    cap.broadcast(convState);
    cap.broadcast(executed);

    expect(cap.events).toHaveLength(3);
    expect(cap.types()).toEqual(['proposal.statusChanged', 'conv.state', 'proposal.statusChanged']);
    expect(cap.statuses()).toEqual(['executing', 'executed']);
  });
});
