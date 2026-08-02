/**
 * deck 写盘走原子内核回归（n11 对策）——目标问题：deck 的注册表 / manifest / 版本 /
 * index.html 此前全是裸 fs.writeFile 原地覆盖，崩溃/断电可截断半个文件。
 * 修复后核心写路径必须经 safeWriteAsync（tmp+rename）。
 *
 * 模式同 memory/store.test.ts 的 safeWrite spy：注册收编 deck → commitVersion，
 * 断言注册表 / v00N.html / manifest / index.html（checkout）都打到 safeWriteAsync 上。
 * ORU_DIR 在业务 import 前重定向到 tmpdir；业务模块走动态 await import。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as safeWriteMod from '../../electron/main/fs/safeWrite';

const ORU_DIR = join(tmpdir(), `oru-test-deck-atomic-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const DECK_HTML = `<!doctype html><html><body>
<div class="slide"><h1>第一页</h1></div>
</body></html>`;

let projectPath = '';

describe('deck 原子写收口', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
    projectPath = join(ORU_DIR, 'prj');
    await fs.mkdir(projectPath, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('注册表 / 版本文件 / manifest / checkout 回写全部经 safeWriteAsync', async () => {
    const deckDir = join(projectPath, 'atomic-deck');
    await fs.mkdir(deckDir, { recursive: true });
    await fs.writeFile(join(deckDir, 'index.html'), DECK_HTML, 'utf-8');

    const { registerExistingDeck } = await import('../../electron/main/deck/store');
    const { commitVersion, checkoutVersion } = await import('../../electron/main/deck/history');

    const spy = vi.spyOn(safeWriteMod, 'safeWriteAsync');

    // 注册 → 写 artifacts.json
    const rec = await registerExistingDeck({ projectId: 'prj_a', name: 'atomic-deck', path: deckDir });
    const writtenAfterRegister = spy.mock.calls.map((c) => c[0]);
    expect(writtenAfterRegister.some((p) => p.endsWith('artifacts.json'))).toBe(true);

    // 首次 commit：懒初始化 v001（从当前 index.html 快照）+ 落 v002 + manifest
    await commitVersion(rec.id, 'manual', '收编首 commit');
    // 改页后再 commit → v003
    await fs.writeFile(join(deckDir, 'index.html'), DECK_HTML.replace('第一页', '改过的页'), 'utf-8');
    await commitVersion(rec.id, 'manual', '改页');
    const written = spy.mock.calls.map((c) => c[0]);
    // 项目B：版本字节进 fileHistory 中央仓 snapshots/<id>（替代 .history/versions/vNNN.html），
    // 仍经 safeWriteAsync（tmp+rename）。断言字节快照文件 + manifest 都打到原子内核上。
    expect(written.some((p) => p.includes(join('snapshots')))).toBe(true);
    expect(written.some((p) => p.endsWith('manifest.json'))).toBe(true);

    // checkout 旧版 → index.html 回写也走原子内核
    spy.mockClear();
    const r = await checkoutVersion(rec.id, 'v001');
    expect(r.ok).toBe(true);
    const checkoutWrites = spy.mock.calls.map((c) => c[0]);
    expect(checkoutWrites.some((p) => p.endsWith('index.html'))).toBe(true);

    // 落盘内容真实正确（不止打点）：v001 是收编时刻的原始快照
    expect(await fs.readFile(join(deckDir, 'index.html'), 'utf-8')).toBe(DECK_HTML);

    spy.mockRestore();
  });
});
