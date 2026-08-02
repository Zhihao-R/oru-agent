import { describe, expect, it } from 'vitest';
import type {
  ActionProposal,
  ChatMessage,
  Conversation,
  ProposalStatus,
  ScheduledTask,
  SubagentTask,
  TaskStatus,
} from '../../shared/types';
import {
  buildMissedByConv,
  collectConvFacts,
  deriveConvBadge,
  deriveConvState,
  effectiveBadge,
  groupTasksByConv,
  type ConvFacts,
} from '../../src/lib/conversationStatus';

/**
 * 通知中心 / 对话列表共用的状态判定（技术设计 §1 §8）——纯函数，两根正交轴：
 * 结局轴 ConvState + 已读轴 seen。本测试是"一处判定"的回归网。
 */

/** 一束默认"已完成且已读"的事实——各用例只覆盖关心的字段，避免噪声 */
function facts(over: Partial<ConvFacts> = {}): ConvFacts {
  return {
    streaming: false,
    pendingProposals: 0,
    taskStatuses: [],
    lastMessageErrored: false,
    updatedAt: 100,
    lastSeenAt: 200, // 已读：lastSeenAt >= updatedAt
    ...over,
  };
}

describe('deriveConvState — 结局轴（不读 seen）', () => {
  it('全部空 → done', () => {
    expect(deriveConvState(facts())).toBe('done');
  });

  it('streaming → running', () => {
    expect(deriveConvState(facts({ streaming: true }))).toBe('running');
  });

  it('有 running/pending/awaiting_twin 子任务 → running', () => {
    for (const s of ['running', 'pending', 'awaiting_twin'] as TaskStatus[]) {
      expect(deriveConvState(facts({ taskStatuses: [s] }))).toBe('running');
    }
  });

  it('子任务 awaiting_user → awaiting-answer', () => {
    expect(deriveConvState(facts({ taskStatuses: ['awaiting_user'] }))).toBe('awaiting-answer');
  });

  it('有 pending proposal → awaiting-approval', () => {
    expect(deriveConvState(facts({ pendingProposals: 1 }))).toBe('awaiting-approval');
  });

  it('最后一条消息报错 → errored', () => {
    expect(deriveConvState(facts({ lastMessageErrored: true }))).toBe('errored');
  });

  it('子任务 failed → errored', () => {
    expect(deriveConvState(facts({ taskStatuses: ['failed'] }))).toBe('errored');
  });

  it('错过的定时 → missed', () => {
    expect(deriveConvState(facts({ missed: true }))).toBe('missed');
  });
});

describe('deriveConvState — 优先级（多状态并存取一个）', () => {
  it('streaming + pending proposal → awaiting-approval（todo 压过 running）', () => {
    expect(deriveConvState(facts({ streaming: true, pendingProposals: 1 }))).toBe(
      'awaiting-approval',
    );
  });

  it('running 子任务 + awaiting_user 子任务 → awaiting-answer（落需要你处理段）', () => {
    expect(deriveConvState(facts({ taskStatuses: ['running', 'awaiting_user'] }))).toBe(
      'awaiting-answer',
    );
  });

  it('实时阻塞压过事后决定：待审批 / 待回答并存 errored → 取待审批', () => {
    // 第一性：proposal 仍卡在 waiter 等你点头（不处理走不下去）> 已停下的报错（等你善后）
    expect(
      deriveConvState(
        facts({ lastMessageErrored: true, pendingProposals: 1, taskStatuses: ['awaiting_user'] }),
      ),
    ).toBe('awaiting-approval');
  });

  it('待回答压过 errored', () => {
    expect(
      deriveConvState(facts({ lastMessageErrored: true, taskStatuses: ['awaiting_user'] })),
    ).toBe('awaiting-answer');
  });

  it('missed 压过 running，但低于实时阻塞与 errored', () => {
    expect(deriveConvState(facts({ missed: true, streaming: true }))).toBe('missed');
    expect(deriveConvState(facts({ missed: true, pendingProposals: 1 }))).toBe('awaiting-approval');
    expect(deriveConvState(facts({ missed: true, lastMessageErrored: true }))).toBe('errored');
  });
});

describe('effectiveBadge — 忽略后三处一致下沉', () => {
  it('未忽略 = deriveConvBadge', () => {
    const f = facts({ lastMessageErrored: true });
    expect(effectiveBadge(f, false)).toBe(deriveConvBadge(f));
    expect(effectiveBadge(f, false)).toBe('todo');
  });

  it('忽略报错：抹掉 errored 后沉到底（无其它 → none）', () => {
    expect(effectiveBadge(facts({ lastMessageErrored: true }), true)).toBe('none');
    expect(effectiveBadge(facts({ taskStatuses: ['failed'] }), true)).toBe('none');
  });

  it('忽略错过定时：抹掉 missed 后沉到底', () => {
    expect(effectiveBadge(facts({ missed: true }), true)).toBe('none');
  });

  it('忽略报错但仍在跑 → 沉为 running', () => {
    expect(effectiveBadge(facts({ lastMessageErrored: true, streaming: true }), true)).toBe(
      'running',
    );
  });

  it('忽略报错但另有待审批 → 仍 todo（审批本无"忽略"，必须复现）', () => {
    expect(effectiveBadge(facts({ lastMessageErrored: true, pendingProposals: 1 }), true)).toBe(
      'todo',
    );
  });

  it('忽略完成待验收（done 未读）→ none（2026-07-10 拍板：待验收可忽略）', () => {
    expect(effectiveBadge(facts({ updatedAt: 200, lastSeenAt: 100 }), true)).toBe('none');
    expect(effectiveBadge(facts({ updatedAt: 200, lastSeenAt: undefined }), true)).toBe('none');
  });

  it('未忽略的 done 未读仍是 unread（忽略不改变默认判定）', () => {
    expect(effectiveBadge(facts({ updatedAt: 200, lastSeenAt: 100 }), false)).toBe('unread');
  });

  it('忽略报错且 done 未读 → none（一次忽略盖掉当下全部可忽略信号）', () => {
    expect(
      effectiveBadge(
        facts({ lastMessageErrored: true, updatedAt: 200, lastSeenAt: 100 }),
        true,
      ),
    ).toBe('none');
  });

  it('忽略待验收但仍在跑 → running（running 不是可忽略信号，不被盖掉）', () => {
    expect(
      effectiveBadge(facts({ streaming: true, updatedAt: 200, lastSeenAt: 100 }), true),
    ).toBe('running');
  });

  it('新动静复现：忽略水位被 updatedAt 超过后 dismissed=false，unread 照常回来', () => {
    // isDismissed(dismissedAt, convId, updatedAt) 在 updatedAt > 水位时返回 false——
    // 此处直接以 dismissed=false 验证复现后的判定路径
    expect(effectiveBadge(facts({ updatedAt: 300, lastSeenAt: 100 }), false)).toBe('unread');
  });
});

describe('deriveConvBadge — 结局轴 ⊕ 已读位（列表单标记）', () => {
  it('待办类（awaiting-* / errored / missed）→ todo，与已读无关', () => {
    expect(deriveConvBadge(facts({ pendingProposals: 1 }))).toBe('todo');
    expect(deriveConvBadge(facts({ taskStatuses: ['awaiting_user'] }))).toBe('todo');
    expect(deriveConvBadge(facts({ lastMessageErrored: true }))).toBe('todo');
    expect(deriveConvBadge(facts({ missed: true }))).toBe('todo');
  });

  it('running → running', () => {
    expect(deriveConvBadge(facts({ streaming: true }))).toBe('running');
  });

  it('todo 压过 running', () => {
    expect(deriveConvBadge(facts({ streaming: true, pendingProposals: 1 }))).toBe('todo');
  });

  it('done 且未读 → unread', () => {
    expect(deriveConvBadge(facts({ updatedAt: 200, lastSeenAt: 100 }))).toBe('unread');
  });

  it('done 且从未打开（lastSeenAt 缺省）→ unread', () => {
    expect(deriveConvBadge(facts({ updatedAt: 200, lastSeenAt: undefined }))).toBe('unread');
  });

  it('done 且已读 → none', () => {
    expect(deriveConvBadge(facts({ updatedAt: 100, lastSeenAt: 100 }))).toBe('none');
    expect(deriveConvBadge(facts({ updatedAt: 100, lastSeenAt: 200 }))).toBe('none');
  });

  it('running 不受已读影响（未读也是 running，不降级 unread）', () => {
    expect(deriveConvBadge(facts({ streaming: true, updatedAt: 200, lastSeenAt: 100 }))).toBe(
      'running',
    );
  });
});

describe('两视图一致性（同读 (done, seen)）', () => {
  // 列表 unread 的对话集 == 通知中心"已完成"段的对话集。
  // 通知中心"已完成" = state==='done' 且未读；列表 unread badge 必须等价。
  const seen = (over: Partial<ConvFacts>) =>
    deriveConvBadge(facts(over)) === 'unread';
  const inDoneInbox = (over: Partial<ConvFacts>) => {
    const f = facts(over);
    return deriveConvState(f) === 'done' && (f.lastSeenAt === undefined || f.updatedAt > f.lastSeenAt);
  };

  it('badge==unread ⟺ 落"已完成(待验收)"段', () => {
    const cases: Partial<ConvFacts>[] = [
      {},
      { updatedAt: 200, lastSeenAt: 100 },
      { updatedAt: 200, lastSeenAt: undefined },
      { streaming: true, updatedAt: 200, lastSeenAt: 100 },
      { pendingProposals: 1, updatedAt: 200, lastSeenAt: 100 },
      { lastMessageErrored: true, updatedAt: 200, lastSeenAt: 100 },
    ];
    for (const c of cases) expect(seen(c)).toBe(inDoneInbox(c));
  });
});

// ─── 投影：从 store 切片收集单条对话的事实 ──────────────────────────

const OWNER = 'local-user';

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    ownerId: OWNER,
    agentId: 'agent-1',
    kind: 'sub',
    title: id,
    sdkSessionId: null,
    createdAt: 1,
    updatedAt: 100,
    ...over,
  };
}

function bashProposal(
  convId: string,
  status: ProposalStatus,
  over: Partial<{ triggeredBySubagent: { taskId: string; description: string } }> = {},
): ActionProposal {
  return {
    id: `p-${convId}-${status}-${Math.random()}`,
    ownerId: OWNER,
    conversationId: convId,
    title: 'run',
    description: 'run something',
    createdAt: 1,
    status,
    kind: 'bash',
    command: 'ls',
    isDestructive: false,
    isReadOnly: true,
    segments: [{ text: 'ls', destructive: false }],
    ...over,
  } satisfies ActionProposal;
}

function task(convId: string, status: TaskStatus): SubagentTask {
  return {
    id: `t-${convId}-${status}`,
    ownerId: OWNER,
    agentId: 'agent-1',
    conversationId: convId,
    proposalId: 'p',
    proposalTitle: 'do',
    targetProjectId: null,
    status,
    baselineCommit: null,
    summary: null,
    errorMessage: null,
    startedAt: 1,
    finishedAt: null,
    profileId: 'project-coder',
    endTag: null,
    affectedPaths: [],
    commitsCreated: [],
    announcedAt: null,
    featureBranch: null,
  } satisfies SubagentTask;
}

function assistantMsg(convId: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m-${convId}`,
    conversationId: convId,
    role: 'assistant',
    text: 'hi',
    toolCalls: [],
    createdAt: 1,
    done: true,
    ...over,
  };
}

describe('collectConvFacts — 投影 store 切片为单条事实', () => {
  it('待审批数全部 pending（不按 triggeredBySubagent 过滤）', () => {
    // 承重约束 3：照抄 ConversationList 旧逻辑会漏主 agent 的 pending proposal
    const cId = 'c1';
    const facts = collectConvFacts(cId, {
      streamingMessageIdByConv: {},
      proposalsByConv: {
        [cId]: [
          bashProposal(cId, 'pending'), // 主 agent 触发，无 triggeredBySubagent
          bashProposal(cId, 'pending', { triggeredBySubagent: { taskId: 't', description: 'd' } }),
          bashProposal(cId, 'executed'), // 已落定不计
        ],
      },
      tasksByConv: {},
      messagesByConv: {},
      convById: { [cId]: conv(cId) },
    });
    expect(facts.pendingProposals).toBe(2);
  });

  it('code 派工排队（kind=code pending）不计入待审批：不误报 awaiting-approval（改动点4）', () => {
    const cId = 'c7';
    const codePending: ActionProposal = {
      id: 'pc', ownerId: OWNER, conversationId: cId, kind: 'code',
      title: '改代码', description: '派个 subagent', createdAt: 1, status: 'pending',
      targetProjectId: null, risk: 'low', rawPlan: 'do',
    } satisfies ActionProposal;
    const facts = collectConvFacts(cId, {
      streamingMessageIdByConv: {},
      proposalsByConv: { [cId]: [codePending, bashProposal(cId, 'pending')] },
      tasksByConv: {},
      messagesByConv: {},
      convById: { [cId]: conv(cId) },
    });
    // 只有 bash 那 1 条算待审批，code 排队的不算
    expect(facts.pendingProposals).toBe(1);
    expect(deriveConvState(facts)).toBe('awaiting-approval');
  });

  it('streaming：streamingMessageIdByConv 非空即 true', () => {
    const cId = 'c2';
    const base = {
      proposalsByConv: {},
      tasksByConv: {},
      messagesByConv: {},
      convById: { [cId]: conv(cId) },
    };
    expect(
      collectConvFacts(cId, { ...base, streamingMessageIdByConv: { [cId]: 'm-1' } }).streaming,
    ).toBe(true);
    expect(
      collectConvFacts(cId, { ...base, streamingMessageIdByConv: { [cId]: null } }).streaming,
    ).toBe(false);
    expect(collectConvFacts(cId, { ...base, streamingMessageIdByConv: {} }).streaming).toBe(false);
  });

  it('lastMessageErrored：只看最后一条消息的 error', () => {
    const cId = 'c3';
    const base = {
      streamingMessageIdByConv: {},
      proposalsByConv: {},
      tasksByConv: {},
      convById: { [cId]: conv(cId) },
    };
    expect(
      collectConvFacts(cId, {
        ...base,
        messagesByConv: {
          [cId]: [
            assistantMsg(cId, { id: 'a', error: { message: 'x', retryable: true } }),
            assistantMsg(cId, { id: 'b' }), // 末条无 error
          ],
        },
      }).lastMessageErrored,
    ).toBe(false);
    expect(
      collectConvFacts(cId, {
        ...base,
        messagesByConv: {
          [cId]: [assistantMsg(cId, { id: 'b', error: { message: 'x', retryable: true } })],
        },
      }).lastMessageErrored,
    ).toBe(true);
  });

  it('taskStatuses：只取本对话的任务', () => {
    const cId = 'c4';
    const facts = collectConvFacts(cId, {
      streamingMessageIdByConv: {},
      proposalsByConv: {},
      tasksByConv: { [cId]: [task(cId, 'running'), task(cId, 'done')], other: [task('other', 'failed')] },
      messagesByConv: {},
      convById: { [cId]: conv(cId) },
    });
    expect(facts.taskStatuses.sort()).toEqual(['done', 'running']);
  });

  it('updatedAt / lastSeenAt 取自 Conversation', () => {
    const cId = 'c5';
    const facts = collectConvFacts(cId, {
      streamingMessageIdByConv: {},
      proposalsByConv: {},
      tasksByConv: {},
      messagesByConv: {},
      convById: { [cId]: conv(cId, { updatedAt: 500, lastSeenAt: 300 }) },
    });
    expect(facts.updatedAt).toBe(500);
    expect(facts.lastSeenAt).toBe(300);
  });

  it('端到端：主 agent pending proposal → badge todo（不被旧过滤漏掉）', () => {
    const cId = 'c6';
    const f = collectConvFacts(cId, {
      streamingMessageIdByConv: {},
      proposalsByConv: { [cId]: [bashProposal(cId, 'pending')] },
      tasksByConv: {},
      messagesByConv: {},
      convById: { [cId]: conv(cId) },
    });
    expect(deriveConvState(f)).toBe('awaiting-approval');
    expect(deriveConvBadge(f)).toBe('todo');
  });
});

describe('groupTasksByConv', () => {
  it('按 conversationId 分桶', () => {
    const grouped = groupTasksByConv({
      a: task('c1', 'running'),
      b: task('c1', 'done'),
      c: task('c2', 'failed'),
    });
    expect(grouped.c1.map((t) => t.status).sort()).toEqual(['done', 'running']);
    expect(grouped.c2.map((t) => t.status)).toEqual(['failed']);
  });
});

/**
 * G53 回归：错过的定时任务 → 承载对话标 missed（占位转真值）。
 * 只认 runLocation 指向对话的任务；newConversation 型不挂对话轴。
 */
describe('buildMissedByConv（G53）', () => {
  const mkTask = (over: Partial<ScheduledTask>): ScheduledTask =>
    ({
      id: 't', ownerId: 'o', agentId: 'a', title: '', prompt: '',
      runLocation: { kind: 'newConversation' }, spec: { kind: 'daily', minutesOfDay: 0 },
      enabled: true, createdBy: 'user', nextRunAt: null, runCount: 0,
      createdAt: 0, updatedAt: 0, ...over,
    }) as ScheduledTask;

  it('missedAt 非空 + runLocation=conversation → 标该对话', () => {
    const m = buildMissedByConv([
      mkTask({ id: 'a', missedAt: 123, runLocation: { kind: 'conversation', id: 'c1' } }),
    ]);
    expect(m).toEqual({ c1: true });
  });

  it('missedAt 空 或 newConversation → 不进对话轴', () => {
    const m = buildMissedByConv([
      mkTask({ id: 'a', missedAt: undefined, runLocation: { kind: 'conversation', id: 'c1' } }),
      mkTask({ id: 'b', missedAt: 123, runLocation: { kind: 'newConversation' } }),
    ]);
    expect(m).toEqual({});
  });

  it('接进 collectConvFacts 后 state 判为 missed（占位转真的端到端）', () => {
    const missedByConv = buildMissedByConv([
      mkTask({ id: 'a', missedAt: 123, runLocation: { kind: 'conversation', id: 'c1' } }),
    ]);
    const f = collectConvFacts('c1', {
      streamingMessageIdByConv: {}, proposalsByConv: {}, tasksByConv: {},
      messagesByConv: {}, convById: { c1: { updatedAt: 5 } as Conversation }, missedByConv,
    });
    expect(f.missed).toBe(true);
    expect(deriveConvState(f)).toBe('missed');
  });
});
