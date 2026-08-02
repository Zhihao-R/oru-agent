/**
 * deck 版本指针薄包装（项目B 第三期 Task11）。
 *
 * deckVersionPointer 把 VersionPointer 接口落到 deck history.ts（commitVersion/checkoutVersion/
 * restoreVersionContent）上——行为零改，versionId 仍是 deck 的 vNNN（语义层保留）。提交流内核据此
 * 与 html 共用一条流。
 *
 * ORU_DIR 在 import 前重定向；业务模块动态 import（同 historyBytes.test.ts）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-deckptr-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const HTML_A = `<!doctype html><html><body><div class="slide"><h1>A</h1></div></body></html>`;
const HTML_B = `<!doctype html><html><body><div class="slide"><h1>B</h1></div></body></html>`;

let projectPath = '';
beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  projectPath = join(ORU_DIR, 'prj');
  await fs.mkdir(projectPath, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

async function makeDeck(name: string, html: string): Promise<string> {
  const deckDir = join(projectPath, name);
  await fs.mkdir(deckDir, { recursive: true });
  await fs.writeFile(join(deckDir, 'index.html'), html, 'utf-8');
  const { registerExistingDeck } = await import('../../electron/main/deck/store');
  const rec = await registerExistingDeck({ projectId: 'prj_p', name, path: deckDir });
  return rec.id;
}

describe('deckVersionPointer：包 history.ts，行为零改', () => {
  it('commit → vNNN versionId；restore 取该版字节', async () => {
    const { deckVersionPointer } = await import('../../electron/main/deck/deckPointer');
    const { ensureManifest } = await import('../../electron/main/deck/history');
    const id = await makeDeck('ptr-commit', HTML_A);
    await ensureManifest(id); // v001 = HTML_A

    const ptr = deckVersionPointer(id);
    const v = await ptr.commit('protective', '改前');
    expect(v.versionId).toMatch(/^v\d+$/); // deck 版本 id 保留 vNNN
    expect(await ptr.restore(v.versionId)).toBe(HTML_A);
  });

  it('checkout(id) 写回 index.html', async () => {
    const { deckVersionPointer } = await import('../../electron/main/deck/deckPointer');
    const { ensureManifest } = await import('../../electron/main/deck/history');
    const { resolveDeckPath } = await import('../../electron/main/deck/store');
    const { deckIndexPath } = await import('../../electron/main/deck/pathResolver');
    const id = await makeDeck('ptr-checkout', HTML_A);
    const m0 = await ensureManifest(id); // v001 = HTML_A
    const deckPath = await resolveDeckPath(id);
    const ptr = deckVersionPointer(id);

    await fs.writeFile(deckIndexPath(deckPath), HTML_B); // 模拟改成 HTML_B
    const after = await ptr.commit('ai', '改后');
    expect(await ptr.restore(after.versionId)).toBe(HTML_B);

    await ptr.checkout(m0.currentVersion); // 退回 v001
    expect(await fs.readFile(deckIndexPath(deckPath), 'utf-8')).toBe(HTML_A);
  });
});
