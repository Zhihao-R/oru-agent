/**
 * 版本封套编解码器回归（S06 范式共享原语）——tasks/scheduledTasks/bg-commands 三个 store 共用。
 * 验：序列化带 version + 指定字段名；读时把裸旧格式迁到当前版本；未来版本 → null（不倒退）。
 */
import { afterAll, describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeVersionedCodec } from '../../electron/main/runtime/versionedRecord';

// 迁移会写 <path>.pre-v1.bak 副本，故用真实可写 tmp 路径（非 /x 只读根）。
const TMP = join(tmpdir(), `oru-test-vcodec-${Date.now()}`);
const P = join(TMP, 'rec.json');

type Rec = { id: string; n: number };

// 与 tasks/store 同款：v1 裸对象，chain 把裸对象包成 {version:2, task}
const codec = makeVersionedCodec<Rec>({
  baselineVersion: 1,
  chain: [(prev) => ({ version: 2, task: prev })],
  field: 'task',
  label: 'test',
});

describe('makeVersionedCodec', () => {
  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('currentVersion = baseline + chain 长度', () => {
    expect(codec.currentVersion).toBe(2);
  });

  it('serialize 带 version + 指定字段名', () => {
    const s = codec.serialize({ id: 'a', n: 1 });
    expect(JSON.parse(s)).toEqual({ version: 2, task: { id: 'a', n: 1 } });
  });

  it('读当前版本封套 → 取出记录', async () => {
    const raw = JSON.stringify({ version: 2, task: { id: 'a', n: 1 } });
    expect(await codec.read('/x', raw)).toEqual({ id: 'a', n: 1 });
  });

  it('读 v1 裸旧格式 → 迁移到当前版本取出', async () => {
    await fs.mkdir(TMP, { recursive: true });
    const raw = JSON.stringify({ id: 'a', n: 1 }); // 无 version = v1 裸对象
    expect(await codec.read(P, raw)).toEqual({ id: 'a', n: 1 });
  });

  it('未来版本 → null（不读不写、版本不倒退）', async () => {
    const raw = JSON.stringify({ version: 99, task: { id: 'a', n: 1 } });
    expect(await codec.read('/x', raw)).toBeNull();
  });
});
