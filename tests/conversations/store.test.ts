/**
 * conversations/store.ts kind 白名单与 rekind 回归测试
 *
 * 直接对着数据丢失面写：loadIndex 的运行时白名单（KNOWN_KINDS）会静默丢弃未知 kind，
 * 且下一次 saveIndex 会把被丢弃的条目从 index.json 物理抹除——所以 aside 的存活
 * 必须验到磁盘字节层面（读 index.json 原文），不能只验内存返回值。
 *
 * ORU_DIR 范式：顶层先设 env，store 模块全部动态 import，
 * 避免 runtime/paths.ts 在 module load 时把 ORU_DIR 锁死（仿 tests/memory/store.test.ts）。
 * 不 mock 任何模块——store 的依赖（safeWrite 写队列 / 真实 fs）正是被测对象的一部分。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessage } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-conversations-store-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

// getCurrentOwnerId 真实实现恒返回 'local-user'（单用户模式），路径据此拼
const OWNER = 'local-user';

function indexPath(agentId: string): string {
  return join(ORU_DIR, 'users', OWNER, 'conversations', agentId, 'index.json');
}
function jsonlPath(agentId: string, convId: string): string {
  return join(ORU_DIR, 'users', OWNER, 'conversations', agentId, `${convId}.jsonl`);
}

function makeMessage(conversationId: string, text: string): ChatMessage {
  return {
    id: `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    conversationId,
    role: 'user',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  };
}

// 钩子放文件顶层：tmpdir 的建立与清理覆盖本文件全部 describe，不依赖隐式重建
beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('conversations/store - aside kind 白名单', () => {
  it('createConversation kind=aside 落盘后，经 loadIndex 重新读取仍存活', async () => {
    const { createConversation, getConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-aside-survive';
    const aside = await createConversation({ agentId, title: '随手评点', kind: 'aside' });
    expect(aside.kind).toBe('aside');

    // getConversation 每次都从磁盘 loadIndex——这是真实的落盘往返
    const round = await getConversation(agentId, aside.id);
    expect(round.kind).toBe('aside');
    expect(round.title).toBe('随手评点');
  });

  it('aside 存在时对另一对话 appendMessage，aside 仍在 index.json（KNOWN_KINDS 漏扩 → saveIndex 物理抹除的回归）', async () => {
    const { createConversation, getConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-aside-erasure';
    const aside = await createConversation({ agentId, title: 'aside 对话', kind: 'aside' });
    const sub = await createConversation({ agentId, title: '普通子对话', kind: 'sub' });

    // appendMessage 内部走 loadIndex → saveIndex 全量重写 index.json：
    // 若 KNOWN_KINDS 漏扩 aside，这一步就会把 aside 从磁盘上物理抹掉
    const { appendMessage } = await import('../../electron/main/conversations/store');
    await appendMessage(agentId, sub.id, makeMessage(sub.id, '触发 saveIndex'));

    // 验到磁盘字节层面，不依赖 loadIndex 自身的口径
    const raw = await fs.readFile(indexPath(agentId), 'utf-8');
    expect(raw).toContain(aside.id);
    expect(raw).toContain('"kind": "aside"');
    // loadIndex 口径也能读回
    const round = await getConversation(agentId, aside.id);
    expect(round.kind).toBe('aside');
  });

  it('listConversations 只返回 sub（不含 aside / taskboard-comment；主对话已取消无置顶项）', async () => {
    const { createConversation, createSubConversation, listConversations } =
      await import('../../electron/main/conversations/store');
    const agentId = 'agent-aside-list';
    const sub = await createSubConversation(agentId, '子对话');
    const aside = await createConversation({ agentId, title: 'aside 对话', kind: 'aside' });

    const list = await listConversations(agentId);
    const ids = new Set(list.map((c) => c.id));
    expect(ids.has(sub.id)).toBe(true);
    expect(list.every((c) => c.kind === 'sub')).toBe(true);
    expect(ids.has(aside.id)).toBe(false);
  });
});

describe('conversations/store - 主对话取消（存量 main 迁移）', () => {
  it('index.json 里的存量 main 经 loadIndex 迁成 sub，历史与元信息原地存活', async () => {
    const { listConversations, readHistory, appendMessage } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-legacy-main';
    const dir = join(ORU_DIR, 'users', OWNER, 'conversations', agentId);
    await fs.mkdir(dir, { recursive: true });
    // 手写一条存量主对话 + 它的历史消息（模拟老数据）
    const legacy = {
      id: `main_${agentId}`,
      ownerId: OWNER,
      agentId,
      kind: 'main',
      title: '主对话',
      sdkSessionId: null,
      createdAt: 1,
      updatedAt: 1,
    };
    await fs.writeFile(indexPath(agentId), JSON.stringify([legacy], null, 2), 'utf-8');
    await fs.writeFile(
      jsonlPath(agentId, legacy.id),
      JSON.stringify(makeMessage(legacy.id, '老主对话里的历史')) + '\n',
      'utf-8',
    );

    // 迁移：列表里出现、kind 已是 sub（不再是 main），历史读得回
    const list = await listConversations(agentId);
    expect(list.some((c) => c.id === legacy.id && c.kind === 'sub')).toBe(true);
    const history = await readHistory(agentId, legacy.id);
    expect(history.map((m) => m.text)).toContain('老主对话里的历史');

    // 触发一次 saveIndex（appendMessage），落盘后 index.json 里 kind 已固化为 sub、绝无 main
    await appendMessage(agentId, legacy.id, makeMessage(legacy.id, '迁移后续聊'));
    const raw = await fs.readFile(indexPath(agentId), 'utf-8');
    expect(raw).toContain('"kind": "sub"');
    expect(raw).not.toContain('"kind": "main"');
    // D5：saveIndex 把老裸数组(v1)固化为 versioned envelope(v2)
    expect(raw).toContain('"version": 2');
    expect(JSON.parse(raw).version).toBe(2);
  });

  // S06 · G129：迁移改写唯一一份身份数据前，旧格式先原样留底——迁移程序有 bug 时退路仍在
  it('v1 裸数组首次读时落迁移前原样副本（index.json.pre-v1.bak，字节级一致）', async () => {
    const { listConversations } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-premigration-bak';
    const dir = join(ORU_DIR, 'users', OWNER, 'conversations', agentId);
    await fs.mkdir(dir, { recursive: true });
    const v1Bytes = JSON.stringify(
      [{ id: 'cnv_bak', ownerId: OWNER, agentId, kind: 'sub', title: '老格式', sdkSessionId: null, createdAt: 1, updatedAt: 1 }],
      null,
      2,
    );
    await fs.writeFile(indexPath(agentId), v1Bytes, 'utf-8');
    await listConversations(agentId); // 触发读时迁移
    expect(await fs.readFile(`${indexPath(agentId)}.pre-v1.bak`, 'utf-8')).toBe(v1Bytes);
  });
});

/** 某目录下的损坏隔离 sidecar（`.corrupt-<ts>`）文件名列表 */
async function corruptSidecars(dir: string, base: string): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((n) => n.startsWith(`${base}.corrupt-`));
}

describe('conversations/store - 损坏隔离保留（§Deg）', () => {
  it('version 字段损坏（非整数）→ 隔离原文件保全字节、当空读，后续写盘落新文件不覆盖损坏字节', async () => {
    const { listConversations, createConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-corrupt-version';
    const dir = join(ORU_DIR, 'users', OWNER, 'conversations', agentId);
    await fs.mkdir(dir, { recursive: true });
    // 合法 JSON、但 version 是字符串（磁盘损坏 / 外部手改）——里头还有一条真实对话不能被静默抹掉
    const corrupt = JSON.stringify(
      { version: '2', conversations: [{ id: 'cnv_keep', agentId, kind: 'sub', title: '别丢我' }] },
      null,
      2,
    );
    await fs.writeFile(indexPath(agentId), corrupt, 'utf-8');

    // 隔离降级：优雅返回空列表（不抛、不拖垮读取路径），损坏文件已移出正常路径
    expect(await listConversations(agentId)).toEqual([]);
    const sidecars = await corruptSidecars(dir, 'index.json');
    expect(sidecars).toHaveLength(1);
    // sidecar 逐字节保留原损坏内容，可人工恢复 cnv_keep
    expect(await fs.readFile(join(dir, sidecars[0]), 'utf-8')).toBe(corrupt);

    // 关键：后续 RMW 写盘落的是全新 index.json（只含新对话），损坏字节安在 sidecar，不被物理覆盖
    const created = await createConversation({ agentId, title: '新对话', kind: 'sub' });
    const after = JSON.parse(await fs.readFile(indexPath(agentId), 'utf-8'));
    expect(after.version).toBe(2);
    expect(after.conversations.map((c: { id: string }) => c.id)).toEqual([created.id]);
    // sidecar 未被二次覆盖，原数据仍在
    expect(await fs.readFile(join(dir, sidecars[0]), 'utf-8')).toBe(corrupt);
  });

  it('JSON 半写坏（无法 parse）→ 同样隔离保全字节、当空读，不被下次写盘覆盖', async () => {
    const { listConversations, createConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-corrupt-json';
    const dir = join(ORU_DIR, 'users', OWNER, 'conversations', agentId);
    await fs.mkdir(dir, { recursive: true });
    const corrupt = '{"version":2,"conversations":[{"id":"cnv_x"'; // 半截，parse 必失败
    await fs.writeFile(indexPath(agentId), corrupt, 'utf-8');

    expect(await listConversations(agentId)).toEqual([]);
    const sidecars = await corruptSidecars(dir, 'index.json');
    expect(sidecars).toHaveLength(1);
    expect(await fs.readFile(join(dir, sidecars[0]), 'utf-8')).toBe(corrupt);

    await createConversation({ agentId, title: '重新开始', kind: 'sub' });
    expect(await fs.readFile(join(dir, sidecars[0]), 'utf-8')).toBe(corrupt); // 原字节仍在
  });

  it('未来版本（version 高于本程序）→ 如实拒绝（抛 FutureSchemaVersionError），绝不隔离/降级覆盖', async () => {
    const { listConversations, createConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const { FutureSchemaVersionError } = await import('../../electron/main/runtime/migrateOnRead');
    const agentId = 'agent-future-version';
    const dir = join(ORU_DIR, 'users', OWNER, 'conversations', agentId);
    await fs.mkdir(dir, { recursive: true });
    // 更新版程序写的 v999——老程序不认，必须原样保留、拒绝按老结构改写让版本号倒退
    const future = JSON.stringify(
      { version: 999, conversations: [{ id: 'cnv_future', agentId, kind: 'sub', title: '来自新版' }] },
      null,
      2,
    );
    await fs.writeFile(indexPath(agentId), future, 'utf-8');

    await expect(listConversations(agentId)).rejects.toThrow(FutureSchemaVersionError);
    // RMW 写盘路径同样先抛、绝不落盘降级
    await expect(
      createConversation({ agentId, title: '别覆盖新版', kind: 'sub' }),
    ).rejects.toThrow(FutureSchemaVersionError);
    // 未来版本文件逐字节未动（既没隔离改名、也没被覆盖）
    expect(await fs.readFile(indexPath(agentId), 'utf-8')).toBe(future);
  });
});

describe('conversations/store - jsonl 半截行处置（§Atomic / G132）', () => {
  it('末尾半截行 → 跳过损坏行、保留完好消息，处置留痕（不静默丢）', async () => {
    const { readHistory } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-torn-line';
    const convId = 'cnv_torn';
    const dir = join(ORU_DIR, 'users', OWNER, 'conversations', agentId);
    await fs.mkdir(dir, { recursive: true });
    // 两条完好消息 + 崩溃留下的半截追加行
    const good1 = makeMessage(convId, '第一条完好');
    const good2 = makeMessage(convId, '第二条完好');
    await fs.writeFile(
      jsonlPath(agentId, convId),
      `${JSON.stringify(good1)}\n${JSON.stringify(good2)}\n{"id":"msg_half","role":"user"`,
      'utf-8',
    );

    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warns.push(args.join(' '));
    });
    try {
      const history = await readHistory(agentId, convId);
      // 完好消息全保留，半截行不进结果（不丢完好、不塞损坏）
      expect(history.map((m) => m.text)).toEqual(['第一条完好', '第二条完好']);
    } finally {
      spy.mockRestore();
    }
    // 留痕：跳过损坏行有告知（不再纯静默）
    expect(warns.some((w) => w.includes('storage:corruption') && w.includes('跳过 1 条'))).toBe(true);
  });

  it('jsonl 读失败（读抖动/权限，非内容损坏）→ 降级返回空，不抛（不拖垮 searchConversations）', async () => {
    const { readHistory } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-read-jitter';
    const convId = 'cnv_jitter';
    // 用「同名目录」制造 readFile 失败（EISDIR）：existsSync 通过、readFile 抛，模拟读失败
    await fs.mkdir(jsonlPath(agentId, convId), { recursive: true });
    await expect(readHistory(agentId, convId)).resolves.toEqual([]);
  });
});

describe('conversations/store - searchConversations', () => {
  it('标题 + 消息正文一起搜，按对话聚合、含 aside、跳过非文本 kind', async () => {
    const { createSubConversation, createConversation, appendMessage, searchConversations } =
      await import('../../electron/main/conversations/store');
    const agentId = 'agent-search';
    const sub = await createSubConversation(agentId, 'Q2 增长复盘');
    await appendMessage(agentId, sub.id, makeMessage(sub.id, '这季增长主要来自复购'));
    // 非文本卡片消息（proposal）含关键词但应被跳过
    const card = makeMessage(sub.id, '增长 proposal 卡');
    (card as { kind?: string }).kind = 'proposal';
    await appendMessage(agentId, sub.id, card);
    // 随手评点也要搜得到
    const aside = await createConversation({ agentId, title: '随手评点', kind: 'aside' });
    await appendMessage(agentId, aside.id, makeMessage(aside.id, '这里也提了增长'));
    // 不相关对话
    const other = await createSubConversation(agentId, '投资再平衡');
    await appendMessage(agentId, other.id, makeMessage(other.id, '补低配那块'));

    const groups = await searchConversations(agentId, '增长');
    const byId = new Map(groups.map((g) => [g.conversation.id, g]));
    // sub：标题命中 + 1 条正文命中（proposal 卡跳过 → 不是 2 条）
    expect(byId.get(sub.id)?.titleHit).toBe(true);
    expect(byId.get(sub.id)?.messages.map((m) => m.text)).toEqual(['这季增长主要来自复购']);
    // aside 命中
    expect(byId.has(aside.id)).toBe(true);
    // 不相关对话不进结果
    expect(byId.has(other.id)).toBe(false);
  });

  it('空查询返回空数组（不全量返回）', async () => {
    const { searchConversations } = await import('../../electron/main/conversations/store');
    expect(await searchConversations('agent-search', '   ')).toEqual([]);
  });
});

describe('conversations/store - rekindConversation', () => {
  it('aside→sub 转正后 listConversations 可见，消息 JSONL 原地未动', async () => {
    const { createConversation, appendMessage, rekindConversation, listConversations } =
      await import('../../electron/main/conversations/store');
    const agentId = 'agent-rekind';
    const aside = await createConversation({ agentId, title: '待转正', kind: 'aside' });
    await appendMessage(agentId, aside.id, makeMessage(aside.id, 'aside 期间的消息'));
    const jsonlBefore = await fs.readFile(jsonlPath(agentId, aside.id), 'utf-8');

    const promoted = await rekindConversation(agentId, aside.id, 'sub');
    expect(promoted.id).toBe(aside.id);
    expect(promoted.kind).toBe('sub');

    // 转正后进主列表
    const list = await listConversations(agentId);
    expect(list.some((c) => c.id === aside.id && c.kind === 'sub')).toBe(true);

    // 消息文件逐字节未动
    const jsonlAfter = await fs.readFile(jsonlPath(agentId, aside.id), 'utf-8');
    expect(jsonlAfter).toBe(jsonlBefore);
  });

  it('不存在的 conversationId → CONVERSATION_NOT_FOUND', async () => {
    const { rekindConversation } = await import('../../electron/main/conversations/store');
    const { ErrorCodes } = await import('@shared/types');
    await expect(
      rekindConversation('agent-rekind', 'cnv_nonexistent', 'sub'),
    ).rejects.toMatchObject({ code: ErrorCodes.CONVERSATION_NOT_FOUND });
  });

  it('源是 taskboard-comment → throw（转 sub 后可删，task.commentConversationId 会悬空）', async () => {
    const { createConversation, rekindConversation, getConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const { ErrorCodes } = await import('@shared/types');
    const agentId = 'agent-rekind-comment';
    const comment = await createConversation({
      agentId,
      title: '任务评论',
      kind: 'taskboard-comment',
      boardTaskId: 'task_1',
    });
    await expect(rekindConversation(agentId, comment.id, 'sub')).rejects.toMatchObject({
      code: ErrorCodes.BOARD_COMMENT_CONV_PROTECTED,
    });
    const round = await getConversation(agentId, comment.id);
    expect(round.kind).toBe('taskboard-comment');
  });
});

describe('conversations/store - readHistoryForLLM 按 id 排除（G134）', () => {
  // 构造带具体 id 的消息，好在断言里核对视图成员
  function msg(conversationId: string, id: string, text: string, role: ChatMessage['role'] = 'user'): ChatMessage {
    return { id, conversationId, role, text, toolCalls: [], createdAt: Date.now(), done: true };
  }
  function marker(conversationId: string, id: string, compressedMessageIds: string[], summaryText = '早期对话摘要'): ChatMessage {
    return {
      id,
      conversationId,
      role: 'system',
      text: '对话较长，已自动压缩',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
      kind: 'context-compressed',
      contextCompressed: { compressedMessageIds, summaryText, fallback: false },
    };
  }

  it('压缩卡追加在 JSONL 末尾时，视野含保留段与后续、不含被摘要消息、marker 在首位', async () => {
    const { createSubConversation, appendMessage, readHistoryForLLM } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-g134-basic';
    const conv = await createSubConversation(agentId, 'G134 基础');
    const cid = conv.id;
    // 盘面时序（正是 G134 触发布局）：被压缩的 a/b → 保留段 c/d → 本轮 user e → 压缩卡 M 追加在末尾
    await appendMessage(agentId, cid, msg(cid, 'a', '被压缩的早期消息 A'));
    await appendMessage(agentId, cid, msg(cid, 'b', '被压缩的早期消息 B', 'assistant'));
    await appendMessage(agentId, cid, msg(cid, 'c', '保留段 C'));
    await appendMessage(agentId, cid, msg(cid, 'd', '保留段 D'));
    await appendMessage(agentId, cid, msg(cid, 'e', '本轮 user E'));
    await appendMessage(agentId, cid, marker(cid, 'M', ['a', 'b']));

    const view = await readHistoryForLLM(agentId, cid);
    // marker 在首位，其后是未被压缩的 c/d/e（保留段找回），a/b 被 id 排除
    expect(view.map((m) => m.id)).toEqual(['M', 'c', 'd', 'e']);
    expect(view[0].kind).toBe('context-compressed');
  });

  it('多次压缩（marker 链，含一张 fallback 空摘要卡）下并集排除正确、旧卡不漏入视图', async () => {
    const { createSubConversation, appendMessage, readHistoryForLLM } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-g134-chain';
    const conv = await createSubConversation(agentId, 'G134 链');
    const cid = conv.id;
    // 盘面：a b → 卡 M1([a,b]) → c d → fallback 卡 M2([c,d], summaryText='') → e f（保留段/后续）
    await appendMessage(agentId, cid, msg(cid, 'a', 'A'));
    await appendMessage(agentId, cid, msg(cid, 'b', 'B', 'assistant'));
    await appendMessage(agentId, cid, marker(cid, 'M1', ['a', 'b'], '摘要一'));
    await appendMessage(agentId, cid, msg(cid, 'c', 'C'));
    await appendMessage(agentId, cid, msg(cid, 'd', 'D', 'assistant'));
    await appendMessage(agentId, cid, marker(cid, 'M2', ['c', 'd'], '')); // fallback：summaryText 空
    await appendMessage(agentId, cid, msg(cid, 'e', 'E'));
    await appendMessage(agentId, cid, msg(cid, 'f', 'F', 'assistant'));

    const view = await readHistoryForLLM(agentId, cid);
    // 最后一张卡 M2 在首位；a/b/c/d 被并集排除；旧卡 M1 因 kind 被排除、不漏入中段；e/f 保留
    expect(view.map((m) => m.id)).toEqual(['M2', 'e', 'f']);
    expect(view.filter((m) => m.kind === 'context-compressed')).toHaveLength(1);
  });

  it('无压缩卡的对话，视图 = 全量原样', async () => {
    const { createSubConversation, appendMessage, readHistoryForLLM } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-g134-nomarker';
    const conv = await createSubConversation(agentId, 'G134 无卡');
    const cid = conv.id;
    await appendMessage(agentId, cid, msg(cid, 'a', 'A'));
    await appendMessage(agentId, cid, msg(cid, 'b', 'B', 'assistant'));
    await appendMessage(agentId, cid, msg(cid, 'c', 'C'));

    const view = await readHistoryForLLM(agentId, cid);
    expect(view.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

// ─── 计划清单随对话销毁 / 清空一并清掉 ────────────────────────────────
// clearConversation 的语义是「重置成空白可用对话」——不清清单的话，下一轮会把清空前的计划
// 贴回模型眼前（清单每轮注入）。deleteConversation 不清则是留孤儿文件。
describe('conversations/store - 计划清单的清理', () => {
  it('clearConversation 之后计划清单读到空（不再贴回清空前的计划）', async () => {
    const { createConversation, clearConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const { setTodos, getTodos, __resetTodoStoreForTest } = await import(
      '../../electron/main/agent/todoStore'
    );
    const agentId = 'agent-todo-clear';
    const conv = await createConversation({ agentId, title: '带清单的对话', kind: 'sub' });
    await setTodos(OWNER, agentId, conv.id, [{ content: '写草稿', status: 'in_progress' }]);

    await clearConversation(agentId, conv.id);

    __resetTodoStoreForTest(); // 连磁盘一起清掉了才算数
    expect(await getTodos(OWNER, agentId, conv.id)).toEqual([]);
  });

  it('deleteConversation 之后清单文件不留孤儿', async () => {
    const { createConversation, deleteConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const { setTodos, __resetTodoStoreForTest } = await import('../../electron/main/agent/todoStore');
    const { conversationTodoFile } = await import('../../electron/main/runtime/paths');
    const agentId = 'agent-todo-delete';
    const conv = await createConversation({ agentId, title: '待删对话', kind: 'sub' });
    await setTodos(OWNER, agentId, conv.id, [{ content: 'x', status: 'pending' }]);
    const file = conversationTodoFile(OWNER, agentId, conv.id);
    expect(existsSync(file)).toBe(true);

    await deleteConversation(agentId, conv.id);

    __resetTodoStoreForTest();
    expect(existsSync(file)).toBe(false);
  });
});

describe('conversations/store - patchMessage（字段收窄的展示态补丁）', () => {
  function mkMemoryCard(conversationId: string, id: string): ChatMessage {
    return {
      id,
      conversationId,
      role: 'system',
      text: '已记下 测试记忆',
      toolCalls: [],
      createdAt: 1000,
      done: true,
      kind: 'memory-record',
      memoryRecord: {
        relPath: 'agents/twin/episodes/2026-07-28-test.md',
        preview: '测试记忆',
        scope: 'agent',
        type: 'episode',
      },
    };
  }

  it('改一条存在的消息：重读已改，其他消息逐字未变（整写不损坏邻居）', async () => {
    const { createConversation, appendMessage, patchMessage } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-patch-basic';
    const conv = await createConversation({ agentId, title: 'patch', kind: 'sub' });
    const m1 = makeMessage(conv.id, '第一条');
    const card = mkMemoryCard(conv.id, 'msg_card_1');
    const m3 = makeMessage(conv.id, '第三条');
    await appendMessage(agentId, conv.id, m1);
    await appendMessage(agentId, conv.id, card);
    await appendMessage(agentId, conv.id, m3);

    const before = await fs.readFile(jsonlPath(agentId, conv.id), 'utf-8');
    const neighborsBefore = before.split('\n').filter((l) => l && !l.includes('msg_card_1'));

    const ok = await patchMessage(agentId, conv.id, 'msg_card_1', {
      memoryRecord: { ...card.memoryRecord!, undone: true },
    });
    expect(ok).toBe(true);

    const after = await fs.readFile(jsonlPath(agentId, conv.id), 'utf-8');
    const lines = after.split('\n').filter(Boolean);
    const patched = JSON.parse(lines.find((l) => l.includes('msg_card_1'))!) as ChatMessage;
    expect(patched.memoryRecord).toEqual({ ...card.memoryRecord, undone: true });
    expect(patched.text).toBe('已记下 测试记忆'); // 浅合并只动传入字段
    // 邻居逐字未变
    const neighborsAfter = lines.filter((l) => !l.includes('msg_card_1'));
    expect(neighborsAfter).toEqual(neighborsBefore);
  });

  it('消息不存在：返回 false，文件内容不变', async () => {
    const { createConversation, appendMessage, patchMessage } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-patch-miss';
    const conv = await createConversation({ agentId, title: 'patch-miss', kind: 'sub' });
    const card = mkMemoryCard(conv.id, 'msg_card_exists');
    await appendMessage(agentId, conv.id, card);
    const before = await fs.readFile(jsonlPath(agentId, conv.id), 'utf-8');

    const ok = await patchMessage(agentId, conv.id, 'msg_no_such', {
      memoryRecord: { ...card.memoryRecord!, undone: true },
    });
    expect(ok).toBe(false);
    expect(await fs.readFile(jsonlPath(agentId, conv.id), 'utf-8')).toBe(before);
  });

  it('并发 patch 同一会话的两条不同消息：两次改动都在（无锁实现会后写覆盖先写）', async () => {
    const { createConversation, appendMessage, patchMessage } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-patch-concurrent';
    const conv = await createConversation({ agentId, title: 'patch-race', kind: 'sub' });
    const cardA = mkMemoryCard(conv.id, 'msg_card_a');
    const cardB = mkMemoryCard(conv.id, 'msg_card_b');
    await appendMessage(agentId, conv.id, cardA);
    await appendMessage(agentId, conv.id, cardB);

    const [okA, okB] = await Promise.all([
      patchMessage(agentId, conv.id, 'msg_card_a', {
        memoryRecord: { ...cardA.memoryRecord!, undone: true },
      }),
      patchMessage(agentId, conv.id, 'msg_card_b', {
        memoryRecord: { ...cardB.memoryRecord!, undone: true },
      }),
    ]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);

    const raw = await fs.readFile(jsonlPath(agentId, conv.id), 'utf-8');
    const byId = new Map(
      raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ChatMessage).map((m) => [m.id, m]),
    );
    expect(byId.get('msg_card_a')?.memoryRecord?.undone).toBe(true);
    expect(byId.get('msg_card_b')?.memoryRecord?.undone).toBe(true);
  });
});
