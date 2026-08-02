/**
 * 标注修改端到端 smoke —— 验证「模型真的动手改文件」而非空喊"开提案让 subagent"
 *
 * 真实链路：ws server + 真 Twin（真 Claude）+ 真 deck + 真标注提交组。
 *   用户打两条标注 → submitAnnotations 成组（buildPendingSubmissionHint 会注入源文件路径）
 *   → 经 ws chat.send 发"按照我的标注进行修改"
 *   → 观察 Twin 是否读了源文件 + 真改了文件 + artifact_finalize_submission 收尾
 *     （oru 工具与 SDK 内建 Read/Edit/Write 都算数——claude-code 后端两套并存，模型选哪套不限定）
 *   → 断言 index.html 落盘内容真的变了
 *
 * 信任模式（requireApproval=false）：FileWriteProposal 自动执行落盘，无需 ws 审批往返。
 *
 * 用法：tsx --tsconfig tsconfig.node.json tests/smoke/__smoke_annotation_edit_e2e__.ts
 */
import './__smoke_isolate__'; // 必须第一行：ORU_DIR 重定向到 tmpdir
import WebSocket from 'ws';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { startWsServer, stopWsServer } from '../../electron/main/ws/server';
import { ensureDefaultAgent, updateAgent } from '../../electron/main/agent/store/agents';
import {
  createSubConversation,
  deleteConversation,
  listConversations,
} from '../../electron/main/conversations/store';
import { addProject, removeProject } from '../../electron/main/projects/store';
import { setActiveProjectId } from '../../electron/main/agent/activeProject';
import { createDeck, resolveDeckPath } from '../../electron/main/deck/store';
import { initManifest } from '../../electron/main/deck/history';
import { addAnnotation } from '../../electron/main/deck/annotations';
import { submitAnnotations } from '../../electron/main/deck/submissions';
import { newReqId } from '@shared/ids';
import type { ClientRequestPayload, ServerEvent } from '@shared/protocol';

const AGENT_ID = 'twin';
const TIMEOUT_MS = 240_000; // 4 分钟，给真 Claude 读+改两页留时间

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

const INITIAL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>核心能力</title></head>
<body>
<section class="slide" data-page="6"><h1>核心能力① 语义搜索</h1><p>传统关键词搜索的局限</p></section>
<section class="slide" data-page="8"><h1>核心能力③ 知识图谱+可视化</h1><p>梳理 AI 发现的隐性关联</p></section>
</body></html>
`;

const region = (comment: string, pageIndex: number) => ({
  comment,
  htmlSnippet: '',
  text: '',
  locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex },
});

async function makeRepo(): Promise<string> {
  const path = join(tmpdir(), `oru-annot-e2e-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(path, 'README.md'), '# Annotation E2E\n', 'utf-8');
  const g = simpleGit({ baseDir: path });
  await g.init();
  await g.addConfig('user.email', 'test@oru.local', false, 'local');
  await g.addConfig('user.name', 'oru-test', false, 'local');
  await g.add('.');
  await g.commit('init');
  return path;
}

function send(ws: WebSocket, payload: ClientRequestPayload): void {
  ws.send(JSON.stringify({ ...payload, reqId: newReqId() }));
}

type ToolHit = { name: string; path?: string };

type RunResult = { toolCalls: ToolHit[]; finalText: string };

async function runChat(ws: WebSocket, conversationId: string, text: string): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const toolCalls: ToolHit[] = [];
    let finalText = '';
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`chat timeout — toolCalls so far: ${toolCalls.map((t) => t.name).join(', ')}`));
    }, TIMEOUT_MS);

    function onMsg(raw: WebSocket.RawData): void {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (ev.type === 'chat.toolCall' && ev.conversationId === conversationId) {
        const path = typeof ev.tool.input?.path === 'string' ? (ev.tool.input.path as string) : undefined;
        toolCalls.push({ name: ev.tool.name, path });
        console.log(`  [tool] ${ev.tool.name}${path ? ` path=${path.split('/').slice(-2).join('/')}` : ''}`);
      } else if (ev.type === 'chat.delta' && ev.conversationId === conversationId) {
        if (ev.delta.textChunk) finalText += ev.delta.textChunk;
      } else if (ev.type === 'chat.done' && ev.conversationId === conversationId) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve({ toolCalls, finalText });
      } else if (ev.type === 'error') {
        clearTimeout(timer);
        ws.off('message', onMsg);
        reject(new Error(`server error: ${ev.code}: ${ev.message}`));
      }
    }
    ws.on('message', onMsg);
    send(ws, { type: 'chat.send', agentId: AGENT_ID, conversationId, text });
  });
}

const has = (calls: ToolHit[], needle: string) => calls.some((t) => t.name.includes(needle));

async function main(): Promise<void> {
  console.log('=== annotation edit e2e smoke ===');
  await ensureDefaultAgent();
  await updateAgent(AGENT_ID, { approvalMode: 'work' }); // 信任模式：写提案自动落盘
  console.log('[setup] requireApproval=false (trust mode)');

  const repo = await makeRepo();
  const project = await addProject(repo);
  setActiveProjectId(project.id);
  console.log(`[setup] project ${project.id} @ ${repo}`);

  await createSubConversation(AGENT_ID, `smoke-annot-${Date.now()}`);
  const convs = await listConversations(AGENT_ID);
  const subConv = convs.find((c) => c.kind === 'sub' && c.title.startsWith('smoke-annot-'));
  if (!subConv) throw new Error('failed to create sub conversation');
  const conversationId = subConv.id;
  console.log(`[setup] conv ${conversationId}`);

  // deck + 初始 HTML（落 index.html 到项目目录，read_file 白名单内）
  const deck = await createDeck({ projectId: project.id, projectPath: repo, name: '核心能力页' });
  await initManifest(deck.id, INITIAL_HTML);
  const deckPath = await resolveDeckPath(deck.id);
  const indexPath = join(deckPath, 'index.html');
  console.log(`[setup] deck ${deck.id} index=${indexPath}`);

  // 两条标注 + 提交成组
  const a1 = await addAnnotation(deck.id, region('太素了，用户也抓不住重点，重新设计一下', 0));
  const a2 = await addAnnotation(deck.id, region('美化一下，现在很丑', 1));
  const sub = await submitAnnotations({
    artifactId: deck.id,
    annotationIds: [a1.id, a2.id],
    conversationId,
  });
  const composer =
    '按照我的标注进行修改\n\n' + sub.payload.map((p, i) => `- [#${i + 1}] ${p.comment}`).join('\n');
  console.log(`[setup] submission group ${sub.groupId}, composer text:\n${composer}\n`);

  const port = await startWsServer();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'file://' });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  console.log(`[setup] ws connected on ${port}`);

  const cleanup = async (): Promise<void> => {
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    stopWsServer();
    try { await deleteConversation(AGENT_ID, conversationId); } catch {}
    try { await removeProject(project.id); } catch {}
    // 探针：保留制品供人工眼检（路径已打印）；不 rm repo
  };

  try {
    console.log('[chat] 发送"按照我的标注进行修改"，等 Twin 处理…');
    const r = await runChat(ws, conversationId, composer);
    console.log(`\n[result] 工具调用序列: ${r.toolCalls.map((t) => t.name).join(' → ') || '(无)'}`);
    console.log(`[result] Twin 最终回复:\n${r.finalText.slice(0, 600)}\n`);

    // 落盘内容是否真变了（核心证据）
    const after = await fs.readFile(indexPath, 'utf-8').catch(() => '');
    const changed = after.trim() !== INITIAL_HTML.trim() && after.length > 0;

    // 工具名取 mcp__oru__ 前缀末段归一后精确比对；SDK 内建 Read/Edit/Write 与 oru 同义
    const names = r.toolCalls.map((t) => t.name.split('__').pop() ?? t.name);
    const hasAny = (...cands: string[]) => names.some((n) => cands.includes(n));
    assert(hasAny('read_file', 'Read'), 'Twin 读了源文件（read_file / SDK Read）');
    assert(
      hasAny('edit_file', 'write_file', 'Edit', 'Write', 'MultiEdit'),
      'Twin 真动手改了文件（edit_file/write_file 或 SDK Edit/Write）——核心：不是空喊提案',
      r.toolCalls.map((t) => t.name).join(',') || '(无任何工具调用)',
    );
    assert(changed, 'index.html 落盘内容真的变了（端到端落盘）', `len ${INITIAL_HTML.length}→${after.length}`);
    assert(
      has(r.toolCalls, 'finalize_submission'),
      'Twin 调了 artifact_finalize_submission 收尾',
    );
    // 🔍 探针：单次 edit 是否覆盖了两条标注指向的两页（都保留 + 都被扩写）
    const bothPagesPresent = after.includes('语义搜索') && after.includes('知识图谱');
    assert(bothPagesPresent, '🔍 两页都还在（没漏改/删页）：语义搜索 + 知识图谱', `len=${after.length}`);
    console.log(`\n[probe] 改后 index.html 路径（保留供眼检）：${indexPath}`);
  } finally {
    await cleanup();
  }

  const failed = RESULTS.filter((x) => !x.ok);
  console.log(`\nTotal: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke fatal error:', e);
  process.exit(1);
});
