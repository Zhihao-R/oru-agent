/**
 * runCapture → dreamScheduler 联动测试
 *
 * 核心不变量：capture 成功写入 N 条 episode 后，必须调 onEpisodeWritten N 次，
 * 否则纯 capture 用户 newEpisodeCount 恒 0，每日 dream 与 20 条阈值都永不触发。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 锚到真实签名（typeof import）——接口加字段时这里会红，不裸 as 蒙混
const { onEpisodeWritten, applyOpsMock, runOneShot, readHistoryMock } = vi.hoisted(() => ({
  onEpisodeWritten: vi.fn(),
  applyOpsMock: vi.fn(),
  runOneShot: vi.fn<
    (input: import('@shared/agent/backend').OneShotInput) => Promise<import('@shared/agent/backend').OneShotResult>
  >(),
  readHistoryMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['readHistory']>(),
}));

vi.mock('../../electron/main/memory/dreamScheduler', () => ({ onEpisodeWritten }));
vi.mock('../../electron/main/memory/applyOps', () => ({
  applyOps: (...args: unknown[]) => applyOpsMock(...args),
}));
vi.mock('../../electron/main/agent/backends', () => ({
  // backendType 必须有：instrumentOneShot 把 backend 当 BackendDebugInfo 用，
  // 只在 debugLogger.enabled 时才读——不补的话这条测试就依赖"开关默认关"才绿（假绿）
  getBackendFor: async () => ({ runOneShot, backendType: 'claude-code' as const }),
}));

vi.mock('../../electron/main/conversations/store', () => ({
  readHistory: (...args: unknown[]) => readHistoryMock(...args),
}));

vi.mock('../../electron/main/agent/store/agents', () => ({
  // name 必须有：findAgentForConversation 返回 agent.name 进 RoundMeta.agentName（string 类型）
  listAgents: async () => ({ agents: [{ id: 'a1', ownerId: 'owner1', name: 'TestAgent' }] }),
}));

// debugDir：logger.beginRound 的换日留存清理会取路径（node:fs mock 里 readdir 空数组，清扫空跑）
vi.mock('../../electron/main/runtime/paths', () => ({
  convDir: () => '/tmp/conv',
  debugDir: (ownerId: string) => `/tmp/debug/${ownerId}`,
}));
vi.mock('../../electron/main/memory/paths', () => ({ memoryRoot: () => '/tmp/mem' }));

vi.mock('node:fs', () => ({
  promises: {
    access: async () => undefined, // 让 findAgentForConversation 命中
    readdir: async () => [], // buildRecentEpisodeIndex 空跑
    stat: async () => null,
  },
}));

import { runCapture } from '../../electron/main/memory/capture';
import type { ChatMessage } from '@shared/types';

/** 测试夹具：补齐 ChatMessage 必填字段，role/text/createdAt 之外用占位 */
const msg = (m: Pick<ChatMessage, 'role' | 'text' | 'createdAt'>): ChatMessage => ({
  id: `m${m.createdAt}`,
  conversationId: 'conv1',
  toolCalls: [],
  done: true,
  ...m,
});

/**
 * 构造通过 capture「落盘必需字段校验」的合法 op payload 基线——2026-08-03 起 capture 要求
 * scope/type/title/slug/description/content 齐全（project 另需 projectId）。旧用例只关心 op 的
 * 转发/计数/字段透传，不关心正文内容，故用默认占位 + 覆盖测试关注的那个字段。
 */
const fullPayload = (over: Record<string, unknown> = {}) => ({
  scope: 'agent',
  type: 'user',
  title: 't',
  slug: 't',
  description: 'd',
  content: 'c',
  userRequested: false,
  ...over,
});

beforeEach(() => {
  onEpisodeWritten.mockReset();
  applyOpsMock.mockReset();
  runOneShot.mockReset();
  readHistoryMock.mockReset();
  readHistoryMock.mockResolvedValue([
    msg({ role: 'user', text: 'hi', createdAt: 1 }),
    msg({ role: 'assistant', text: 'yo', createdAt: 2 }),
  ]);
});

describe('runCapture → onEpisodeWritten 联动', () => {

  it('成功写入 3 条 episode → onEpisodeWritten 调 3 次', async () => {
    runOneShot.mockResolvedValue({
      text: JSON.stringify({
        operations: [
          { op: 'create-episode', payload: fullPayload({ title: 'a' }) },
          { op: 'create-episode', payload: fullPayload({ title: 'b' }) },
          { op: 'create-episode', payload: fullPayload({ title: 'c' }) },
        ],
      }),
    });
    applyOpsMock.mockResolvedValue({ okCount: 3, errCount: 0 });

    const r = await runCapture('owner1', 'conv1');
    expect(r.kind).toBe('ok');
    expect(onEpisodeWritten).toHaveBeenCalledTimes(3);
  });

  it('部分失败 → 只按 okCount 计数', async () => {
    runOneShot.mockResolvedValue({
      text: JSON.stringify({
        operations: [
          { op: 'create-episode', payload: fullPayload({ title: 'a' }) },
          { op: 'create-episode', payload: fullPayload({ title: 'b' }) },
        ],
      }),
    });
    applyOpsMock.mockResolvedValue({ okCount: 1, errCount: 1 });

    await runCapture('owner1', 'conv1');
    expect(onEpisodeWritten).toHaveBeenCalledTimes(1);
  });

  it('无 operations（skipped）→ 不调 onEpisodeWritten', async () => {
    runOneShot.mockResolvedValue({ text: JSON.stringify({ operations: [] }) });
    const r = await runCapture('owner1', 'conv1');
    expect(r.kind).toBe('skipped');
    expect(onEpisodeWritten).not.toHaveBeenCalled();
    expect(applyOpsMock).not.toHaveBeenCalled();
  });

  it('增量：只抽 sinceMs 之后的消息，游标推进到最后一条', async () => {
    // 历史两条：user(createdAt=1) + assistant(createdAt=2)；sinceMs=1 应只剩 assistant
    runOneShot.mockResolvedValue({ text: JSON.stringify({ operations: [] }) });
    const r = await runCapture('owner1', 'conv1', 1);
    expect(r.kind).toBe('skipped'); // 看过了但无可记 → coveredUntil 仍推进
    if (r.kind !== 'failed') expect(r.coveredUntil).toBe(2);
    // 喂给 LLM 的文本应只含 assistant 这条（user createdAt=1 被游标排除）
    const prompt = runOneShot.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('[assistant] yo');
    expect(prompt).not.toContain('[user] hi');
  });
});

describe('故障与游标语义（2026-06-11 真机空输出故障的回归）', () => {
  it('空正文 → failed: unparseable-output，coveredUntil 为 null（游标不前进）', async () => {
    // hy3-preview 对 json_schema 静默不兼容的实测形态：HTTP 200、正文空
    runOneShot.mockResolvedValue({ text: '' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runCapture('owner1', 'conv1');
      expect(r).toEqual({ kind: 'failed', error: 'unparseable-output', coveredUntil: null });
      expect(applyOpsMock).not.toHaveBeenCalled();
      // 此路径不经 catch，必须自带日志——否则故障复发时 console 全静默
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('failed: unparseable-output')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('坏 JSON（非空不可解析）→ 同 failed，游标不前进', async () => {
    runOneShot.mockResolvedValue({ text: 'not a json {{{' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runCapture('owner1', 'conv1');
      expect(r).toEqual({ kind: 'failed', error: 'unparseable-output', coveredUntil: null });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('空壳 op（缺 title/slug/content）→ failed: malformed-operations，游标不前进、不落盘', async () => {
    // 2026-08-03 真机故障复现：deepseek-v4-flash-0731 在残缺 schema 下只吐 scope/type/userRequested 三个
    // 字段，title/slug/description/content 全缺。此前这些 op 会带着 undefined 去写出坏文件/挂空索引，
    // 且游标照常推进——同段对话永不再重抽。修复：缺落盘必需字段判为故障，游标不动，schema 修好后自愈。
    runOneShot.mockResolvedValue({
      text: JSON.stringify({
        reason: 'r',
        operations: [
          { op: 'create-episode', payload: { scope: 'agent', type: 'user', userRequested: false } },
        ],
      }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runCapture('owner1', 'conv1');
      expect(r).toEqual({ kind: 'failed', error: 'malformed-operations', coveredUntil: null });
      expect(applyOpsMock).not.toHaveBeenCalled();
      expect(onEpisodeWritten).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('project 空壳 op 缺 projectId → 同样 failed: malformed-operations，游标不前进', async () => {
    runOneShot.mockResolvedValue({
      text: JSON.stringify({
        reason: 'r',
        operations: [
          { op: 'create-episode', payload: { scope: 'project', type: 'project', userRequested: false } },
        ],
      }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runCapture('owner1', 'conv1');
      expect(r).toEqual({ kind: 'failed', error: 'malformed-operations', coveredUntil: null });
      expect(applyOpsMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('显式空数组（带 reason）→ skipped、游标照常推进、日志含 reason', async () => {
    runOneShot.mockResolvedValue({ text: JSON.stringify({ reason: '纯闲聊无稳定事实', operations: [] }) });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const r = await runCapture('owner1', 'conv1');
      expect(r.kind).toBe('skipped');
      if (r.kind !== 'failed') expect(r.coveredUntil).toBe(2);
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('纯闲聊无稳定事实'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('截断对齐：超预算的尾部不进 prompt，游标停在实际入选的最后一条', async () => {
    const big = 'x'.repeat(15000);
    readHistoryMock.mockResolvedValue([
      msg({ role: 'user', text: big, createdAt: 10 }),
      msg({ role: 'assistant', text: big, createdAt: 20 }),
      msg({ role: 'user', text: 'tail-message', createdAt: 30 }),
    ]);
    runOneShot.mockResolvedValue({ text: JSON.stringify({ reason: 'r', operations: [] }) });
    const r = await runCapture('owner1', 'conv1');
    // 第二条加入会超 20000 预算 → 只含第一条，游标 = 10（而非全量 max 30）
    expect(r.kind).toBe('skipped');
    if (r.kind !== 'failed') expect(r.coveredUntil).toBe(10);
    const prompt = runOneShot.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain('tail-message');

    // 下次以 10 续抽：拿到被截走的尾部，游标走到底
    runOneShot.mockClear();
    runOneShot.mockResolvedValue({ text: JSON.stringify({ reason: 'r', operations: [] }) });
    const r2 = await runCapture('owner1', 'conv1', 10);
    if (r2.kind !== 'failed') expect(r2.coveredUntil).toBe(30);
    const prompt2 = runOneShot.mock.calls[0][0].prompt as string;
    expect(prompt2).toContain('tail-message');
  });

  it('同 createdAt 的消息同进同出：截断点不切开同毫秒组', async () => {
    // 游标精度是毫秒：若在同毫秒组中间截断，被截走那条永远落在下次 `> sinceMs` 之外。
    // 第二条超预算但与游标同毫秒 → 软超预算进 prompt；第三条（下一毫秒）才被截走
    const big = 'x'.repeat(19990);
    readHistoryMock.mockResolvedValue([
      msg({ role: 'user', text: big, createdAt: 10 }),
      msg({ role: 'assistant', text: 'same-tick-sibling', createdAt: 10 }),
      msg({ role: 'user', text: 'next-tick', createdAt: 11 }),
    ]);
    runOneShot.mockResolvedValue({ text: JSON.stringify({ reason: 'r', operations: [] }) });
    const r = await runCapture('owner1', 'conv1');
    expect(r.kind).toBe('skipped');
    if (r.kind !== 'failed') expect(r.coveredUntil).toBe(10);
    const prompt = runOneShot.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('same-tick-sibling');
    expect(prompt).not.toContain('next-tick');
  });

  it('sources 兜底：模型输出漏填 sources → 落盘 op 注入当前 convId（纠错覆盖率的地基）', async () => {
    runOneShot.mockResolvedValue({
      text: JSON.stringify({
        reason: 'r',
        operations: [
          { op: 'create-episode', payload: fullPayload({ sources: [] }) },
          { op: 'create-episode', payload: fullPayload({ sources: ['cnv_explicit'] }) },
        ],
      }),
    });
    applyOpsMock.mockResolvedValue({ okCount: 2, errCount: 0, results: [] });
    await runCapture('owner1', 'conv1');
    const ops = applyOpsMock.mock.calls[0][1] as Array<{ payload: { sources?: string[] } }>;
    expect(ops[0].payload.sources).toEqual(['conv1']); // 漏填 → 兜底注入
    expect(ops[1].payload.sources).toEqual(['cnv_explicit']); // 已填 → 不覆盖
  });

  it('项目由调用方给定并进 prompt：给了 id 就照给，给 null 则明说别写 projectId', async () => {
    // applyOps 校验 projectId 必须是已注册项目，编造的整条被拒——模型只能从 prompt 拿这个 id
    runOneShot.mockResolvedValue({ text: JSON.stringify({ reason: 'r', operations: [] }) });
    await runCapture('owner1', 'conv1', 0, 'prj_alpha');
    expect(runOneShot.mock.calls[0][0].prompt).toContain('prj_alpha');

    runOneShot.mockClear();
    await runCapture('owner1', 'conv1', 0, null);
    const prompt = runOneShot.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain('prj_');
    expect(prompt).toContain('不要写 projectId');
  });

  it('userRequested 透传：模型按"明确要求照记"例外标了 true → 原样进 op payload', async () => {
    runOneShot.mockResolvedValue({
      text: JSON.stringify({
        reason: 'r',
        operations: [{ op: 'create-episode', payload: fullPayload({ userRequested: true }) }],
      }),
    });
    applyOpsMock.mockResolvedValue({ okCount: 1, errCount: 0, results: [] });
    await runCapture('owner1', 'conv1');
    const ops = applyOpsMock.mock.calls[0][1] as Array<{ payload: { userRequested?: boolean } }>;
    expect(ops[0].payload.userRequested).toBe(true);
  });

  it('首条即超预算的巨型消息取前缀进 prompt，预算硬顶仍在', async () => {
    // 旧实现 slice(0,20000) 对任何输入都封顶；"至少含一条"不能变成无上限敞口
    const giant = 'y'.repeat(50000);
    readHistoryMock.mockResolvedValue([
      msg({ role: 'user', text: giant, createdAt: 5 }),
      msg({ role: 'assistant', text: 'after-giant', createdAt: 6 }),
    ]);
    runOneShot.mockResolvedValue({ text: JSON.stringify({ reason: 'r', operations: [] }) });
    const r = await runCapture('owner1', 'conv1');
    const prompt = runOneShot.mock.calls[0][0].prompt as string;
    expect(prompt.length).toBeLessThan(25000); // 巨型消息只剩前缀，整体仍被预算封顶
    expect(prompt).not.toContain('after-giant'); // 预算耗尽，下一条被截走
    // 游标覆盖该巨型消息（模型看过前缀，不为一条消息反复重试），下次从它之后续抽
    expect(r.kind).toBe('skipped');
    if (r.kind !== 'failed') expect(r.coveredUntil).toBe(5);
  });
});
