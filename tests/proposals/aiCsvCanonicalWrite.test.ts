/**
 * 执行器绝不改写 AI 递交的内容 —— CSV 规范化归工具层（agentTools/writeFile.ts）。
 *
 * 分工的理由：审批卡的 diff、回执里的字节数、真正落盘的字节必须是同一份内容。规范化若发生在
 * 执行器（审批通过之后），用户批的是 A、落盘的是 B，"所见即所批"就断了。所以工具层在算 diff
 * 之前就把内容定死，执行器此后只搬运。
 *
 * edit 一律不规范化：局部编辑的落盘内容必须与锁内重验（findActualString / countMatches）
 * 认定的那次替换严格一致，整篇重排会让"锁内数到的才作数"失去意义。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileWriteProposal } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-csv-canon-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const WORK = join(ORU_DIR, 'work');
const CONV = 'conv-csv-canon';

let executeFileWriteProposal!: typeof import('../../electron/main/proposals/executeFileWriteProposal').executeFileWriteProposal;
let recordRead!: typeof import('../../electron/main/agent/conversationFileState').recordRead;

beforeAll(async () => {
  await fs.mkdir(WORK, { recursive: true });
  ({ executeFileWriteProposal } = await import('../../electron/main/proposals/executeFileWriteProposal'));
  ({ recordRead } = await import('../../electron/main/agent/conversationFileState'));
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

function proposal(over: Partial<FileWriteProposal> & Pick<FileWriteProposal, 'path' | 'mode'>): FileWriteProposal {
  return {
    kind: 'file.write',
    status: 'pending',
    id: `prop-${Math.random().toString(36).slice(2)}`,
    ownerId: 'owner-1',
    conversationId: CONV,
    title: 'write',
    description: 'write',
    createdAt: 0,
    forceApproval: false,
    ...over,
  };
}

async function readAndRecord(path: string, content: string): Promise<void> {
  await fs.writeFile(path, content);
  recordRead(CONV, path, { mtime: Math.floor(statSync(path).mtimeMs), content, isPartialView: false });
}

// 分号分隔（德/法语区 Excel 默认导出）。按逗号模型 parse 再 serialize 会把整行裹进一个字段，
// 是"文件被弄坏"的典型形态——执行器必须原样搬运。
const SEMICOLON = 'Name;Betrag;Notiz\nMüller;1.234,56;"Zahlung; Rest offen"\n';

describe('执行器只搬运，不改写内容', () => {
  it('整篇覆盖一张分号分隔的表 → 落盘与提案内容逐字节相同', async () => {
    const p = join(WORK, '分号.csv');
    await readAndRecord(p, '旧,内容\n1,2\n');
    await executeFileWriteProposal(proposal({ path: p, mode: 'overwrite', content: SEMICOLON }));
    expect(await fs.readFile(p, 'utf-8')).toBe(SEMICOLON);
  });

  it('新建时同样原样落盘（内容形态由工具层定死）', async () => {
    const p = join(WORK, '新建.csv');
    const content = 'a,b\n"多余引号",2\n';
    await executeFileWriteProposal(proposal({ path: p, mode: 'create', content }));
    expect(await fs.readFile(p, 'utf-8')).toBe(content);
  });
});

describe('AI 局部编辑不重排整篇', () => {
  it('插入的多余引号原样保留（落盘 = 锁内重验认定的那次替换）', async () => {
    const p = join(WORK, '追加.csv');
    await readAndRecord(p, '公司,岗位要求\n阿里,搜索\n');
    await executeFileWriteProposal(
      proposal({
        path: p,
        mode: 'edit',
        oldString: '阿里,搜索\n',
        newString: '阿里,搜索\n淘宝,"熟悉Agent设计范式；能定义指标体系"\n',
      }),
    );
    expect(await fs.readFile(p, 'utf-8')).toBe(
      '公司,岗位要求\n阿里,搜索\n淘宝,"熟悉Agent设计范式；能定义指标体系"\n',
    );
  });

  it('AI 插入不闭合引号时，未被编辑的行不受牵连', async () => {
    const p = join(WORK, '破损.csv');
    await readAndRecord(p, 'a,b\n1,2\n3,4\n');
    await executeFileWriteProposal(proposal({ path: p, mode: 'edit', oldString: '1,2', newString: '1,"2' }));
    // 整篇重排会把 3,4 吞进上一个字段并补尾引号——这里必须只有被编辑的那行变化
    expect(await fs.readFile(p, 'utf-8')).toBe('a,b\n1,"2\n3,4\n');
  });
});
