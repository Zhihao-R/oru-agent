/**
 * S02 · D2：SDK Read 的认知同步（PostToolUse → recordRead）。
 *
 * 守卫三的前提是「写之前读过」，读记录原来只来自自有 read_file——模型经 SDK Read 读文件后
 * 直接 edit_file 会撞 never-read。本组测试验 PostToolUse 同步的保守口径：
 * 失败方向永远是「多要求一次重读」（多记 partial），绝不把模型没整读的文件记成整读。
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emulateSdkReadView,
  makeSdkReadRecorder,
  SDK_READ_DEFAULT_LINE_LIMIT_0_1_77,
} from '../../electron/main/agent/sdkReadCognitionSync';
import { clearConvFileState, peekFileState } from '../../electron/main/agent/conversationFileState';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const tmp = mkdtempSync(join(tmpdir(), 'sdk-read-sync-'));
const usedConvIds: string[] = [];

function makeCtx(convId: string): ToolContext {
  usedConvIds.push(convId);
  return makeToolContext({ conversationId: convId, agentId: 'agent-1', ownerId: 'owner-1' });
}

afterEach(() => {
  for (const id of usedConvIds.splice(0)) clearConvFileState(id);
});

describe('emulateSdkReadView：SDK Read 返回切片的保守模拟', () => {
  it('小文件整读（无 offset/limit）→ 全文 + isPartialView=false', () => {
    const v = emulateSdkReadView('a\nb\nc');
    expect(v).toEqual({ content: 'a\nb\nc', isPartialView: false });
  });

  it('显式 offset/limit → 对应行切片 + partial', () => {
    const v = emulateSdkReadView('l1\nl2\nl3\nl4', 2, 2);
    expect(v.content).toBe('l2\nl3');
    expect(v.isPartialView).toBe(true);
    expect(v.offset).toBe(2);
    expect(v.limit).toBe(2);
  });

  it('超默认截断阈值的大文件（无 offset/limit）→ 只记前 N 行 + partial（SDK 静默截断，不能记成整读）', () => {
    const lines = Array.from({ length: SDK_READ_DEFAULT_LINE_LIMIT_0_1_77 + 5 }, (_, i) => `line-${i}`);
    const v = emulateSdkReadView(lines.join('\n'));
    expect(v.isPartialView).toBe(true);
    expect(v.content).toBe(lines.slice(0, SDK_READ_DEFAULT_LINE_LIMIT_0_1_77).join('\n'));
  });

  it('视野内有超长行（SDK 会截断行内容）→ partial（模型看到的与磁盘不完全一致）', () => {
    const v = emulateSdkReadView(`short\n${'x'.repeat(3000)}\ntail`);
    expect(v.isPartialView).toBe(true);
  });
});

describe('makeSdkReadRecorder：PostToolUse 落 recordRead', () => {
  it('Read 整读小文件 → fileState 记整读，后续守卫不再 never-read', async () => {
    const p = join(tmp, 'small.md');
    writeFileSync(p, 'hello\nworld\n');
    const recorder = makeSdkReadRecorder(makeCtx('conv-sync-1'));
    await recorder('Read', { file_path: p });

    const st = peekFileState('conv-sync-1', p);
    expect(st).toBeDefined();
    expect(st!.isPartialView).toBe(false);
    expect(st!.content).toBe('hello\nworld\n');
  });

  it('Read 带 offset/limit → 记部分读', async () => {
    const p = join(tmp, 'ranged.md');
    writeFileSync(p, 'l1\nl2\nl3\nl4\n');
    const recorder = makeSdkReadRecorder(makeCtx('conv-sync-2'));
    await recorder('Read', { file_path: p, offset: 2, limit: 2 });

    const st = peekFileState('conv-sync-2', p);
    expect(st!.isPartialView).toBe(true);
    expect(st!.content).toBe('l2\nl3');
  });

  it('CRLF 文件按 LF 归一记录——与 read_file / commitWorkfileWrite 同 hash 口径，G88 基线比对不因换行风格误报', async () => {
    const p = join(tmp, 'crlf.md');
    writeFileSync(p, 'a\r\nb\r\n');
    const recorder = makeSdkReadRecorder(makeCtx('conv-sync-3'));
    await recorder('Read', { file_path: p });

    expect(peekFileState('conv-sync-3', p)!.content).toBe('a\nb\n');
  });

  it('非 Read 工具 / 文件不存在 / 入参畸形 → 不记录、不抛错（钩子失败不能打断回合）', async () => {
    const recorder = makeSdkReadRecorder(makeCtx('conv-sync-4'));
    await recorder('Glob', { pattern: '*' });
    await recorder('Read', { file_path: join(tmp, 'nope.md') });
    await recorder('Read', { file_path: 42 });
    await recorder('Read', 'not-an-object');
    expect(peekFileState('conv-sync-4', join(tmp, 'nope.md'))).toBeUndefined();
  });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
