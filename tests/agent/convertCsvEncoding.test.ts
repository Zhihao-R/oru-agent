/**
 * convert_csv_encoding —— 出口闸门「这张表不是 UTF-8」那条拦截的出路。
 *
 * 承重的是「AI 自己能走完这条路」：2026-07-26 那次它被拦下后拿到的出路是用户侧 UI 操作，
 * 按不了，于是删掉原文件重建、内容缩水。所以这里验的是端到端能把 GBK 文件真转成 UTF-8。
 * 审批口径（2026-07-30 决策 7）：转换随覆盖同口径弹卡、并入 {overwrite} 整类授权——
 * 未授权照弹（卡面保留不可逆警示一行），已授权免卡直转。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import iconv from 'iconv-lite';
import type { Agent } from '@shared/types';
import type { ToolResult } from '@shared/agent/backend';
import { readStructuredMarkers } from '@shared/agent/structuredMarkers';

// ORU_DIR 必须在被测模块（fileHistory → runtime/paths）首次求值前就位——静态 import 会被提升到
// 赋值之前，故用 vi.hoisted + 动态 import（仓库既有陷阱，见 tests/fs/workfileWrite.test.ts）。
const H = vi.hoisted(() => {
  // hoisted 早于所有 import 执行，这里不能用 node:path/os——手拼一个 tmp 路径
  const dir = `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/oru-test-convcsv-${Date.now()}`;
  process.env.ORU_DIR = dir;
  return { dir, mode: 'danger' as Agent['approvalMode'] };
});

vi.mock('../../electron/main/agent/agentTools/pathSandbox', () => ({
  assertWritableSandbox: async () => {},
  SandboxError: class SandboxError extends Error {},
}));
vi.mock('../../electron/main/fs/fsChanged', () => ({ broadcastFileChanged: async () => {} }));
vi.mock('../../electron/main/agent/store/agents', () => ({
  getAgent: async (id: string): Promise<Agent> => ({
    id,
    ownerId: 'local-user',
    name: 'Oru',
    homePath: '/tmp/h',
    systemPromptAppend: null,
    approvalMode: H.mode,
    createdAt: 0,
    avatarPath: null,
  }),
  realtimeApprovalModeFor: async (): Promise<Agent['approvalMode']> => H.mode,
}));

let makeConvertCsvEncodingTool!: typeof import('../../electron/main/agent/agentTools/convertCsvEncoding').makeConvertCsvEncodingTool;
let buildFileWriteProposal!: typeof import('../../electron/main/proposals/makeFileWriteProposal').buildFileWriteProposal;

const WORK = join(H.dir, 'work');
const GBK_TEXT = '公司,岗位要求\n阿里,搭建指标体系\n';

beforeAll(async () => {
  await fs.mkdir(WORK, { recursive: true });
  ({ makeConvertCsvEncodingTool } = await import('../../electron/main/agent/agentTools/convertCsvEncoding'));
  ({ buildFileWriteProposal } = await import('../../electron/main/proposals/makeFileWriteProposal'));
});

afterAll(async () => {
  await fs.rm(H.dir, { recursive: true, force: true });
});

beforeEach(() => {
  H.mode = 'danger'; // 全放挡 = 不弹卡直执行，用来验落盘结果
});

const run = async (input: Record<string, unknown>): Promise<ToolResult> => {
  const { makeToolContext } = await import('../helpers/toolContext');
  return makeConvertCsvEncodingTool().execute(input, makeToolContext({ conversationId: 'conv_1' }));
};

describe('convert_csv_encoding', () => {
  it('GBK 文件 convert：落盘变成 UTF-8 规范文本，内容一个字不变', async () => {
    const p = join(WORK, 'gbk.csv');
    writeFileSync(p, iconv.encode(GBK_TEXT, 'gbk'));

    const r = await run({ path: p });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(p, 'utf-8')).toBe(GBK_TEXT); // 严格 UTF-8 读得回来 = 转换到位
    // 「本轮文件变更」事实标记（2026-07-28 迁 fileChanges 形状）：原地转换 = modify
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([{ path: p, op: 'modify' }]);
  });

  it('已是 UTF-8：明说无需转换，文件一个字节不动', async () => {
    const p = join(WORK, 'utf8.csv');
    writeFileSync(p, GBK_TEXT, 'utf-8');
    const before = readFileSync(p);

    const r = await run({ path: p });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/不需要转换/);
    expect(readFileSync(p).equals(before)).toBe(true);
  });

  it('copy：另存规范副本，原件逐字节不动', async () => {
    const p = join(WORK, 'keep.csv');
    const original = iconv.encode(GBK_TEXT, 'gbk');
    writeFileSync(p, original);

    const r = await run({ path: p, mode: 'copy' });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(WORK, 'keep-规范.csv'), 'utf-8')).toBe(GBK_TEXT);
    expect(readFileSync(p).equals(original)).toBe(true);
    // 副本 = 新文件，标记 create 且路径是副本
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([
      { path: join(WORK, 'keep-规范.csv'), op: 'create' },
    ]);
  });

  it('目标在编辑器里有未保存草稿 → 拦下，不覆盖（守卫独立于审批：全放挡也要查）', async () => {
    // 草稿从未落盘，FileHistory 兜不到它——转换若直接盖磁盘，用户那笔改动无从追回。
    const p = join(WORK, 'dirty.csv');
    const original = iconv.encode(GBK_TEXT, 'gbk');
    writeFileSync(p, original);
    const rq = await import('../../electron/main/agent/rendererQuery');
    rq.setRendererQueryDeps({
      broadcast: (e) => {
        if (e.type === 'renderer.query') rq.resolveRendererQuery(e.queryId, { paths: [p] });
      },
      hasClients: () => true,
    });
    try {
      const r = await run({ path: p });
      expect(r.isError).toBe(true);
      expect(readFileSync(p).equals(original)).toBe(true); // 一个字节没动
    } finally {
      rq.setRendererQueryDeps({ broadcast: () => {}, hasClients: () => false });
    }
  });

  it('等确认期间文件被改动 → 拒写退回，不拿旧字节覆盖新内容', async () => {
    const p = join(WORK, 'raced.csv');
    writeFileSync(p, iconv.encode(GBK_TEXT, 'gbk'));
    H.mode = 'work'; // 走审批：卡片弹出后才落盘，中间留出被改动的窗口
    const { settleProposalDecision } = await import('../../electron/main/proposals/pendingDecision');
    const { makeToolContext } = await import('../helpers/toolContext');
    const r = await makeConvertCsvEncodingTool().execute(
      { path: p },
      makeToolContext({
        conversationId: 'conv_1',
        onProposal: async (proposal) => {
          writeFileSync(p, iconv.encode('公司,岗位要求\n阿里,搭建指标体系\n别人,刚加的一行\n', 'gbk'));
          settleProposalDecision(proposal.id, 'approved');
        },
      }),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/被改动过/);
    expect(iconv.decode(readFileSync(p), 'gbk')).toContain('别人,刚加的一行'); // 那一行还在
  });

  it('非 .csv / 相对路径 → 拒绝', async () => {
    expect((await run({ path: join(WORK, 'a.md') })).isError).toBe(true);
    expect((await run({ path: 'relative.csv' })).isError).toBe(true);
  });

  it('{overwrite} 已授权（整类）→ 免卡直转；未授权照弹（决策 7）', async () => {
    H.mode = 'work';
    const { addGrant, revokeGrant } = await import('../../electron/main/proposals/grants/store');
    const { makeToolContext } = await import('../helpers/toolContext');
    const p = join(WORK, 'granted.csv');
    writeFileSync(p, iconv.encode(GBK_TEXT, 'gbk'));
    await addGrant({ kind: 'overwrite' }, '覆盖既有内容');
    const onProposal = vi.fn(async () => {});
    const r = await makeConvertCsvEncodingTool().execute(
      { path: p },
      makeToolContext({ conversationId: 'conv_1', onProposal }),
    );
    expect(onProposal).not.toHaveBeenCalled(); // 整类授权命中 → 免卡
    expect(r.isError).not.toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe(GBK_TEXT); // 真转成 UTF-8
    await revokeGrant('overwrite');
  });

  it('转换提案随覆盖弹卡、共享 {overwrite} 授权 scope、警示保留（决策 7）', () => {
    const p = buildFileWriteProposal({
      conversationId: 'conv_1',
      path: '/tmp/x.csv',
      mode: 'overwrite',
      content: 'a,b\n',
      caution: 'encoding-conversion',
    });
    expect(p.forceApproval).toBe(true);
    expect(p.grantable).toEqual([{ kind: 'overwrite' }]); // 并入「覆盖既有内容」整类授权
    expect(p.caution).toBe('encoding-conversion'); // 卡面不可逆警示保留
  });
});
