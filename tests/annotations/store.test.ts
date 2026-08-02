/**
 * 标注存储脱 artifactId（项目B 第三期 Task10）。
 *
 * annotations.ts 增删改查 + crop 读写 + mutate 锁是单一出处，按 AnnotationLocation 落盘。
 * deck 适配器解析 artifactId→deckPath→deckAnnotationLocation；html 解析 htmlPath→htmlAnnotationLocation
 * （文件旁 sidecar）。核心动机：同目录两个松散 HTML 标注互不覆盖（旧实现按 deck 目录存一份会撞）。
 *
 * 直接用 location 核心 API + 路径解析器，不经 store 注册（location 不依赖 artifactId 注册表）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // 假 PNG 字节，crop 落盘验证用

async function mkTmp(name: string): Promise<string> {
  const dir = join(tmpdir(), `oru-test-annot-${name}-${process.hrtime.bigint()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('htmlAnnotationLocation：文件旁 sidecar', () => {
  it('解析出文件旁的 json / crops / 相对前缀 / resolve 锁 key', async () => {
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const loc = htmlAnnotationLocation('/dir/foo.html');
    expect(loc.jsonPath).toBe(join('/dir', '.foo.html.annotations.json'));
    expect(loc.cropRelPrefix).toBe('.foo.html.annotations/crops');
    expect(loc.lockKey).toBe(resolve('/dir/foo.html'));
  });
});

describe('location 核心：增删改查 + crop（html sidecar）', () => {
  it('add → 落 sidecar json + crop，cropPath 相对前缀正确', async () => {
    const dir = await mkTmp('add');
    cleanups.push(dir);
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { addAnnotationAt, readAnnotationsAt } = await import('../../electron/main/deck/annotations');
    const loc = htmlAnnotationLocation(join(dir, 'foo.html'));

    const a = await addAnnotationAt(loc, { comment: '改这块', htmlSnippet: '<p>x</p>', text: 'x', cropPng: PNG });
    expect(a.status).toBe('pending');
    expect(a.cropPath).toBe(`.foo.html.annotations/crops/${a.id}.png`);
    // crop 落在文件旁 sidecar 目录
    expect(await fs.readFile(join(dir, a.cropPath))).toEqual(PNG);
    // 读回一致
    const list = await readAnnotationsAt(loc);
    expect(list).toHaveLength(1);
    expect(list[0].comment).toBe('改这块');
  });

  it('html 不传 locator 也能 add（PRD：完全不存定位），读回为零 locator', async () => {
    const dir = await mkTmp('noloc');
    cleanups.push(dir);
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { addAnnotationAt, readAnnotationsAt } = await import('../../electron/main/deck/annotations');
    const loc = htmlAnnotationLocation(join(dir, 'foo.html'));

    await addAnnotationAt(loc, { comment: '随便', htmlSnippet: '', text: '' });
    const [a] = await readAnnotationsAt(loc);
    expect(a.locator.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(a.locator.pageIndex).toBeUndefined();
  });

  it('同目录两个松散 HTML 标注互不覆盖（脱 artifactId 的核心动机）', async () => {
    const dir = await mkTmp('collide');
    cleanups.push(dir);
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { addAnnotationAt, readAnnotationsAt } = await import('../../electron/main/deck/annotations');
    const fooLoc = htmlAnnotationLocation(join(dir, 'foo.html'));
    const barLoc = htmlAnnotationLocation(join(dir, 'bar.html'));

    await addAnnotationAt(fooLoc, { comment: 'foo 的标注', htmlSnippet: '', text: '' });
    await addAnnotationAt(barLoc, { comment: 'bar 的标注', htmlSnippet: '', text: '' });

    const fooList = await readAnnotationsAt(fooLoc);
    const barList = await readAnnotationsAt(barLoc);
    expect(fooList.map((a) => a.comment)).toEqual(['foo 的标注']);
    expect(barList.map((a) => a.comment)).toEqual(['bar 的标注']);
  });

  it('update 改 comment 重置 pending + 清 failureMessage', async () => {
    const dir = await mkTmp('update');
    cleanups.push(dir);
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { addAnnotationAt, updateAnnotationAt, readAnnotationsAt } = await import(
      '../../electron/main/deck/annotations'
    );
    const loc = htmlAnnotationLocation(join(dir, 'foo.html'));
    const a = await addAnnotationAt(loc, { comment: '原', htmlSnippet: '', text: '' });
    await updateAnnotationAt(loc, a.id, { status: 'failed', failureMessage: '炸了' });
    await updateAnnotationAt(loc, a.id, { comment: '改了' });
    const [got] = await readAnnotationsAt(loc);
    expect(got.status).toBe('pending');
    expect(got.failureMessage).toBeUndefined();
  });

  it('remove 删标注连带删 crop（幂等）', async () => {
    const dir = await mkTmp('remove');
    cleanups.push(dir);
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { addAnnotationAt, removeAnnotationAt, readAnnotationsAt } = await import(
      '../../electron/main/deck/annotations'
    );
    const loc = htmlAnnotationLocation(join(dir, 'foo.html'));
    const a = await addAnnotationAt(loc, { comment: 'x', htmlSnippet: '', text: '', cropPng: PNG });
    await removeAnnotationAt(loc, a.id);
    expect(await readAnnotationsAt(loc)).toHaveLength(0);
    await expect(fs.access(join(dir, a.cropPath))).rejects.toThrow();
    await removeAnnotationAt(loc, a.id); // 再删幂等不抛
  });

  it('clearPending 清 pending + crop，保留 submitted/failed', async () => {
    const dir = await mkTmp('clear');
    cleanups.push(dir);
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { addAnnotationAt, updateAnnotationAt, clearPendingAt, readAnnotationsAt } = await import(
      '../../electron/main/deck/annotations'
    );
    const loc = htmlAnnotationLocation(join(dir, 'foo.html'));
    const keep = await addAnnotationAt(loc, { comment: '留', htmlSnippet: '', text: '' });
    await updateAnnotationAt(loc, keep.id, { status: 'submitted', groupId: 'g1' });
    const drop = await addAnnotationAt(loc, { comment: '丢', htmlSnippet: '', text: '', cropPng: PNG });

    await clearPendingAt(loc);
    const list = await readAnnotationsAt(loc);
    expect(list.map((a) => a.id)).toEqual([keep.id]);
    await expect(fs.access(join(dir, drop.cropPath))).rejects.toThrow();
  });
});

describe('deckAnnotationLocation：deck 行为不变（路径形状）', () => {
  it('deck location 仍落 deckPath/.annotations.json + .annotations/crops（前缀不变）', async () => {
    const { deckAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { deckLockKey } = await import('../../electron/main/deck/pathResolver');
    const deckPath = '/proj/my-deck';
    const loc = deckAnnotationLocation(deckPath);
    expect(loc.jsonPath).toBe(join(deckPath, '.annotations.json'));
    expect(loc.cropRelPrefix).toBe('.annotations/crops');
    expect(loc.lockKey).toBe(deckLockKey(deckPath));
  });
});
