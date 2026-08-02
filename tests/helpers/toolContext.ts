/**
 * ToolContext 测试工厂——收敛 20 份本地 `makeCtx` 与散落的裸 `as ToolContext` 强转。
 *
 * 仓库明文约定：mock 必须 `satisfies` 被 mock 的接口类型，禁止裸对象 `as` 蒙混（接口加字段时
 * 假绿）。本工厂内部用 `satisfies ToolContext` 收口——必填 6 字段全给默认值，其余按需 override。
 * `abortSignal` 每次调用新建（不共享 signal，避免用例间中断态串味）；`onProposal` 默认空实现
 * （审批/命令类工具最常用的挂点）。
 *
 * ```ts
 * const ctx = makeToolContext();                              // 全默认
 * const ctx = makeToolContext({ onProposal: vi.fn() });       // 覆盖回调
 * const ctx = makeToolContext({ deckPath: '/tmp/deck', usage: 'subagentCoder' });
 * ```
 */
import type { ToolContext } from '@shared/agent/backend';

export function makeToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    conversationId: 'conv-test',
    agentId: 'test-agent',
    ownerId: 'test-user',
    approvalMode: 'work',
    usage: 'twinMain',
    abortSignal: new AbortController().signal,
    onProposal: async () => {},
    ...overrides,
  } satisfies ToolContext;
}
