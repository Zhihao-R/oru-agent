/**
 * __smoke_twinmain_has_eyes__ —— 眼睛迁声明式能力 + 焦点 deck 锚定（任务 9 决策 3，§8）
 *
 * 钉两件事：
 * 1. deckReviewCapability 让 view_slide / render_contact_sheet 对 twinMain + subagentCoder 都可见
 *    （twinSubagent 透明继承 twinMain 自动可见）；不在 audience 的 memoryDream 看不到。删了 SUB_AGENT
 *    直接注册后无双注册（registry 以 name 为 key，count 不翻倍）。
 * 2. resolveFocusDeckPath：本会话最近活跃提交组的 deck；两份都活跃 → 锚到**最近创建**的；
 *    已完成的组排除；无活跃组 → undefined（工具据此 isError）。
 *
 * 不打 Claude。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AgentBackend, AgentTool } from '@shared/agent/backend';
import type { LlmUsage } from '@shared/types';
import {
  __clearToolRegistryForTest,
  getBackendFor,
} from '../../electron/main/agent/backends';
import { registerBuiltinCapabilities } from '../../electron/main/agent/capabilities';
import { createDeck } from '../../electron/main/deck/store';
import { initManifest } from '../../electron/main/deck/history';
import { addAnnotation } from '../../electron/main/deck/annotations';
import {
  submitAnnotations,
  finalizeSubmission,
  resolveFocusDeckPath,
  __resetForTest as resetSubmissions,
} from '../../electron/main/deck/submissions';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function backendToolNames(backend: AgentBackend): string[] {
  const tools = (backend as unknown as { tools: Map<string, AgentTool> }).tools;
  return Array.from(tools.keys());
}

const EYES = ['view_slide', 'render_contact_sheet'];
function hasEyes(backend: AgentBackend): boolean {
  const names = backendToolNames(backend);
  return EYES.every((n) => names.includes(n));
}

const HTML = `<!doctype html><html><body><section class="slide"><h1>A</h1></section></body></html>`;
const region = (comment: string) => ({
  comment,
  htmlSnippet: '',
  text: '',
  locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex: 0 },
});

async function main() {
  // ─── part 1: 能力供给覆盖受众 ───
  __clearToolRegistryForTest();
  registerBuiltinCapabilities();

  const usages: Array<{ usage: LlmUsage; shouldHave: boolean }> = [
    { usage: 'twinMain', shouldHave: true },
    { usage: 'subagentCoder', shouldHave: true },
    { usage: 'twinSubagent', shouldHave: true }, // 透明继承 twinMain
    { usage: 'memoryDream', shouldHave: false }, // 不在 audience
  ];
  for (const { usage, shouldHave } of usages) {
    const backend = await getBackendFor(usage);
    assert(hasEyes(backend) === shouldHave, `usage=${usage}: ${shouldHave ? '有' : '无'}眼睛`, backendToolNames(backend).join(','));
  }

  // 无双注册：每个眼睛工具在 twinMain 桶里只出现一次
  const main = await getBackendFor('twinMain');
  const names = backendToolNames(main);
  for (const n of EYES) {
    assert(names.filter((x) => x === n).length === 1, `${n} 在 twinMain 桶中只注册一次（无双注册）`);
  }

  // ─── part 2: 焦点 deck 锚定 ───
  resetSubmissions();
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'twinmain-eyes-'));
  const projectPath = join(tmpRoot, 'prj');
  await fs.mkdir(projectPath, { recursive: true });

  // 无活跃组 → undefined
  assert((await resolveFocusDeckPath('cnv_eyes')) === undefined, '无活跃组：焦点 deckPath = undefined');

  // 改 A
  const deckA = await createDeck({ projectId: 'prj_e', projectPath, name: 'deckA' });
  await initManifest(deckA.id, HTML);
  const aA = await addAnnotation(deckA.id, region('改 A'));
  await submitAnnotations({ artifactId: deckA.id, annotationIds: [aA.id], conversationId: 'cnv_eyes' });
  assert((await resolveFocusDeckPath('cnv_eyes')) === deckA.path, '只有 A 活跃：焦点 = A');

  // 又在同会话改 B（B 即最新活跃 → 焦点跟到 B）
  const deckB = await createDeck({ projectId: 'prj_e', projectPath, name: 'deckB' });
  await initManifest(deckB.id, HTML);
  const aB = await addAnnotation(deckB.id, region('改 B'));
  const rB = await submitAnnotations({ artifactId: deckB.id, annotationIds: [aB.id], conversationId: 'cnv_eyes' });
  assert((await resolveFocusDeckPath('cnv_eyes')) === deckB.path, '又改 B：焦点跟到最近创建的 B');

  // B 完成后排除 → 焦点退回仍活跃的 A
  await finalizeSubmission(rB.groupId, {});
  assert((await resolveFocusDeckPath('cnv_eyes')) === deckA.path, 'B 完成后排除：焦点退回仍活跃的 A');

  // 别的会话不串台
  assert((await resolveFocusDeckPath('cnv_other')) === undefined, '其它会话无活跃组：undefined（不串台）');

  // regression（任务 9 review 揪出的 Map 顺序 bug）：同 artifact 完成后再次提交，Map.set 更新值却不
  // 移动 key 位置——旧 .at(-1) 会错锚到更早插入但仍活跃的另一份 deck。修复后按创建序号取最近。
  {
    resetSubmissions();
    const dA = await createDeck({ projectId: 'prj_e', projectPath, name: 'regA' });
    await initManifest(dA.id, HTML);
    const dB = await createDeck({ projectId: 'prj_e', projectPath, name: 'regB' });
    await initManifest(dB.id, HTML);
    // 先提交 A（Map 先插 A），再提交 B（Map 后插 B，居迭代末尾）
    const aA = await addAnnotation(dA.id, region('A1'));
    const ra = await submitAnnotations({ artifactId: dA.id, annotationIds: [aA.id], conversationId: 'cnv_reg' });
    const aB = await addAnnotation(dB.id, region('B1'));
    await submitAnnotations({ artifactId: dB.id, annotationIds: [aB.id], conversationId: 'cnv_reg' });
    // A 完成（A 仍留 Map 位置 0），再次提交 A —— set 更新 A 的值但 key 不移位，B 仍在末尾且活跃
    await finalizeSubmission(ra.groupId, {});
    const aA2 = await addAnnotation(dA.id, region('A2'));
    await submitAnnotations({ artifactId: dA.id, annotationIds: [aA2.id], conversationId: 'cnv_reg' });
    assert(
      (await resolveFocusDeckPath('cnv_reg')) === dA.path,
      'regression：同 artifact 完成后再提交，焦点跟到它（不被 Map 顺序带偏到 B）',
    );
  }

  const failed = RESULTS.filter((x) => !x.ok);
  console.log('');
  console.log(`Total: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.error(` - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke fatal error:', e);
  process.exit(1);
});
