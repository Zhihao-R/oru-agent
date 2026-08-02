/**
 * feishu_doc 工具 —— user 身份分流切进程内 UAT 内核（S5）后的行为契约。
 *
 * 验六件承重事：
 *  1. 身份分流：默认 user → user 内核（进程内 UAT，零 spawn——lark-cli 不再被工具调用）；
 *     identity=bot → bot 内核（SDK）。两内核互不触达。
 *  2. 参数透传：fetch（doc/scope/detail/format）、create（title/format/content）、
 *     update（doc/command/pattern/blockId/format/content）原样进内核。
 *  3. 读顺畅：fetch 任何挡位直执行、不构造提案（对齐 read_file）。
 *  4. 写走提案流：create/update 经 proposeOrExecute——work/danger 直执行、只读挡拒且不触达内核。
 *  5. authFailure 如实透传：needsReauth → isError + 「设置 ▸ 平台连接」重新授权指引（不沉默、不装成功）。
 *  6. 参数校验：缺 doc/content/command 不触达内核，直接 isError。
 *
 * 两内核皆依赖注入（makeFeishuDocTool(userKernel, botKernel)），mock 受 FeishuDocKernel
 * 类型约束（仓规 satisfies 精神）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@shared/types';
import type { ToolResult } from '@shared/agent/backend';

const state = vi.hoisted(() => ({
  mode: 'work' as Agent['approvalMode'],
}));

vi.mock('../../electron/main/i18n/effectiveLang', () => ({ resolveEffectiveLang: () => 'zh' }));
vi.mock('../../electron/main/agent/store/agents', () => {
  const getAgent = vi.fn(
    async (id: string): Promise<Agent> => ({
      id,
      ownerId: 'local-user',
      name: 'Oru',
      homePath: '/tmp/h',
      systemPromptAppend: null,
      approvalMode: state.mode,
      createdAt: 0,
      avatarPath: null,
    }),
  );
  const realtimeApprovalModeFor = async (
    agentId: string,
    fallback: Agent['approvalMode'],
  ): Promise<Agent['approvalMode']> => {
    try {
      return (await getAgent(agentId)).approvalMode;
    } catch {
      return fallback;
    }
  };
  return { getAgent, realtimeApprovalModeFor };
});
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'local-user',
}));

import { makeFeishuDocTool } from '../../electron/main/agent/agentTools/feishuDoc';
import type { FeishuDocKernel, FeishuDocOutcome } from '../../electron/main/platform/feishuDocsAi';
import { makeToolContext } from '../helpers/toolContext';

/** 内核假身：三个 op 都是 vi.fn，默认回 ok 空信封（mock 受 FeishuDocKernel 类型约束）。 */
function makeKernel(outcome: FeishuDocOutcome = { ok: true, text: '{"ok":true,"data":{}}' }) {
  return {
    fetch: vi.fn<FeishuDocKernel['fetch']>(async () => outcome),
    create: vi.fn<FeishuDocKernel['create']>(async () => outcome),
    update: vi.fn<FeishuDocKernel['update']>(async () => outcome),
  };
}

beforeEach(() => {
  state.mode = 'work';
});

describe('身份分流（user 进程内内核，零 spawn）', () => {
  it('默认 user：进 user 内核，bot 内核不触达', async () => {
    const userKernel = makeKernel();
    const botKernel = makeKernel();
    const tool = makeFeishuDocTool(userKernel, botKernel);
    await tool.execute({ op: 'fetch', doc: 'ABC' }, makeToolContext());
    expect(userKernel.fetch).toHaveBeenCalledOnce();
    expect(botKernel.fetch).not.toHaveBeenCalled();
  });

  it('identity=bot：进 bot 内核，user 内核不触达', async () => {
    const userKernel = makeKernel();
    const botKernel = makeKernel();
    const tool = makeFeishuDocTool(userKernel, botKernel);
    await tool.execute({ op: 'fetch', doc: 'ABC', identity: 'bot' }, makeToolContext());
    expect(botKernel.fetch).toHaveBeenCalledOnce();
    expect(userKernel.fetch).not.toHaveBeenCalled();
  });

  it('fetch 参数透传（doc/scope/detail/format），成功回内核文本', async () => {
    const userKernel = makeKernel({ ok: true, text: '{"ok":true,"identity":"user","data":{"document":{"content":"<p>正文</p>"}}}' });
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    const r = (await tool.execute(
      { op: 'fetch', doc: 'https://x.feishu.cn/docx/ABC', scope: 'outline', detail: 'with-ids', format: 'markdown' },
      makeToolContext(),
    )) as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('正文');
    expect(userKernel.fetch).toHaveBeenCalledWith({
      doc: 'https://x.feishu.cn/docx/ABC',
      scope: 'outline',
      detail: 'with-ids',
      format: 'markdown',
    });
  });

  it('create/update 参数透传内核', async () => {
    const userKernel = makeKernel();
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    await tool.execute({ op: 'create', title: '周记', content: '<p>a</p>', format: 'markdown' }, makeToolContext());
    expect(userKernel.create).toHaveBeenCalledWith({ title: '周记', format: 'markdown', content: '<p>a</p>' });
    await tool.execute(
      { op: 'update', doc: 'ABC', command: 'str_replace', pattern: '旧', content: '新' },
      makeToolContext(),
    );
    expect(userKernel.update).toHaveBeenCalledWith({
      doc: 'ABC',
      command: 'str_replace',
      pattern: '旧',
      blockId: undefined,
      format: undefined,
      content: '新',
    });
  });
});

describe('读顺畅（不构造提案）', () => {
  it('work 挡 fetch 直执行，onProposal 未调', async () => {
    const userKernel = makeKernel();
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    const onProposal = vi.fn(async () => {});
    const r = (await tool.execute({ op: 'fetch', doc: 'ABC' }, makeToolContext({ onProposal }))) as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(onProposal).not.toHaveBeenCalled();
  });

  it('只读挡 fetch 也直执行（读不是写）', async () => {
    state.mode = 'readonly';
    const userKernel = makeKernel();
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    const r = (await tool.execute({ op: 'fetch', doc: 'ABC' }, makeToolContext())) as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(userKernel.fetch).toHaveBeenCalledOnce();
  });
});

describe('写走 proposeOrExecute 提案流', () => {
  it('work 挡 create/update 直执行（对齐 write_file），不弹卡', async () => {
    const userKernel = makeKernel();
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    const onProposal = vi.fn(async () => {});
    await tool.execute({ op: 'create', content: '<p>a</p>' }, makeToolContext({ onProposal }));
    await tool.execute({ op: 'update', doc: 'ABC', command: 'append', content: '<p>b</p>' }, makeToolContext({ onProposal }));
    expect(userKernel.create).toHaveBeenCalledOnce();
    expect(userKernel.update).toHaveBeenCalledOnce();
    expect(onProposal).not.toHaveBeenCalled();
  });

  it('danger 挡写直执行', async () => {
    state.mode = 'danger';
    const userKernel = makeKernel();
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    const r = (await tool.execute({ op: 'create', content: '<p>a</p>' }, makeToolContext())) as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(userKernel.create).toHaveBeenCalledOnce();
  });

  it('只读挡 create/update 拒：不触达内核，回执说只读挡', async () => {
    state.mode = 'readonly';
    const userKernel = makeKernel();
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    const r1 = (await tool.execute({ op: 'create', content: '<p>a</p>' }, makeToolContext())) as ToolResult;
    const r2 = (await tool.execute(
      { op: 'update', doc: 'ABC', command: 'append', content: '<p>b</p>' },
      makeToolContext(),
    )) as ToolResult;
    expect(r1.text).toContain('只读');
    expect(r2.text).toContain('只读');
    expect(userKernel.create).not.toHaveBeenCalled();
    expect(userKernel.update).not.toHaveBeenCalled();
  });
});

describe('authFailure 与错误透传', () => {
  it('needsReauth（读）：isError + hint 透传 + 设置页重新授权指引，不装成功', async () => {
    const userKernel = makeKernel({
      ok: false,
      text: '{"ok":false,"identity":"user","error":{"type":"authentication","subtype":"token_missing"}}',
      authFailure: { needsReauth: true, hint: '飞书用户授权未建立或已失效' },
    });
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    const r = (await tool.execute({ op: 'fetch', doc: 'ABC' }, makeToolContext())) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.text).toContain('飞书用户授权未建立或已失效');
    expect(r.text).toMatch(/重新授权|授权失效/);
    expect(r.text).toContain('设置 ▸ 平台连接');
  });

  it('needsReauth（写）：同样如实透传（提案批准后执行才撞 auth，回执不撒谎）', async () => {
    const userKernel = makeKernel({
      ok: false,
      text: '{"ok":false,"identity":"user","error":{"type":"authentication","subtype":"token_invalid"}}',
      authFailure: { needsReauth: true },
    });
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    const r = (await tool.execute({ op: 'create', content: '<p>a</p>' }, makeToolContext())) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/重新授权|授权失效/);
  });

  it('内核结构化错误（app_scope_not_applied）→ isError 带细节，不归类为重新授权', async () => {
    const userKernel = makeKernel({
      ok: false,
      text: '{"ok":false,"identity":"user","error":{"type":"authorization","subtype":"app_scope_not_applied","console_url":"https://open.feishu.cn/page/scope-apply?clientID=cli_x"}}',
      authFailure: { needsReauth: false },
    });
    const tool = makeFeishuDocTool(userKernel, makeKernel());
    const r = (await tool.execute({ op: 'create', content: '<p>a</p>' }, makeToolContext())) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.text).toContain('feishu_doc create 失败：');
    expect(r.text).toContain('app_scope_not_applied');
    expect(r.text).not.toContain('重新授权');
  });
});

describe('参数校验（不触达内核）', () => {
  it('fetch 缺 doc / create 缺 content / update 缺 doc 或 command / 未知 op', async () => {
    const userKernel = makeKernel();
    const botKernel = makeKernel();
    const tool = makeFeishuDocTool(userKernel, botKernel);
    for (const input of [
      { op: 'fetch' },
      { op: 'create' },
      { op: 'update', command: 'append', content: 'x' },
      { op: 'update', doc: 'ABC' },
      { op: 'destroy', doc: 'ABC' },
    ]) {
      const r = (await tool.execute(input, makeToolContext())) as ToolResult;
      expect(r.isError, JSON.stringify(input)).toBe(true);
    }
    expect(userKernel.fetch).not.toHaveBeenCalled();
    expect(userKernel.create).not.toHaveBeenCalled();
    expect(userKernel.update).not.toHaveBeenCalled();
    expect(botKernel.fetch).not.toHaveBeenCalled();
  });
});

describe('工具元数据', () => {
  it('name / mutatesEnvironment=false（条件变更，读写分流在工具内）/ schema', () => {
    const tool = makeFeishuDocTool(makeKernel(), makeKernel());
    expect(tool.name).toBe('feishu_doc');
    expect(tool.mutatesEnvironment).toBe(false);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('op');
  });
});
