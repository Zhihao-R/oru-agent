/**
 * activate 首屏批注广播 smoke —— 回归"进入 deck 时批注面板空白，要等加一条才出现"
 *
 * 目标 bug：原 `artifact.activate` 只在孤儿降级 changed 时才广播 annotationsChanged，
 * 普通进入不推批注 → 前端 store 为空 → 面板空白。修复后 activate 必须无条件广播一次当前批注。
 *
 * 离线（不连真 Claude）：建 project + deck + 两条批注 → ws 连上 → 发 artifact.activate
 *   → 断言收到 annotationsChanged，含两条且按创建顺序（a1 在前、a2 在后）。
 *
 * 用法：tsx --tsconfig tsconfig.node.json tests/smoke/__smoke_artifact_activate_annotations__.ts
 */
import './__smoke_isolate__'; // 必须第一行：ORU_DIR 重定向到 tmpdir
import WebSocket from 'ws';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { startWsServer, stopWsServer } from '../../electron/main/ws/server';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { addProject, removeProject } from '../../electron/main/projects/store';
import { setActiveProjectId } from '../../electron/main/agent/activeProject';
import { createDeck } from '../../electron/main/deck/store';
import { initManifest } from '../../electron/main/deck/history';
import { addAnnotation } from '../../electron/main/deck/annotations';
import { newReqId } from '@shared/ids';
import type { ClientRequestPayload, ServerEvent } from '@shared/protocol';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

const INITIAL_HTML = `<!doctype html><html><body><section class="slide">x</section></body></html>\n`;

const region = (comment: string, pageIndex: number) => ({
  comment,
  htmlSnippet: '',
  text: '',
  locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex },
});

async function makeRepo(): Promise<string> {
  const path = join(tmpdir(), `oru-activate-annot-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(path, 'README.md'), '# activate smoke\n', 'utf-8');
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

/** 发 activate 并等首个 annotationsChanged 广播（连上后再发，确保不漏播） */
function activateAndWaitAnnotations(
  ws: WebSocket,
  artifactId: string,
): Promise<Extract<ServerEvent, { type: 'artifact.annotationsChanged' }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timeout：activate 后 5s 内未收到 annotationsChanged 广播'));
    }, 5_000);
    function onMsg(raw: WebSocket.RawData): void {
      let ev: ServerEvent;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      if (ev.type === 'artifact.annotationsChanged' && ev.artifactId === artifactId) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(ev);
      } else if (ev.type === 'error') {
        clearTimeout(timer);
        ws.off('message', onMsg);
        reject(new Error(`server error: ${ev.code}: ${ev.message}`));
      }
    }
    ws.on('message', onMsg);
    send(ws, { type: 'artifact.activate', artifactId });
  });
}

async function main(): Promise<void> {
  console.log('=== activate annotations broadcast smoke ===');
  await ensureDefaultAgent();

  const repo = await makeRepo();
  const project = await addProject(repo);
  setActiveProjectId(project.id);

  const deck = await createDeck({ projectId: project.id, projectPath: repo, name: '批注首屏页' });
  await initManifest(deck.id, INITIAL_HTML);
  // 两条历史批注：先 a1 后 a2（创建顺序）
  const a1 = await addAnnotation(deck.id, region('第一条历史批注', 2));
  const a2 = await addAnnotation(deck.id, region('第二条历史批注', 0));
  console.log(`[setup] deck ${deck.id}, 批注 a1=${a1.id} a2=${a2.id}`);

  const port = await startWsServer();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'file://' });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  const cleanup = async (): Promise<void> => {
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    stopWsServer();
    try { await removeProject(project.id); } catch {}
  };

  try {
    const ev = await activateAndWaitAnnotations(ws, deck.id);
    const ids = ev.annotations.map((a) => a.id);
    // 核心：进入即广播历史批注（修复"面板空白"）
    assert(ev.annotations.length === 2, 'activate 广播了全部 2 条历史批注（不再首屏空白）', `count=${ev.annotations.length}`);
    // 顺序：a1 第2页 在前、a2 第0页 在后——按创建顺序而非页码（a2 页码更小但后建，不该顶到前面）
    assert(
      ids[0] === a1.id && ids[1] === a2.id,
      '按创建顺序排列：先建的 a1 在前、后建的 a2 在末尾（不按页码重排）',
      `order=${ids.join(',')} 期望=${a1.id},${a2.id}`,
    );
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
