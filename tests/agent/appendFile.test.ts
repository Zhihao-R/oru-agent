/**
 * append_file —— 往表尾加一行的原语。
 *
 * 承重的四条：
 *   ① 只追加，已有内容一个字不动（它取代的是 bash + python 那条会写坏行尾的路）；
 *   ② 原文没有尾换行时不把新行黏进最后一条记录（真损坏，不是风格问题）；
 *   ③ 首次追加不必先 read_file——追加动不了已有内容，覆盖守卫问的那个问题在它身上不成立；
 *   ④ 但它也拿不到整篇覆盖的记账：追加完模型仍**没见过**整篇，所以既不建立 D3 所有权凭据
 *      （否则「加一行」附带解锁「整篇覆盖免审」），也不留「已读」记录（否则随后的 read_file
 *      命中去重 stub、模型拿不到内容）。这两条是 reviewer 在第一版实现里抓到的真问题。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@shared/types';
import type { ToolResult } from '@shared/agent/backend';
import { readStructuredMarkers } from '@shared/agent/structuredMarkers';

const H = vi.hoisted(() => {
  // hoisted 早于所有 import 执行，这里不能用 node:path/os——手拼一个 tmp 路径
  const dir = `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/oru-test-append-${Date.now()}`;
  process.env.ORU_DIR = dir;
  return { dir };
});

vi.mock('../../electron/main/agent/agentTools/pathSandbox', () => ({
  assertWritableSandbox: async () => {},
  SandboxError: class SandboxError extends Error {},
}));
vi.mock('../../electron/main/fs/fsChanged', () => ({ broadcastFileChanged: async () => {} }));
vi.mock('../../electron/main/proposals/tableGate', () => ({ assertTableGate: async () => {} }));
vi.mock('../../electron/main/agent/store/agents', () => ({
  getAgent: async (id: string): Promise<Agent> => ({
    id,
    ownerId: 'local-user',
    name: 'Oru',
    homePath: '/tmp/h',
    systemPromptAppend: null,
    approvalMode: 'danger',
    createdAt: 0,
    avatarPath: null,
  }),
  realtimeApprovalModeFor: async (): Promise<Agent['approvalMode']> => 'danger',
}));

let makeAppendFileTool!: typeof import('../../electron/main/agent/agentTools/appendFile').makeAppendFileTool;
let clearConvFileState!: typeof import('../../electron/main/agent/conversationFileState').clearConvFileState;

const WORK = join(H.dir, 'work');
let n = 0;
const tmpCsv = (content: string, ext = '.csv'): string => {
  const p = join(WORK, `t${n++}${ext}`);
  writeFileSync(p, content, 'utf-8');
  return p;
};

beforeAll(async () => {
  await fs.mkdir(WORK, { recursive: true });
  ({ makeAppendFileTool } = await import('../../electron/main/agent/agentTools/appendFile'));
  ({ clearConvFileState } = await import('../../electron/main/agent/conversationFileState'));
});

afterAll(async () => {
  await fs.rm(H.dir, { recursive: true, force: true });
});

beforeEach(() => {
  clearConvFileState('conv_1'); // 每例都从"这个对话没读过任何文件"起步
});

const append = async (path: string, content: string): Promise<ToolResult> => {
  const { makeToolContext } = await import('../helpers/toolContext');
  return makeAppendFileTool().execute({ path, content }, makeToolContext({ conversationId: 'conv_1' }));
};

describe('append_file', () => {
  it('首次追加即成功：不必先 read_file，守卫靠自证读过放行', async () => {
    const p = tmpCsv('公司,岗位\n阿里,搜索\n');
    const r = await append(p, '字节,推荐\n');
    expect(r.isError).toBeFalsy();
    expect(readFileSync(p, 'utf-8')).toBe('公司,岗位\n阿里,搜索\n字节,推荐\n');
    // 「本轮文件变更」事实标记（2026-07-28 迁 fileChanges 形状）：追加已有文件 = modify
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([{ path: p, op: 'modify' }]);
  });

  it('原文没有尾换行：补一个，不把新行黏进最后一条记录', async () => {
    const p = tmpCsv('公司,岗位\n阿里,搜索'); // 无尾换行
    await append(p, '字节,推荐\n');
    expect(readFileSync(p, 'utf-8')).toBe('公司,岗位\n阿里,搜索\n字节,推荐\n');
  });

  it('追加后整篇定型：摘掉不必要的引号（模型爱给长文本裹引号，那会让文件不合规范）', async () => {
    const p = tmpCsv('公司,岗位\n阿里,搜索\n');
    await append(p, '"字节","推荐"\n');
    expect(readFileSync(p, 'utf-8')).toBe('公司,岗位\n阿里,搜索\n字节,推荐\n');
  });

  it('CRLF 原文：行尾沿用原文件风格（执行器的既有约定），全文仍是同一种行尾、不混合', async () => {
    const p = tmpCsv('公司,岗位\r\n阿里,搜索\r\n');
    await append(p, '"字节","推荐"\n');
    // 定型统一了行尾（内部一律 LF），落盘时执行器按原文件风格还原——关键是产出**不混合**，
    // 而 bash + python 那条路写出的正是「记录之间 CRLF、单元格内 LF」的混合体。
    expect(readFileSync(p, 'utf-8')).toBe('公司,岗位\r\n阿里,搜索\r\n字节,推荐\r\n');
  });

  it('含逗号的格子该保留的引号保留', async () => {
    const p = tmpCsv('公司,要求\n');
    await append(p, '阿里,"SQL,指标体系"\n');
    expect(readFileSync(p, 'utf-8')).toBe('公司,要求\n阿里,"SQL,指标体系"\n');
  });

  it('文件不存在 → 新建', async () => {
    const p = join(WORK, 'new.csv');
    const r = await append(p, 'a,b\n');
    expect(r.isError).toBeFalsy();
    expect(readFileSync(p, 'utf-8')).toBe('a,b\n');
    // 追加不存在的文件 = 新建，标记 create
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([{ path: p, op: 'create' }]);
  });

  it('非 .csv 逐字面追加，不替调用方补换行', async () => {
    const p = tmpCsv('第一行', '.md');
    await append(p, '第二行');
    expect(readFileSync(p, 'utf-8')).toBe('第一行第二行');
  });

  it('两笔并发追加都不丢：拼接在锁内做，不是拿提案发出那刻的快照覆盖', async () => {
    const p = tmpCsv('公司,岗位\n');
    await Promise.all([append(p, '甲,一\n'), append(p, '乙,二\n')]);
    const out = readFileSync(p, 'utf-8');
    expect(out).toContain('甲,一');
    expect(out).toContain('乙,二');
    expect(out.trimEnd().split('\n')).toHaveLength(3); // 表头 + 两行，谁都没盖掉谁
  });

  it('追加不建立 D3 所有权凭据：加一行不该附带解锁「整篇覆盖免审」', async () => {
    const p = tmpCsv('公司,岗位\n阿里,搜索\n');
    await append(p, '字节,推荐\n');
    const { isOwnedVersion, checkGuard } = await import('../../electron/main/agent/conversationFileState');
    const { readWithMeta } = await import('../../electron/main/fs/safeWrite');
    expect(isOwnedVersion('conv_1', p, readWithMeta(p).content)).toBe(false);
    // 想整篇覆盖仍须先真读一遍——模型只供了尾巴，没见过这张表
    expect(checkGuard('conv_1', p, 'overwrite')).toBe('never-read');
  });

  it('追加不留「已读」记录：随后 read_file 必须真读到内容，不能命中去重 stub', async () => {
    const p = tmpCsv('公司,岗位\n阿里,搜索\n');
    await append(p, '字节,推荐\n');
    const { canSkipReread } = await import('../../electron/main/agent/conversationFileState');
    const { floorMtime } = await import('../../electron/main/fs/safeWrite');
    expect(canSkipReread('conv_1', p, floorMtime(p), undefined, undefined)).toBe(false);
  });

  it('空 content → 拒绝（没有要追加的东西）', async () => {
    const p = tmpCsv('a,b\n');
    expect((await append(p, '')).isError).toBe(true);
  });
});
