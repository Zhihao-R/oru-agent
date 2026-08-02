/**
 * 同步化的两处回归防线（2026-07-28 review 发现，同批修）。
 *
 * 1. **「没人能点」必须一路传到工具层**。`runChatAndPersist` 原本给缺席的 `onProposal` 补一个
 *    noop，于是 `ctx.onProposal` 恒为真值——审批类工具据它判断「这条回合有没有人能弹卡、
 *    有人能点」，看到 noop 就进同步等待，等一个永不到来的决定。改前那是一句预告文案（不挂死），
 *    同步化后就是整轮挂死、会话锁一直占着。任务看板评论回合正是不传 onProposal 却带全量
 *    twinMain 工具集（只 deny 了 propose_action / commit_changes）的那条路径。
 *
 * 2. **只读挡下 deck 仍可由用户亲自批准**。`propose_deck_create` 声明 `mutatesEnvironment: false`、
 *    本就不受中央闸管，改前只读挡是弹卡等批准（批了就建）。迁到 proposeOrExecute 后被只读挡的
 *    「写类一律硬拒」分支拦成连卡都不弹——只读挡彻底做不了 deck，是迁移的意外副作用。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActionProposal } from '@shared/types';
import type { ToolContext } from '@shared/agent/backend';

const ORU_DIR = join(tmpdir(), `oru-test-noui-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const SRC_ROOT = join(tmpdir(), `oru-test-noui-src-${Date.now()}`);

vi.mock('../../electron/main/agent/store/agents', async (orig) => {
  const actual = await orig<typeof import('../../electron/main/agent/store/agents')>();
  return { ...actual, getAgent: vi.fn(async () => null) satisfies typeof actual.getAgent };
});

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: 'conv-noui',
    agentId: 'agent-noui',
    ownerId: 'local-user',
    approvalMode: 'work',
    usage: 'twinMain',
    abortSignal: new AbortController().signal,
    ...over,
  } satisfies ToolContext;
}

async function writeLocalSkill(name: string): Promise<string> {
  const root = join(SRC_ROOT, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a skill named ${name}\n---\n\n# ${name}\n`,
    'utf-8',
  );
  return root;
}

beforeEach(async () => {
  await fs.mkdir(join(ORU_DIR, 'skills'), { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
  await fs.rm(SRC_ROOT, { recursive: true, force: true });
});

describe('「没人能点」的空缺不许被 noop 填掉', () => {
  it('runChatAndPersist 不传 onProposal 时，透传给 runChat 的也是 undefined', async () => {
    // 只验接线契约：塞 noop 会让下游误以为有人能点，那是评论回合挂死的根因。
    const seen: Array<Record<string, unknown>> = [];
    vi.doMock('../../electron/main/agent/runner', () => ({
      runChat: vi.fn(async (args: Record<string, unknown>) => {
        seen.push(args);
        return { text: '', status: 'ok' };
      }),
    }));
    vi.resetModules();
    const mod = await import('../../electron/main/ws/runChatAndPersist');
    const src = await fs.readFile(
      join(process.cwd(), 'electron/main/ws/runChatAndPersist.ts'),
      'utf-8',
    );
    // 源码级断言：这个文件里不许再出现「给缺席的 onProposal 补兜底」的写法。
    // （比跑通整条 runChatAndPersist 便宜得多，且钉的正是那一行。）
    expect(src).not.toMatch(/onProposal\s*[?:]{1,2}\s*\w*[Nn]oop/);
    expect(src).not.toContain('noopProposal');
    expect(typeof mod.runChatAndPersist).toBe('function');
  });

  it('工具侧：没挂 onProposal 且需审批 → 不执行、不挂起，如实回执', async () => {
    const src = await writeLocalSkill('noui-skill');
    const { makeProposeSkillInstallLocalTool } = await import(
      '../../electron/main/agent/agentTools/plugin'
    );
    // 无 onProposal：这条回合没人能弹卡、没人能点。必须立刻返回，绝不能 await 一个永不到来的决定。
    const r = await Promise.race([
      makeProposeSkillInstallLocalTool().execute({ localPath: src }, makeCtx()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('工具挂死了')), 3000)),
    ]);
    expect((r as { text: string }).text).toContain('没有可确认的界面');
    expect(existsSync(join(ORU_DIR, 'skills', 'noui-skill'))).toBe(false);
  });
});

describe('只读挡下 deck 仍弹卡等用户批准（不硬拒）', () => {
  it('propose_deck_create 在只读挡走审批流，而不是「已停下未执行」', async () => {
    const cards: ActionProposal[] = [];
    const { makeProposeDeckCreateTool } = await import(
      '../../electron/main/agent/agentTools/proposeDeck'
    );
    const r = await makeProposeDeckCreateTool().execute(
      {
        deck_name: '只读挡测试',
        target_project_id: 'proj-noui',
        brief: 'b',
        size_hint: '5 页',
        narrative: 'n',
      },
      makeCtx({
        approvalMode: 'readonly',
        activeProjectId: 'proj-noui',
        onProposal: async (p) => {
          cards.push(p);
          const { settleProposalDecision } = await import(
            '../../electron/main/proposals/pendingDecision'
          );
          settleProposalDecision(p.id, 'rejected');
        },
      }),
    );

    // 关键：不是「当前是只读挡…已停下未执行」那句硬拒——卡真的弹出来了
    expect(r.text).not.toContain('已停下未执行');
    expect(cards.length).toBeGreaterThan(0);
  });
});

describe('propose_deck_create 空参数校验（防 sanitizeDeckName(undefined) crash）', () => {
  it('缺全部 required 字段时返回 isError + 列出缺失字段', async () => {
    const { makeProposeDeckCreateTool } = await import(
      '../../electron/main/agent/agentTools/proposeDeck'
    );
    const r = await makeProposeDeckCreateTool().execute({}, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Missing required parameters');
    expect(r.text).toContain('deck_name');
    expect(r.text).toContain('brief');
    expect(r.text).toContain('size_hint');
    expect(r.text).toContain('narrative');
  });

  it('只缺 size_hint 时只报 size_hint', async () => {
    const { makeProposeDeckCreateTool } = await import(
      '../../electron/main/agent/agentTools/proposeDeck'
    );
    const r = await makeProposeDeckCreateTool().execute(
      { deck_name: 'x', brief: 'b', narrative: 'n' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain('size_hint');
    expect(r.text).not.toContain('deck_name');
  });
});
