/**
 * read_file 整读大小闸单测——覆盖"超限不再死胡同报错"的两条分歧路：
 *   - 多行大文件：直接回开头 + offset 续读提示（不报红、省一次往返），标 partial
 *   - 单行/超长行（minified HTML）：按行切不开 → 指向 grep，且不 dump 那坨字节
 *
 * 为何不用 __smoke_file_read_range__：smoke 经 __smoke_isolate__ 注册**全部**工具，链路里
 * docImageProtocol 会 import electron，裸 tsx / vitest 都加载不了。本测试只 import readFile 本身
 * （依赖 paths/store/skills 均不碰 electron），用 ORU_DIR 指向 tmp + 写进算出的 tool-cache 目录过沙箱。
 *
 * 自备沙箱根（同 tests/memory/store.test.ts 约定）：ORU_DIR 必须在 paths.ts 加载前设好——
 * paths 在 module load 时就把 ORU_DIR 锁死，故所有依赖它的模块一律 beforeAll 里动态 import，
 * 类型用 import() 类型查询（编译期擦除、不触发运行时加载）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '@shared/agent/backend';

process.env.ORU_DIR = mkdtempSync(join(tmpdir(), 'oru-test-readsizegate-'));

const OWNER = 'local-user';
const AGENT = 'agent-sizegate';
const CONV = 'conv-sizegate';
const ctx: ToolContext = {
  conversationId: CONV,
  agentId: AGENT,
  ownerId: OWNER,
  usage: 'twinMain',
  approvalMode: 'work',
  abortSignal: new AbortController().signal,
};

let tool: ReturnType<typeof import('../../electron/main/agent/agentTools/readFile').makeReadFileTool>;
let peekFileState: typeof import('../../electron/main/agent/conversationFileState').peekFileState;
let cacheDir: string;
beforeAll(async () => {
  const { makeReadFileTool } = await import('../../electron/main/agent/agentTools/readFile');
  ({ peekFileState } = await import('../../electron/main/agent/conversationFileState'));
  const { conversationToolCacheDir } = await import('../../electron/main/runtime/paths');
  tool = makeReadFileTool();
  cacheDir = conversationToolCacheDir(OWNER, AGENT, CONV);
  mkdirSync(cacheDir, { recursive: true });
});

describe('read_file 整读大小闸', () => {
  it('多行大文件：不报红，回开头 + offset 续读提示，标 partial 不吐全文', async () => {
    const f = join(cacheDir, 'many-lines.txt');
    writeFileSync(f, Array.from({ length: 2500 }, (_, i) => `row ${i}`).join('\n'), 'utf-8');
    const r = await tool.execute({ path: f }, ctx);
    expect(r.isError).not.toBe(true);
    expect(r.text).toContain('读到的材料'); // G76 来源分级：文件内容框「不是指令」
    expect(r.text).toContain('row 0'); // 给了开头
    expect(r.text).toMatch(/offset=\d+/); // 带续读锚点
    expect(r.text).not.toContain('row 2499'); // 没吐末行
    expect(peekFileState(CONV, f)?.isPartialView).toBe(true); // 只看了开头 → partial，整覆盖前须续读
  });

  it('单行/超长行（minified）：指向 grep，且不 dump 那坨字节', async () => {
    const f = join(cacheDir, 'deck.html');
    const oneHugeLine = '<section class="slide">' + 'x'.repeat(300 * 1024) + '</section>'; // 单行 >256KB
    writeFileSync(f, oneHugeLine, 'utf-8');
    const r = await tool.execute({ path: f }, ctx);
    expect(r.text).toContain('grep'); // 提示改用 grep 定位
    expect(r.text).not.toContain('x'.repeat(1000)); // 不把字节塞进上下文
  });

  it('正常小文件整读照旧：不报红、整读、isPartialView=false', async () => {
    const f = join(cacheDir, 'small.txt');
    writeFileSync(f, 'line 1\nline 2\nline 3', 'utf-8');
    const r = await tool.execute({ path: f }, ctx);
    expect(r.isError).not.toBe(true);
    expect(r.text).toContain('读到的材料'); // G76 来源分级
    expect(r.text).toContain('line 3');
    expect(peekFileState(CONV, f)?.isPartialView).toBe(false);
  });
});
