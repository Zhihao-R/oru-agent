/**
 * Deck 模块 v1：propose_deck_create / performDeckCreate / 独立执行器 集成 smoke
 *
 * 验证：
 * 1. propose_deck_create 工具构造 DeckCreateProposal 字段正确 + 调 onProposal
 * 2. propose_deck_create 没 active project + 未传 target → 报错
 * 3. performDeckCreate 完整流程：建 deck 目录 → initManifest → setActiveDeck →
 *    enqueueTask（mock queue 捕获 CodeActionProposal）+ deckContext 透传
 * 4. CodeActionProposal 的 rawPlan 含 read_skill 指令 + 正确 deck path
 * 5. 完成后 proposal.status='executed' + 广播 proposal.statusChanged
 *
 * 不调真 Claude；不打真 queue（用 __setRunFnForTest 拦截）
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { ActionProposal, CodeActionProposal, DeckCreateProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { makeProposeDeckCreateTool } from '../../electron/main/agent/agentTools/proposeDeck';
import { performDeckCreate } from '../../electron/main/proposals/performDeckCreate';
import { addProject } from '../../electron/main/projects/store';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { getActiveDeckId, listDecks, setActiveDeckId } from '../../electron/main/deck/store';
import { __setRunFnForTest, __resetQueuesForTest } from '../../electron/main/tasks/queue';
import { upsertSkill } from '../../electron/main/skills/registry';

/** 注册一个假的已装 deck skill——proposeDeck 现在会先查注册表，缺则改走引导安装卡。 */
function registerFakeSkill(id: string): void {
  upsertSkill({
    id,
    name: id,
    description: `fake ${id}`,
    path: `/tmp/fake-skills/${id}`,
    source: 'standalone',
    availableFromTimestamp: 0,
    enabled: true,
  });
}

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function main() {
  await ensureDefaultAgent();

  // 准备一个 project
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'deck-propose-'));
  const projectPath = join(tmpRoot, 'demo-project');
  await fs.mkdir(projectPath, { recursive: true });
  await addProject(projectPath);

  // 注册假的已装 deck skill（默认 html-ppt-skill + 显式用到的 guizang-ppt-skill），
  // 否则 proposeDeck 会判"未装"改走 skill.install 引导卡，而非 deck.create。
  registerFakeSkill('html-ppt-skill');
  registerFakeSkill('guizang-ppt-skill');

  // ─── case 1: propose_deck_create 工具 ───
  const tool = makeProposeDeckCreateTool();
  let captured: ActionProposal | null = null;
  const ctx = {
    conversationId: 'cnv_test',
    agentId: 'agt_test',
    ownerId: 'local-user',
    activeProjectId: undefined as string | undefined,
    approvalMode: 'work',
    usage: 'twinMain' as const,
    abortSignal: new AbortController().signal,
    onProposal: async (p: ActionProposal) => { captured = p; },
  };

  // case 1a: 没 active project + 没 target_project_id → 错
  const r1 = await tool.execute(
    {
      deck_name: 'AI 私享会',
      brief: '12 页瑞士风 deck，PM 受众',
      size_hint: '≈ 12 页 · 8 张图',
      narrative: '# 叙事文稿\n\n开场→方案→行动',
    },
    ctx,
  );
  assert(r1.isError === true, '缺 target + active 时报错');

  // case 1b: 提供 target_project_id
  const { listProjects } = await import('../../electron/main/projects/store');
  const projects = await listProjects();
  const projectId = projects.projects[0].id;

  const r2 = await tool.execute(
    {
      deck_name: 'AI 私享会',
      target_project_id: projectId,
      deck_skill_id: 'guizang-ppt-skill',
      brief: '12 页瑞士风 deck，PM 受众',
      size_hint: '≈ 12 页 · 8 张图',
      eta_hint: '5 分钟',
      narrative: '# 叙事文稿\n\n开场→方案→行动',
      auto_generate: true,
    },
    ctx,
  );
  assert(!r2.isError, '提供 target_project_id 时成功');
  assert(captured !== null, 'onProposal 被调');
  // 用 if-narrow 帮 TS 推
  if (captured) {
    const p = captured as DeckCreateProposal;
    assert(p.kind === 'deck.create', 'kind=deck.create');
    assert(p.deckName === 'AI 私享会', 'deckName 传递');
    assert(p.targetProjectId === projectId, 'targetProjectId 传递');
    assert(p.deckSkillId === 'guizang-ppt-skill', 'deckSkillId 传递');
    assert(p.brief.includes('瑞士风'), 'brief 传递');
    assert(p.sizeHint === '≈ 12 页 · 8 张图', 'sizeHint 传递');
    assert(p.etaHint === '5 分钟', 'etaHint 传递');
    assert(p.narrative.includes('开场→方案→行动'), 'narrative 传递');
    assert(p.autoGenerate === true, 'autoGenerate 传递');
    assert(p.title.includes('AI 私享会'), 'title 含 deck name');
    assert(p.status === 'pending', 'status=pending');
  }

  // case 1c: deck_skill_id 默认 = DEFAULT_DECK_SKILL_ID（html-ppt-skill）
  captured = null;
  await tool.execute(
    {
      deck_name: 'X',
      target_project_id: projectId,
      brief: 'test',
      size_hint: '12 页',
      narrative: '# 叙事文稿\n\ntest',
    },
    ctx,
  );
  assert(captured !== null, '默认 skill 已装时构造 deck.create（非引导卡）');
  if (captured) {
    const p = captured as DeckCreateProposal;
    assert(p.kind === 'deck.create', '默认路径 kind=deck.create');
    assert(p.deckSkillId === 'html-ppt-skill', '默认 deck_skill_id=html-ppt-skill');
    assert(p.autoGenerate === false, '缺省 auto_generate 回落 false（先过目）');
  }

  // case 1d: 默认 skill 未装 → 改走 skill.install 引导卡（不是 deck.create）
  {
    const { removeSkillFromRegistry } = await import('../../electron/main/skills/registry');
    removeSkillFromRegistry('html-ppt-skill');
    let installCard: ActionProposal | null = null;
    const ctx2 = { ...ctx, onProposal: async (p: ActionProposal) => { installCard = p; } };
    const rGuide = await tool.execute(
      { deck_name: 'Y', target_project_id: projectId, brief: 'test', size_hint: '12 页', narrative: '# x' },
      ctx2,
    );
    assert(!rGuide.isError, '默认 skill 未装时不报错（走引导）');
    assert(installCard !== null && (installCard as ActionProposal).kind === 'skill.install',
      '默认 skill 未装 → 递交 skill.install 引导卡');
    registerFakeSkill('html-ppt-skill'); // 复原，避免影响后续
  }

  // ─── case 2: performDeckCreate 完整链路 ───
  __resetQueuesForTest();
  setActiveDeckId(null);

  // mock queue runner：捕获派工的 CodeActionProposal，不真跑
  let queuedProposal: CodeActionProposal | null = null;
  const restoreRun = __setRunFnForTest(async (item) => {
    queuedProposal = item.proposal;
  });

  const events: ServerEvent[] = [];
  const broadcast = (ev: ServerEvent) => events.push(ev);

  const deckProposal = {
    id: 'prp_test',
    ownerId: 'local-user',
    conversationId: 'cnv_test',
    title: '新建演示稿 · 测试 deck',
    description: '测试用',
    createdAt: Date.now(),
    status: 'pending' as const,
    kind: 'deck.create' as const,
    deckName: '测试 deck',
    targetProjectId: projectId,
    deckSkillId: 'guizang-ppt-skill',
    brief: '一个 deck 用于测试',
    sizeHint: '5 页',
    etaHint: '2 分钟',
    narrative: '# 叙事文稿\n\n测试叙事',
    autoGenerate: true,
  };
  await performDeckCreate(deckProposal, broadcast);

  // 等队列异步执行（mock runFn 是 async）
  await new Promise((r) => setTimeout(r, 50));

  assert(getActiveDeckId() !== null, '执行后 active deck 已设');

  const decks = await listDecks(projectId);
  assert(decks.length >= 1, '至少有一个 deck');
  const myDeck = decks.find((d) => d.name === '测试 deck');
  assert(!!myDeck, '找到刚建的 deck');
  if (myDeck) {
    assert(getActiveDeckId() === myDeck.id, 'active 是新建的 deck');
    // 验证文件初始化
    const indexExists = await fs.access(join(myDeck.path, 'index.html')).then(() => true).catch(() => false);
    assert(indexExists, 'index.html 已写');
    const manifestExists = await fs
      .access(join(myDeck.path, '.history/manifest.json'))
      .then(() => true)
      .catch(() => false);
    assert(manifestExists, 'manifest.json 已写');
    // 项目B：版本字节进 fileHistory 中央仓（退 .history/versions）。验 v001 版本带 snapshotId 且可取回
    const { readManifest, restoreVersionContent } = await import('../../electron/main/deck/history');
    const m = await readManifest(myDeck.id);
    const v001 = m?.versions.find((v) => v.id === 'v001');
    assert(!!v001?.snapshotId, 'v001 版本带 snapshotId（字节进中央仓）');
    const v001Bytes = await restoreVersionContent(myDeck.id, 'v001').catch(() => null);
    assert(v001Bytes !== null, 'v001 字节可从中央仓取回');
    const imagesExists = await fs.access(join(myDeck.path, 'images')).then(() => true).catch(() => false);
    assert(imagesExists, 'images/ 已建');
  }

  // 广播事件
  const deckStateEvents = events.filter((e) => e.type === 'artifact.state');
  assert(deckStateEvents.length >= 1, '广播了 deck.state');
  const proposalStatusEvents = events.filter((e) => e.type === 'proposal.statusChanged');
  assert(proposalStatusEvents.length >= 1, '广播了 proposal.statusChanged');
  if (proposalStatusEvents.length > 0) {
    const ev = proposalStatusEvents[0];
    assert(ev.type === 'proposal.statusChanged' && ev.status === 'executed', 'status=executed');
  }

  assert(deckProposal.status === 'executed', 'proposal 标 executed');

  // 队列收到 CodeActionProposal
  assert(queuedProposal !== null, '派工到 queue');
  if (queuedProposal) {
    const q = queuedProposal as CodeActionProposal;
    assert(q.kind === 'code', '派的是 code proposal');
    assert(q.targetProjectId === projectId, 'code proposal targetProjectId 透传');
    assert(q.rawPlan.includes("read_skill('guizang-ppt-skill')"), 'rawPlan 含 read_skill 指令');
    assert(q.rawPlan.includes(myDeck?.path ?? ''), 'rawPlan 含 deck path');
    assert(q.deckContext !== undefined, 'deckContext 已附');
    if (q.deckContext) {
      assert(q.deckContext.artifactId === myDeck?.id, 'deckContext.artifactId 透传');
      assert(q.deckContext.deckPath === myDeck?.path, 'deckContext.deckPath 透传');
      assert(q.deckContext.deckSkillId === 'guizang-ppt-skill', 'deckContext.deckSkillId 透传');
    }
  }

  restoreRun();
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
