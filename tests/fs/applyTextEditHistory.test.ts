/**
 * applyTextEdit 覆盖前快照（块④「不丢失」——补缺陷② 右键改字不进历史）。
 *
 * 缺陷②真身（《文件保存系统》诊断）：右键改字直接 safeWriteAsync、不经 FileHistory，连续右键时
 * 「右键→右键」之间的中间版无处可寻、退不回去。本块给 applyTextEdit 落盘前补一道覆盖前快照
 * （与 commitWorkfileWrite 同口径），让每一版都进历史、可恢复，且靠 lastHash 单一真相源去重不重存。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-applytextedit-history-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const PROJECT = join(ORU_DIR, 'project');

let applyTextEdit!: typeof import('../../electron/main/fs/applyTextEdit').applyTextEdit;
let commitWorkfileWrite!: typeof import('../../electron/main/fs/workfileWrite').commitWorkfileWrite;
let FH!: typeof import('../../electron/main/fs/fileHistory');

beforeAll(async () => {
  await fs.mkdir(PROJECT, { recursive: true });
  ({ applyTextEdit } = await import('../../electron/main/fs/applyTextEdit'));
  ({ commitWorkfileWrite } = await import('../../electron/main/fs/workfileWrite'));
  FH = await import('../../electron/main/fs/fileHistory');
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

async function historyContents(fileKey: string): Promise<string[]> {
  const snaps = await FH.list(fileKey);
  return Promise.all(snaps.map((s) => FH.restore(fileKey, s.id)));
}

describe('applyTextEdit 覆盖前快照', () => {
  it('右键 → 右键（无 AI 介入）：第一版与中间版都进历史（缺陷②真身）', async () => {
    const p = join(PROJECT, 'page.html');
    await fs.writeFile(p, '<p>v0</p>', 'utf-8');

    const r1 = await applyTextEdit({ filePath: p, oldText: 'v0', newText: 'v1' });
    expect(r1).toEqual({ ok: true });
    const r2 = await applyTextEdit({ filePath: p, oldText: 'v1', newText: 'v2' });
    expect(r2).toEqual({ ok: true });

    expect(await fs.readFile(p, 'utf-8')).toBe('<p>v2</p>');
    const contents = await historyContents(p);
    expect(contents).toContain('<p>v0</p>'); // 第一版留底
    expect(contents).toContain('<p>v1</p>'); // 中间版留底——以前会丢
  });

  it('同一版不重存（lastHash 去重）', async () => {
    const p = join(PROJECT, 'dedup.html');
    await fs.writeFile(p, '<p>a0</p>', 'utf-8');
    await applyTextEdit({ filePath: p, oldText: 'a0', newText: 'a1' });
    await applyTextEdit({ filePath: p, oldText: 'a1', newText: 'a2' });
    const contents = await historyContents(p);
    // a0 只兜底一次，不因两次落盘重复存
    expect(contents.filter((c) => c === '<p>a0</p>')).toHaveLength(1);
  });

  it('CRLF 文件：与 commitWorkfileWrite 的 overwrite-guard 同口径，不重存近似版（M-1）', async () => {
    // applyTextEdit 字节级保真写 CRLF；其快照须 CRLF→LF 归一到与内核 readWithMetaAsync 同 hash 域，
    // 否则 applyTextEdit 存「\r\n 版」、commitWorkfileWrite 存「\n 版」→ 同一逻辑版本被存两份。
    const p = join(PROJECT, 'crlf.html');
    await fs.writeFile(p, '<p>c0</p>\r\n<span>x</span>', 'utf-8');
    await applyTextEdit({ filePath: p, oldText: 'c0', newText: 'c1' }); // 覆盖前兜 c0 版（归一存）
    // 内核覆盖同一文件：overwrite-guard 读 c1 版（归一），lastHash 应已是 applyTextEdit 存的同口径值
    await commitWorkfileWrite({ absPath: p, content: '<p>c2</p>\nKERNEL', mark: 'ai' });
    const contents = await historyContents(p);
    // c0 版（归一为 \n）只存一份；不因 raw/归一两套 hash 域而重复
    const c0lf = '<p>c0</p>\n<span>x</span>';
    expect(contents.filter((c) => c === c0lf)).toHaveLength(1);
  });

  it('快照 fileKey 与 commitWorkfileWrite 同口径（均 resolve）：非规范路径写法寻址同一历史', async () => {
    const canonical = join(PROJECT, 'norm.html');
    await fs.writeFile(canonical, '<p>n0</p>', 'utf-8');
    const viaDot = join(PROJECT, '.', 'norm.html'); // 未归一路径
    await applyTextEdit({ filePath: viaDot, oldText: 'n0', newText: 'n1' });
    // 用规范路径列历史应能看到 viaDot 写入前兜的 n0 版
    const contents = await historyContents(resolve(canonical));
    expect(contents).toContain('<p>n0</p>');
  });
});
