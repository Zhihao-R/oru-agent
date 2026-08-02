/**
 * fs.applyTextEdit —— router 本体集成版（写回不触发预览 reload 的防线架在 router）。
 *
 * 经真 route({type:'fs.applyTextEdit'}) 驱动内核 + 错误分流，断言：
 *   - oldText 唯一 → reply ack 且**零广播**（绝不发 fs.changed/indexChanged，否则会把用户正在编辑的预览态 reload 掉）
 *   - oldText 全文找不到 → FS_TEXT_EDIT_DEGRADED（独立内核 reason=not-found，DOM 规范化后最常见）
 *   - oldText 多处歧义 → FS_TEXT_EDIT_DEGRADED
 *   - expectedMtimeMs 基线失配 → FS_TEXT_EDIT_CONFLICT
 *
 * 内核定位/锁/转义在 tests/fs/applyTextEdit.test.ts 单测；本文件只验 router case 的回包形态与"不广播"约束。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { route } from '../../electron/main/ws/router';
import type { Broadcast, Reply } from '../../electron/main/ws/server';
import { ErrorCodes } from '@shared/types';
import type { ServerEventPayload } from '@shared/protocol';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oru-fs-applytextedit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// 收集 reply 回包 + broadcast 广播；route 直驱，绝不 mock 内核。
// reply/broadcast 用 server.ts 导出的真实接口类型标注——接口加字段时这里会编译失败而非假绿。
function harness() {
  const replies: ServerEventPayload[] = [];
  const broadcasts: ServerEventPayload[] = [];
  const reply: Reply = (_reqId, ev) => void replies.push(ev);
  const broadcast: Broadcast = (ev) => void broadcasts.push(ev);
  return { reply, broadcast, replies, broadcasts };
}

describe('route(fs.applyTextEdit)', () => {
  it('oldText 唯一：reply ack 且零广播（不触发 fs.changed/indexChanged → 预览不 reload）', async () => {
    const filePath = join(dir, 'page.html');
    await writeFile(filePath, '<p>hello world</p>', 'utf-8');
    const h = harness();

    await route(
      { type: 'fs.applyTextEdit', reqId: 'r1', filePath, oldText: 'hello world', newText: 'goodbye' },
      h.reply,
      h.broadcast,
    );

    expect(h.replies).toEqual([{ type: 'ack' }]);
    // 主动验"无任何广播"——这是本 case 的承重约束（写回不许 reload 预览）
    expect(h.broadcasts).toEqual([]);
    expect(await readFile(filePath, 'utf-8')).toBe('<p>goodbye</p>');
  });

  it('oldText 全文找不到：FS_TEXT_EDIT_DEGRADED（不写盘、零广播）', async () => {
    // not-found 是独立内核 reason，且 DOM 规范化后对不上比歧义更常见——必须单独验它也走降级
    const filePath = join(dir, 'page.html');
    await writeFile(filePath, '<p>hello world</p>', 'utf-8');
    const h = harness();

    await route(
      { type: 'fs.applyTextEdit', reqId: 'r2', filePath, oldText: 'nonexistent text', newText: 'x' },
      h.reply,
      h.broadcast,
    );

    expect(h.replies[0]).toMatchObject({ type: 'error', code: ErrorCodes.FS_TEXT_EDIT_DEGRADED });
    expect(h.broadcasts).toEqual([]);
    expect(await readFile(filePath, 'utf-8')).toBe('<p>hello world</p>');
  });

  it('oldText 多处歧义：FS_TEXT_EDIT_DEGRADED（不写盘、零广播）', async () => {
    const filePath = join(dir, 'page.html');
    await writeFile(filePath, '<p>dup</p><p>dup</p>', 'utf-8');
    const h = harness();

    await route(
      { type: 'fs.applyTextEdit', reqId: 'r3', filePath, oldText: 'dup', newText: 'x' },
      h.reply,
      h.broadcast,
    );

    expect(h.replies[0]).toMatchObject({ type: 'error', code: ErrorCodes.FS_TEXT_EDIT_DEGRADED });
    expect(h.broadcasts).toEqual([]);
    expect(await readFile(filePath, 'utf-8')).toBe('<p>dup</p><p>dup</p>');
  });

  it('expectedMtimeMs 基线失配：FS_TEXT_EDIT_CONFLICT（不写盘）', async () => {
    const filePath = join(dir, 'page.html');
    await writeFile(filePath, '<p>hello</p>', 'utf-8');
    const realMtime = Math.floor((await stat(filePath)).mtimeMs);
    const h = harness();

    await route(
      {
        type: 'fs.applyTextEdit',
        reqId: 'r4',
        filePath,
        oldText: 'hello',
        newText: 'x',
        expectedMtimeMs: realMtime + 100000, // 故意错配 → 内核判 conflict
      },
      h.reply,
      h.broadcast,
    );

    expect(h.replies[0]).toMatchObject({ type: 'error', code: ErrorCodes.FS_TEXT_EDIT_CONFLICT });
    expect(h.broadcasts).toEqual([]);
    expect(await readFile(filePath, 'utf-8')).toBe('<p>hello</p>');
  });
});
