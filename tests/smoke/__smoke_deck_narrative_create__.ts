/**
 * Deck 叙事文稿 · 创建流改造 smoke（Task 1.2）
 *
 * 验证新流程三点：
 * 1. autoGenerate=false → .narrative.md 内容 === 传入 narrative；index.html 仍是 stub
 *    （未生成、未派 subagent）。
 * 2. autoGenerate=true → 派 subagent（mock runFn 写非 stub index.html），index.html 被铺满。
 * 3. 建壳后调 generate_deck（事后生成）→ 触发 dispatchDeckSubagent，rawPlan 含读 .narrative.md 指令。
 *
 * 不调真 Claude；不打真 queue（用 __setRunFnForTest 拦截）。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { CodeActionProposal, DeckCreateProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { performDeckCreate } from '../../electron/main/proposals/performDeckCreate';
import { makeGenerateDeckTool } from '../../electron/main/agent/agentTools/generateDeck';
import { addProject } from '../../electron/main/projects/store';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { getActiveDeckId, listDecks, setActiveDeckId, getDeck } from '../../electron/main/deck/store';
import { __setRunFnForTest, __resetQueuesForTest } from '../../electron/main/tasks/queue';
import { deckNarrativePath } from '../../electron/main/deck/pathResolver';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

function makeDeckProposal(args: {
  projectId: string;
  deckName: string;
  narrative: string;
  autoGenerate: boolean;
}): DeckCreateProposal {
  return {
    id: `prp_${args.deckName}`,
    ownerId: 'local-user',
    conversationId: 'cnv_test',
    title: `新建演示稿 · ${args.deckName}`,
    description: '测试用',
    createdAt: Date.now(),
    status: 'pending',
    kind: 'deck.create',
    deckName: args.deckName,
    targetProjectId: args.projectId,
    deckSkillId: 'guizang-ppt-skill',
    brief: '一个 deck 用于测试',
    sizeHint: '5 页',
    etaHint: '2 分钟',
    narrative: args.narrative,
    autoGenerate: args.autoGenerate,
  };
}

const FILLED_HTML = '<!doctype html><html><body><section class="slide">REAL CONTENT</section></body></html>';

async function main() {
  await ensureDefaultAgent();

  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'deck-narrative-'));
  const projectPath = join(tmpRoot, 'demo-project');
  await fs.mkdir(projectPath, { recursive: true });
  await addProject(projectPath);
  const { listProjects } = await import('../../electron/main/projects/store');
  const projectId = (await listProjects()).projects[0].id;

  const events: ServerEvent[] = [];
  const broadcast = (ev: ServerEvent) => events.push(ev);

  // ─── case 1: autoGenerate=false → 写 narrative、不生成、不派 subagent ───
  __resetQueuesForTest();
  setActiveDeckId(null);
  let queuedA: CodeActionProposal | null = null;
  let restore = __setRunFnForTest(async (item) => { queuedA = item.proposal; });

  const narrativeA = '# 叙事文稿\n\n开场讲痛点，再递进到方案，结尾呼吁行动。';
  const propA = makeDeckProposal({ projectId, deckName: 'deck-A', narrative: narrativeA, autoGenerate: false });
  await performDeckCreate(propA, broadcast);
  await new Promise((r) => setTimeout(r, 50));

  const decksA = await listDecks(projectId);
  const deckA = decksA.find((d) => d.name === 'deck-A');
  assert(!!deckA, 'case1: deck-A 已建');
  if (deckA) {
    const narr = await fs.readFile(deckNarrativePath(deckA.path), 'utf-8');
    assert(narr === narrativeA, 'case1: .narrative.md === 传入 narrative', narr);
    const html = await fs.readFile(join(deckA.path, 'index.html'), 'utf-8');
    assert(html.includes('生成中'), 'case1: index.html 仍是 stub（未生成）', html.slice(0, 80));
    // 记录持久化 deckSkillId
    const rec = await getDeck(deckA.id);
    assert(rec?.deckSkillId === 'guizang-ppt-skill', 'case1: 记录持久化 deckSkillId');
  }
  assert(queuedA === null, 'case1: 未派 subagent（queue 为空）');
  assert(propA.status === 'executed', 'case1: proposal 仍标 executed');
  assert(events.some((e) => e.type === 'artifact.state'), 'case1: 广播 artifact.state');
  assert(
    events.some((e) => e.type === 'proposal.statusChanged' && e.status === 'executed'),
    'case1: 广播 proposal.statusChanged=executed',
  );
  restore();

  // ─── case 2: autoGenerate=true → 派 subagent（mock 写真内容），index.html 铺满 ───
  __resetQueuesForTest();
  setActiveDeckId(null);
  events.length = 0;
  let queuedB: CodeActionProposal | null = null;
  restore = __setRunFnForTest(async (item) => {
    queuedB = item.proposal;
    // mock subagent：把 index.html 铺满
    const dp = item.proposal.deckContext?.deckPath;
    if (dp) await fs.writeFile(join(dp, 'index.html'), FILLED_HTML, 'utf-8');
  });

  const narrativeB = '# 叙事文稿\n\nB 的叙事。';
  const propB = makeDeckProposal({ projectId, deckName: 'deck-B', narrative: narrativeB, autoGenerate: true });
  await performDeckCreate(propB, broadcast);
  await new Promise((r) => setTimeout(r, 50));

  const deckB = (await listDecks(projectId)).find((d) => d.name === 'deck-B');
  assert(!!deckB, 'case2: deck-B 已建');
  assert(queuedB !== null, 'case2: 派了 subagent');
  if (queuedB) {
    const q = queuedB as CodeActionProposal;
    assert(q.rawPlan.includes('.narrative.md'), 'case2: rawPlan 含读 .narrative.md 指令');
    assert(q.rawPlan.includes("read_skill('guizang-ppt-skill')"), 'case2: rawPlan 含 read_skill');
  }
  if (deckB) {
    const html = await fs.readFile(join(deckB.path, 'index.html'), 'utf-8');
    assert(html.includes('REAL CONTENT'), 'case2: index.html 被铺满（非 stub）', html.slice(0, 80));
  }
  restore();

  // ─── case 3: 建壳后 generate_deck 事后生成 ───
  __resetQueuesForTest();
  events.length = 0;
  let queuedC: CodeActionProposal | null = null;
  restore = __setRunFnForTest(async (item) => {
    queuedC = item.proposal;
    const dp = item.proposal.deckContext?.deckPath;
    if (dp) await fs.writeFile(join(dp, 'index.html'), FILLED_HTML, 'utf-8');
  });

  // 用 case1 留下的 deck-A（建壳未生成），设为 active
  assert(!!deckA, 'case3: 有可用的建壳 deck');
  if (deckA) {
    setActiveDeckId(deckA.id);
    const tool = makeGenerateDeckTool();
    const ctx = {
      conversationId: 'cnv_test',
      agentId: 'agt_test',
      ownerId: 'local-user',
      approvalMode: 'work',
      usage: 'twinMain' as const,
      abortSignal: new AbortController().signal,
    };
    const r = await tool.execute({}, ctx);
    assert(!r.isError, 'case3: generate_deck 不报错', r.text);
    await new Promise((rr) => setTimeout(rr, 50));
    assert(queuedC !== null, 'case3: generate_deck 派了 subagent');
    if (queuedC) {
      const q = queuedC as CodeActionProposal;
      assert(q.deckContext?.artifactId === deckA.id, 'case3: 派工锚定 active deck');
      assert(q.deckContext?.deckSkillId === 'guizang-ppt-skill', 'case3: 复用持久化 deckSkillId');
      assert(q.rawPlan.includes('.narrative.md'), 'case3: rawPlan 含读 .narrative.md 指令');
    }
    const html = await fs.readFile(join(deckA.path, 'index.html'), 'utf-8');
    assert(html.includes('REAL CONTENT'), 'case3: 生成后 index.html 被铺满');
  }
  restore();
  __resetQueuesForTest();

  const failed = RESULTS.filter((r) => !r.ok);
  console.log('');
  console.log(`Total: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.error(` - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke fatal:', e);
  process.exit(1);
});
