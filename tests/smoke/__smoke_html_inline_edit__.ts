/**
 * HTML 改字端到端 smoke —— applyTextEdit 内核 + WS fs.applyTextEdit 路径（Task 7）
 *
 * 钉的生死线「绝不改错」+ PRD 验收（外部静态 HTML：源无 data-edit-id，靠 oldText 子串唯一性定位）：
 * - (1) 唯一文本 → 写回成功、内容正确替换、源其余不变；**走 WS router 路径**断言成功只 ack、
 *       broadcasts 为空（承重：HTML 预览不刷新，绝不广播 fs.changed/indexChanged 触发整页 reload）
 * - (2) 同名重复文本 → reason 'ambiguous'（WS 侧 FS_TEXT_EDIT_DEGRADED）→ 回滚、文件一字未变
 * - (3) 源里不存在的文字（脚本动态生成、DOM≠源）→ reason 'not-found' → 回滚、文件未变
 * - (4) 并发改同一文件两处（两个合法的不同 oldText 同时发起）→ runExclusive 串行、都落、无丢更新
 * - (5) 文件被外部改过（写前改文件让 mtime 变 + 带过期 expectedMtimeMs）→ reason 'conflict' 拒绝、不覆盖外部改动
 *
 * 层级选择：(1) 走 WS router（broadcast 只在 WS 层才有，是承重断言的唯一观测点）；
 *           (2)(3)(4)(5) 直驱内核 applyTextEdit（并发/conflict 是内核独有行为，在内核层验最贴本质）。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyTextEdit } from '../../electron/main/fs/applyTextEdit';
import { route } from '../../electron/main/ws/router';
import type { ClientRequest, ServerEventPayload } from '../../shared/protocol';
import type { Reply, Broadcast } from '../../electron/main/ws/server';
import { ErrorCodes } from '../../shared/types';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

/** 当前文件 mtime（与内核同口径：Math.floor 毫秒） */
async function mtimeOf(filePath: string): Promise<number> {
  const s = await fs.stat(filePath);
  return Math.floor(s.mtimeMs);
}

/**
 * 走真实 WS router 跑一条请求，捕获它发出的 reply / broadcast。
 * router 的 reason→ErrorCode 分流与「成功不广播」都是真实路径，测试不复刻它的逻辑（否则手抄副本会漂移）。
 */
async function routeOnce(
  req: ClientRequest,
): Promise<{ replies: ServerEventPayload[]; broadcasts: ServerEventPayload[] }> {
  const replies: ServerEventPayload[] = [];
  const broadcasts: ServerEventPayload[] = [];
  const reply = ((_reqId: string, event: ServerEventPayload) => {
    replies.push(event);
  }) satisfies Reply;
  const broadcast = ((event: ServerEventPayload) => {
    broadcasts.push(event);
  }) satisfies Broadcast;
  await route(req, reply, broadcast);
  return { replies, broadcasts };
}

async function main() {
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'html-inline-edit-'));

  // ─── (1) 唯一文本 → 写回成功 + 无广播（走 WS router 路径）───
  {
    const filePath = join(tmpRoot, 'unique.html');
    await fs.writeFile(
      filePath,
      `<!doctype html><html><body>
<section class="slide"><h1>标题一</h1><p>这里有个错别字：苹果</p></section>
</body></html>`,
    );

    const { replies, broadcasts } = await routeOnce({
      type: 'fs.applyTextEdit',
      reqId: 'r1',
      filePath,
      markerId: null,
      oldText: '这里有个错别字：苹果',
      newText: '这里有个错别字：香蕉',
    });

    assert(replies.length === 1 && replies[0]?.type === 'ack', '(1) 成功只回单条 ack');
    assert(broadcasts.length === 0, '(1) broadcasts 为空（HTML 不刷新，绝不广播）');
    const after = await fs.readFile(filePath, 'utf-8');
    assert(after.includes('这里有个错别字：香蕉'), '(1) 新文本已落盘');
    assert(!after.includes('苹果'), '(1) 旧文本已被替换');
    assert(after.includes('<h1>标题一</h1>'), '(1) 源其余部分不变');
  }

  // ─── (2) 同名重复文本 → ambiguous → 回滚、文件一字未变（走 WS router 真验分流码）───
  {
    const filePath = join(tmpRoot, 'ambiguous.html');
    await fs.writeFile(
      filePath,
      `<!doctype html><html><body>
<section class="slide"><p>重复文本</p><p>重复文本</p></section>
</body></html>`,
    );
    const before = await fs.readFile(filePath, 'utf-8');

    // 走真实 router：ambiguous 必须分流为 FS_TEXT_EDIT_DEGRADED（前端据此回滚 + 提示改用 AI 改写）。
    // 不在测试里手抄 reason→code 映射——直接断言 router 实际吐出的 error 码，分流表改了这里会红。
    const { replies, broadcasts } = await routeOnce({
      type: 'fs.applyTextEdit',
      reqId: 'r2',
      filePath,
      markerId: null,
      oldText: '重复文本',
      newText: '改后文本',
    });
    const ev = replies[0];
    assert(
      replies.length === 1 && ev?.type === 'error' && ev.code === ErrorCodes.FS_TEXT_EDIT_DEGRADED,
      '(2) 重复文本 → WS 分流码 FS_TEXT_EDIT_DEGRADED',
    );
    assert(broadcasts.length === 0, '(2) 失败也不广播');
    const after = await fs.readFile(filePath, 'utf-8');
    assert(before === after, '(2) 拒绝时文件一字未变');
  }

  // ─── (3) 源里不存在的文字（脚本动态渲染，DOM≠源）→ not-found → 回滚、文件未变 ───
  {
    const filePath = join(tmpRoot, 'notfound.html');
    await fs.writeFile(
      filePath,
      `<!doctype html><html><body>
<section class="slide"><p>静态内容</p></section>
</body></html>`,
    );
    const before = await fs.readFile(filePath, 'utf-8');

    const r = await applyTextEdit({
      filePath,
      markerId: null,
      oldText: '运行时才渲染的文本', // 源里没有（模拟动态渲染 DOM≠源）
      newText: '改不动',
    });
    assert(r.ok === false && r.reason === 'not-found', '(3) 零命中 → reason not-found');
    const after = await fs.readFile(filePath, 'utf-8');
    assert(before === after, '(3) 拒绝时文件未变');
  }

  // ─── (4) 并发改同一文件两处 → runExclusive 串行、都落、无丢更新 ───
  {
    const filePath = join(tmpRoot, 'concurrent.html');
    await fs.writeFile(
      filePath,
      `<!doctype html><html><body>
<section class="slide"><h1>第一处原文</h1><p>第二处原文</p></section>
</body></html>`,
    );

    // 两个不同 oldText 的合法编辑同时发起（不 await 第一个就发第二个）——只有 runExclusive 串行才能都落
    const [a, b] = await Promise.all([
      applyTextEdit({ filePath, markerId: null, oldText: '第一处原文', newText: '第一处已改' }),
      applyTextEdit({ filePath, markerId: null, oldText: '第二处原文', newText: '第二处已改' }),
    ]);
    assert(a.ok === true && b.ok === true, '(4) 并发两处编辑都 ok');
    const after = await fs.readFile(filePath, 'utf-8');
    assert(after.includes('第一处已改'), '(4) 第一处修改落盘');
    assert(after.includes('第二处已改'), '(4) 第二处修改落盘（无后写覆盖前写）');
    assert(!after.includes('原文'), '(4) 两处原文均已被替换、无丢更新');
  }

  // ─── (5) 文件被外部改过（mtime 变 + 过期 expectedMtimeMs）→ conflict 拒绝、不覆盖 ───
  {
    const filePath = join(tmpRoot, 'conflict.html');
    await fs.writeFile(
      filePath,
      `<!doctype html><html><body>
<section class="slide"><p>初始内容</p></section>
</body></html>`,
    );
    const staleMtime = await mtimeOf(filePath);

    // 模拟外部进程改文件——确保 mtime 推进（部分 FS mtime 粒度粗，写后等到 mtime 真变）
    let externalContent = '';
    for (let i = 0; i < 50; i++) {
      externalContent = `<!doctype html><html><body>
<section class="slide"><p>外部已改的内容 ${i}</p></section>
</body></html>`;
      await fs.writeFile(filePath, externalContent);
      if ((await mtimeOf(filePath)) !== staleMtime) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    assert((await mtimeOf(filePath)) !== staleMtime, '(5) 前置：外部改动已推进 mtime');

    const r = await applyTextEdit({
      filePath,
      markerId: null,
      oldText: '初始内容', // 此时源里已无此串，但 conflict 应在定位前就拦下
      newText: '我的改动',
      expectedMtimeMs: staleMtime, // 过期基线
    });
    assert(r.ok === false && r.reason === 'conflict', '(5) 过期基线 → reason conflict');
    const after = await fs.readFile(filePath, 'utf-8');
    assert(after === externalContent, '(5) 不覆盖外部改动（外部内容原样保留）');
    assert(!after.includes('我的改动'), '(5) 我方改动未落盘');
  }

  // ─── 汇总 ───
  const failed = RESULTS.filter((x) => !x.ok);
  console.log('');
  console.log(`Total: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.error('Failures:');
    for (const f of failed) console.error(` - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke fatal error:', e);
  process.exit(1);
});
