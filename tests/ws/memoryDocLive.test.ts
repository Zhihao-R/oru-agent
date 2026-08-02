/**
 * memory.doc.readLive / memory.doc.writeLive —— live 读写 WS 通道承重测试（Task 1）
 *
 * 四条承重点：
 *   1. readLive 回 body-only、writeLive 落盘并广播 memory.doc.changed
 *   2. 并发不同段合并（merged，不丢字节）
 *   3. frontmatter last-updated 漂移不误判 discarded（mine/baseline 共享同一份 data）
 *   4. 撞同段 discarded 且用户内容可 rebaseline（返回磁盘现状 body）
 *
 * 使用真实 I/O（ORU_DIR 隔离到 tmpdir），仅 mock getCurrentOwnerId 与不相关的周边依赖。
 * 走真 route() 以验协议注册表分发到 handler 的完整链路。
 *
 * ORU_DIR 陷阱：vi.mock 被 vitest hoisted 到文件顶部，在 process.env.ORU_DIR 赋值之前运行，
 * 导致 paths.ts 模块级求值时读到 undefined，进而写真实 ~/.oru。
 * 解决：用 vi.hoisted 在 hoist 阶段注入 process.env.ORU_DIR，保证所有 mock factory 拿到的是测试路径。
 */
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import type { Broadcast, Reply } from '../../electron/main/ws/server';
import type { ServerEventPayload } from '@shared/protocol';

// ─── vi.hoisted：在 hoist 阶段设好 ORU_DIR，所有后续 mock factory 才能拿到正确路径 ────
const { ORU_DIR } = vi.hoisted(() => {
  const path = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const ORU_DIR = path.join(os.tmpdir(), `oru-test-memlivews-${Date.now()}`);
  process.env.ORU_DIR = ORU_DIR;
  return { ORU_DIR };
});

// ─── mock getCurrentOwnerId 返回固定值 ──────────────────────────────────────
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'owner-live',
}));

// ─── 下面这些是 router 注册表里其他 handler 的依赖，不影响被测 handler，mock 防止启动时报错 ───
vi.mock('../../electron/main/memory/trash', () => ({ moveToTrash: vi.fn() }));
vi.mock('../../electron/main/memory/changelog', () => ({ changelogPath: () => '/tmp/cl.md' }));
vi.mock('../../electron/main/memory/dreamScheduler', () => ({ runOnce: vi.fn() }));
vi.mock('../../electron/main/memory/store', () => ({
  readAgentSelf: vi.fn(),
  readEpisode: vi.fn(),
  listAllEpisodesWithSuperseded: vi.fn(),
  readPredecessor: vi.fn(),
}));
vi.mock('../../electron/main/memory/applyOps', () => ({ applyOps: vi.fn() }));
vi.mock('../../electron/main/memory/projectProfile', () => ({ readProjectProfile: vi.fn() }));
vi.mock('../../electron/main/memory/projectList', () => ({
  readAllProjectListEntriesForUI: vi.fn(),
}));
vi.mock('@shared/memory/profileDoc', () => ({
  parseProfileDoc: vi.fn(() => ({ impression: '', sections: [] })),
  renderProfileDoc: vi.fn((d: unknown) => String(d ?? '')),
}));

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

afterEach(() => vi.clearAllMocks());

/** 最小 harness：收 reply/broadcast，记顺序 timeline */
function harness() {
  const replies: ServerEventPayload[] = [];
  const broadcasts: ServerEventPayload[] = [];
  const timeline: Array<{ kind: 'reply' | 'broadcast'; ev: ServerEventPayload }> = [];
  const reply: Reply = (_reqId, ev) => {
    replies.push(ev);
    timeline.push({ kind: 'reply', ev });
  };
  const broadcast: Broadcast = (ev) => {
    broadcasts.push(ev);
    timeline.push({ kind: 'broadcast', ev });
  };
  return { reply, broadcast, replies, broadcasts, timeline };
}

// ─── 承重点 1：readLive 回 body-only、writeLive 落盘并广播 ──────────────────
describe('承重点 1 · readLive 回 body-only、writeLive 落盘并广播', () => {
  it('writeLive → reply written + 广播 memory.doc.changed；readLive → content 不含 last-updated', { timeout: 15000 }, async () => {
    // 懒 import（确保 ORU_DIR 已设）
    const { route } = await import('../../electron/main/ws/router');

    // 路径必须匹配 isProfileDocRelPath（endsWith /profile.md 或 /self.md）才走档案分支（含合并逻辑）
    const relPath = `projects/test-${Date.now()}/profile.md`;
    const body = '# 关于你\n正文';
    const h = harness();

    // 写
    await route(
      { type: 'memory.doc.writeLive', reqId: 'w1', relPath, content: body, mark: 'manual' },
      h.reply,
      h.broadcast,
    );

    // reply 回 written
    expect(h.replies[0]).toMatchObject({
      type: 'memory.doc.live',
      relPath,
      status: 'written',
    });
    // 广播 memory.doc.changed
    expect(h.broadcasts).toContainEqual({ type: 'memory.doc.changed', relPath });
    // 时序：先 reply 本次请求结果，再 broadcast 旁路通知（与 memory.doc.write 等同仓范式对齐）
    expect(h.timeline[0].kind).toBe('reply');
    expect(h.timeline[1].kind).toBe('broadcast');

    // 读回 body-only，不含 frontmatter key
    const h2 = harness();
    await route(
      { type: 'memory.doc.readLive', reqId: 'r1', relPath },
      h2.reply,
      h2.broadcast,
    );
    // readLive 是纯读、status 对读无意义（仅复用事件类型），只断 content——不把噪声语义固化成契约
    expect(h2.replies[0]).toMatchObject({ type: 'memory.doc.live', relPath });
    const readContent: string = (h2.replies[0] as { content: string }).content;
    expect(readContent).not.toMatch(/last-updated/);
    expect(readContent).toContain('# 关于你');
    // 读不广播
    expect(h2.broadcasts).toEqual([]);
  });
});

// ─── 承重点 2：并发不同段合并（merged，不丢字节）───────────────────────────
describe('承重点 2 · 并发不同段合并（merged，不丢字节）', () => {
  it('两侧在不同段写 → 至少一次 merged，磁盘 body 同时含两段', { timeout: 15000 }, async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { parseFrontmatter } = await import('../../electron/main/fs/frontmatter');
    const path = await import('node:path');

    // 路径匹配 isProfileDocRelPath 以走档案分支（含 mergeOnStale 逻辑）
    const relPath = `projects/merge-${Date.now()}/profile.md`;
    // 先写基线
    const baseline = '# 基础\n\n基础内容\n';
    const h0 = harness();
    await route(
      { type: 'memory.doc.writeLive', reqId: 'w0', relPath, content: baseline },
      h0.reply,
      h0.broadcast,
    );
    expect(h0.replies[0]).toMatchObject({ status: 'written' });

    // 两次 writeLive 使用同一 baseline，各自改不同段（头部 vs 尾部）
    const contentA = '# 头部新段\n\n头部内容\n\n# 基础\n\n基础内容\n';
    const contentB = '# 基础\n\n基础内容\n\n# 尾部新段\n\n尾部内容\n';

    const hA = harness();
    await route(
      {
        type: 'memory.doc.writeLive',
        reqId: 'wA',
        relPath,
        content: contentA,
        baseline,
        mergeOnStale: true,
      },
      hA.reply,
      hA.broadcast,
    );

    const hB = harness();
    await route(
      {
        type: 'memory.doc.writeLive',
        reqId: 'wB',
        relPath,
        content: contentB,
        baseline,
        mergeOnStale: true,
      },
      hB.reply,
      hB.broadcast,
    );

    // 至少一次应为 merged（第二次写时基线已过期）
    const statusA = (hA.replies[0] as { status: string }).status;
    const statusB = (hB.replies[0] as { status: string }).status;
    const statuses = [statusA, statusB];
    expect(statuses).toContain('merged');

    // 磁盘最终版本 body 同时含两段
    const abs = path.join(memoryRoot('owner-live'), relPath);
    const diskRaw = await fs.readFile(abs, 'utf-8');
    const diskBody = parseFrontmatter(diskRaw).content;
    expect(diskBody).toContain('头部新段');
    expect(diskBody).toContain('尾部新段');
  });
});

// ─── 承重点 3：frontmatter last-updated 漂移不误判 discarded ────────────────
describe('承重点 3 · frontmatter last-updated 漂移不误判 discarded', () => {
  it('磁盘 last-updated 被改但 body 未变 → mergeOnStale 不得返回 discarded', { timeout: 15000 }, async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const path = await import('node:path');

    // 路径匹配 isProfileDocRelPath
    const relPath = `projects/drift-${Date.now()}/profile.md`;
    const baseline = '# 基础\n\n基础内容\n';

    // 写基线
    const h0 = harness();
    await route(
      { type: 'memory.doc.writeLive', reqId: 'w0', relPath, content: baseline },
      h0.reply,
      h0.broadcast,
    );
    expect(h0.replies[0]).toMatchObject({ status: 'written' });

    // 手动修改磁盘文件的 last-updated（模拟 frontmatter 漂移，body 不变）
    const abs = path.join(memoryRoot('owner-live'), relPath);
    const diskRaw = await fs.readFile(abs, 'utf-8');
    const tampered = diskRaw.replace(/last-updated: \S+/, "last-updated: '1999-01-01'");
    await fs.writeFile(abs, tampered, 'utf-8');

    // 用原始 baseline body 写，mergeOnStale:true → 不得 discarded（frontmatter 漂移不该冲突）
    const mine = '# 基础\n\n基础内容已更新\n';
    const h1 = harness();
    await route(
      {
        type: 'memory.doc.writeLive',
        reqId: 'w1',
        relPath,
        content: mine,
        baseline,
        mergeOnStale: true,
      },
      h1.reply,
      h1.broadcast,
    );

    const status = (h1.replies[0] as { status: string }).status;
    // frontmatter 漂移经 base==mine 不变量应无冲突合并——显式锁死为 written/merged，不留 discarded 余地
    expect(['written', 'merged']).toContain(status);
  });
});

// ─── 承重点 4：撞同段 discarded 且用户内容可 rebaseline ─────────────────────
describe('承重点 4 · 撞同段 discarded，返回磁盘 theirs 版供 rebaseline', () => {
  it('baseline=X，磁盘已被改同段 → discarded，返回磁盘现状 body', { timeout: 15000 }, async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { parseFrontmatter, stringifyFrontmatter } = await import(
      '../../electron/main/fs/frontmatter'
    );
    const path = await import('node:path');

    // 路径匹配 isProfileDocRelPath
    const relPath = `projects/conflict-${Date.now()}/profile.md`;
    const baseline = '# 节\n\n原始内容\n';

    // 写基线
    const h0 = harness();
    await route(
      { type: 'memory.doc.writeLive', reqId: 'w0', relPath, content: baseline },
      h0.reply,
      h0.broadcast,
    );
    expect(h0.replies[0]).toMatchObject({ status: 'written' });

    // 手动把磁盘改成「theirs」——同一节改了内容（撞同段）
    const abs = path.join(memoryRoot('owner-live'), relPath);
    const diskRaw = await fs.readFile(abs, 'utf-8');
    const { data } = parseFrontmatter(diskRaw);
    const theirsBody = '# 节\n\ntheirs 改了这里\n';
    await fs.writeFile(abs, stringifyFrontmatter(data, theirsBody), 'utf-8');

    // mine 也在同一节改（同段冲突）
    const mine = '# 节\n\nmine 改了这里\n';
    const h1 = harness();
    await route(
      {
        type: 'memory.doc.writeLive',
        reqId: 'w1',
        relPath,
        content: mine,
        baseline,
        mergeOnStale: true,
      },
      h1.reply,
      h1.broadcast,
    );

    // 应为 discarded
    expect(h1.replies[0]).toMatchObject({ type: 'memory.doc.live', relPath, status: 'discarded' });
    // 返回 content 应是磁盘 theirs 版 body
    const returnedContent: string = (h1.replies[0] as { content: string }).content;
    expect(returnedContent).toContain('theirs 改了这里');
    expect(returnedContent).not.toContain('mine 改了这里');
  });
});

// ─── 承重点 5：CRLF baseline 换行归一，不误判 discarded ─────────────────────
describe('承重点 5 · CRLF baseline 不误判 discarded（读写口径归一）', () => {
  it('baseline body 用 CRLF、磁盘为 LF、body 实质未变 → mergeOnStale 不得 discarded', { timeout: 15000 }, async () => {
    const { route } = await import('../../electron/main/ws/router');

    const relPath = `projects/crlf-${Date.now()}/profile.md`;
    // 磁盘基线用 LF 落盘
    const baselineLf = '# 基础\n\n基础内容\n';
    const h0 = harness();
    await route(
      { type: 'memory.doc.writeLive', reqId: 'w0', relPath, content: baselineLf },
      h0.reply,
      h0.broadcast,
    );
    expect(h0.replies[0]).toMatchObject({ status: 'written' });

    // 渲染端来源含 CRLF（Windows）：baseline 与 content 同一份 body、仅换行风格不同
    // 未归一时 baseFull 与锁内归一后的 cur 逐字节对不上 → baseline-mismatch → 误 discarded
    const baselineCrlf = '# 基础\r\n\r\n基础内容\r\n';
    const mineCrlf = '# 基础\r\n\r\n基础内容改了\r\n';
    const h1 = harness();
    await route(
      {
        type: 'memory.doc.writeLive',
        reqId: 'w1',
        relPath,
        content: mineCrlf,
        baseline: baselineCrlf,
        mergeOnStale: true,
      },
      h1.reply,
      h1.broadcast,
    );

    const status = (h1.replies[0] as { status: string }).status;
    expect(['written', 'merged']).toContain(status);
  });
});
