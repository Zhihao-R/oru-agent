/**
 * E2E smoke：起 ws server + 真 Twin 调度 + 真 git 仓 → 验证
 *  - chat.proposal 事件正确发出
 *  - task auto-dispatch（信任模式）
 *  - 子 agent 真改文件
 *  - task.done 事件
 *  - Twin 后续调 commit_changes 真做 git commit
 *
 * 用法：tsx --tsconfig tsconfig.node.json electron/main/__smoke_e2e__.ts
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import WebSocket from 'ws';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
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
import { newReqId } from '@shared/ids';
import type { ClientRequestPayload, ServerEvent } from '@shared/protocol';

const AGENT_ID = 'twin';
const TIMEOUT_MS = 240_000; // 4 分钟，给真 Claude 留充足时间

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

function send(ws: WebSocket, payload: ClientRequestPayload): string {
  const reqId = newReqId();
  ws.send(JSON.stringify({ ...payload, reqId }));
  return reqId;
}

async function makeRepo(): Promise<string> {
  const path = join(tmpdir(), `oru-e2e-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(path, 'README.md'), '# Smoke Project\n\n这是 e2e 自测临时项目。\n', 'utf-8');
  const g = simpleGit({ baseDir: path });
  await g.init();
  await g.addConfig('user.email', 'test@oru.local', false, 'local');
  await g.addConfig('user.name', 'oru-test', false, 'local');
  await g.addConfig('commit.gpgsign', 'false', false, 'local');
  await g.add('.');
  await g.commit('init');
  // 切到 main 分支语义；如果不存在，创建
  try {
    await g.raw(['branch', '-M', 'main']);
  } catch {
    // 已经是 main 或老 git
  }
  return path;
}

async function readReadme(repo: string): Promise<string> {
  return fs.readFile(join(repo, 'README.md'), 'utf-8');
}

async function gitLogOneline(repo: string, n: number): Promise<string[]> {
  const g = simpleGit({ baseDir: repo });
  const log = await g.log({ maxCount: n });
  return log.all.map((c) => `${c.hash.slice(0, 7)} ${c.message}`);
}

async function currentBranch(repo: string): Promise<string> {
  const g = simpleGit({ baseDir: repo });
  return (await g.branch()).current;
}

type ChatRunResult = {
  proposalId: string | null;
  taskId: string | null;
  taskDone: boolean;
  taskFailed: boolean;
  taskFailedMessage: string | null;
  finalText: string;
};

async function runChat(
  ws: WebSocket,
  conversationId: string,
  text: string,
  waitForTaskDone: boolean,
): Promise<ChatRunResult> {
  return new Promise<ChatRunResult>((resolve, reject) => {
    let proposalId: string | null = null;
    let taskId: string | null = null;
    let taskDone = false;
    let taskFailed = false;
    let taskFailedMessage: string | null = null;
    let finalText = '';
    let chatDone = false;
    const messageId = newReqId();

    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(
        new Error(
          `chat timeout — chatDone=${chatDone}, taskDone=${taskDone}, taskFailed=${taskFailed}`,
        ),
      );
    }, TIMEOUT_MS);

    function maybeResolve() {
      if (waitForTaskDone) {
        if (chatDone && (taskDone || taskFailed)) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve({
            proposalId,
            taskId,
            taskDone,
            taskFailed,
            taskFailedMessage,
            finalText,
          });
        }
      } else {
        if (chatDone) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve({ proposalId, taskId, taskDone, taskFailed, taskFailedMessage, finalText });
        }
      }
    }

    function onMsg(raw: WebSocket.RawData) {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (ev.type === 'chat.proposal' && ev.conversationId === conversationId) {
        proposalId = ev.proposal.id;
        const prof = ev.proposal.kind === 'code' ? ev.proposal.profileId : ev.proposal.kind;
        console.log(`  [evt] chat.proposal title="${ev.proposal.title}" profile=${prof}`);
        // 后台 subagent 跑命令撞到审批 / 首次启用命令能力 → 卡片回流主对话（只读重构 B 块）。
        // headless 无人点确认，模拟用户批准让任务继续——否则任务挂起到 4min 超时（不超时是设计）。
        if (ev.proposal.triggeredBySubagent) {
          send(ws, { type: 'proposal.execute', proposalId: ev.proposal.id });
        }
      } else if (ev.type === 'task.started') {
        taskId = ev.task.id;
        console.log(`  [evt] task.started id=${taskId} profile=${ev.task.profileId}`);
      } else if (ev.type === 'task.progress') {
        // verbose: skip
      } else if (ev.type === 'task.done') {
        taskDone = true;
        console.log(`  [evt] task.done id=${ev.taskId} summary=${ev.summary?.slice(0, 80)}`);
        maybeResolve();
      } else if (ev.type === 'task.failed') {
        taskFailed = true;
        taskFailedMessage = ev.errorMessage;
        console.log(`  [evt] task.failed id=${ev.taskId} err=${ev.errorMessage?.slice(0, 200)}`);
        maybeResolve();
      } else if (ev.type === 'chat.delta' && ev.conversationId === conversationId) {
        if (ev.delta.textChunk) finalText += ev.delta.textChunk;
      } else if (ev.type === 'chat.done' && ev.conversationId === conversationId) {
        chatDone = true;
        maybeResolve();
      } else if (ev.type === 'error') {
        clearTimeout(timer);
        ws.off('message', onMsg);
        reject(new Error(`server error: ${ev.code}: ${ev.message}`));
      }
    }
    ws.on('message', onMsg);
    void messageId;
    send(ws, { type: 'chat.send', agentId: AGENT_ID, conversationId, text });
  });
}

async function main(): Promise<void> {
  console.log('=== e2e smoke ===');

  // 1. 准备临时 git 项目
  await ensureDefaultAgent();
  await updateAgent(AGENT_ID, { approvalMode: 'work' }); // 信任模式：proposal 自动派工
  console.log('[setup] requireApproval = false (trust mode)');

  const repo = await makeRepo();
  console.log(`[setup] temp repo: ${repo}`);
  const project = await addProject(repo);
  setActiveProjectId(project.id);
  console.log(`[setup] added project ${project.id}`);

  // 2. 创建独立的 sub conversation
  await createSubConversation(AGENT_ID, `smoke-e2e-${Date.now()}`);
  const convs = await listConversations(AGENT_ID);
  const subConv = convs.find((c) => c.kind === 'sub' && c.title.startsWith('smoke-e2e-'));
  if (!subConv) throw new Error('failed to create sub conversation');
  const conversationId = subConv.id;
  console.log(`[setup] sub conv: ${conversationId}`);

  // 3. 启 ws server
  const port = await startWsServer();
  console.log(`[setup] ws on 127.0.0.1:${port}`);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'file://' });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  console.log('[setup] ws connected');

  let cleanup = async () => {
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    stopWsServer();
    try {
      await deleteConversation(AGENT_ID, conversationId);
    } catch {}
    try {
      await removeProject(project.id);
    } catch {}
    try {
      await fs.rm(repo, { recursive: true, force: true });
    } catch {}
  };

  try {
    // 4. 第一轮 chat：让 Twin 派 coder 改 README.md
    console.log('[chat] turn 1: 改 README');
    const marker = `oru-smoke-${Date.now()}`;
    const ask1 =
      `请在当前关注项目（${project.name}）的 README.md 文件末尾加一行：\n` +
      `${marker}\n\n` +
      `这个改动很小，请直接通过 Task 工具（mode async）派 project-coder 子 agent 去做。`;
    const r1 = await runChat(ws, conversationId, ask1, true);

    assert(r1.proposalId !== null, 'turn 1: chat.proposal emitted');
    assert(r1.taskId !== null, 'turn 1: task.started emitted');
    assert(r1.taskDone, 'turn 1: task.done', `failed: ${r1.taskFailedMessage}`);
    assert(!r1.taskFailed, 'turn 1: task did not fail', r1.taskFailedMessage ?? undefined);

    // 验证 README.md 真的被改了
    const readme = await readReadme(repo);
    assert(readme.includes(marker), 'turn 1: README.md contains marker', `content: ${readme.slice(0, 200)}`);

    // 验证当前在 oru/* feature 分支
    const branch = await currentBranch(repo);
    assert(branch.startsWith('oru/'), 'turn 1: switched to oru/* feature branch', `branch: ${branch}`);

    // 5. 第二轮 chat：让 Twin 调 commit_changes
    console.log('[chat] turn 2: 让 Twin commit');
    const taskIdForCommit = r1.taskId;
    const ask2 =
      `刚才那个任务的 task_id 是 ${taskIdForCommit}。\n` +
      `请直接调用 mcp__oru__commit_changes 工具提交这个改动。\n` +
      `参数：task_id="${taskIdForCommit}"，message 简短描述加了 ${marker} 这一行。\n` +
      `调用工具后再用一句话回报结果。`;
    const r2 = await runChat(ws, conversationId, ask2, false);
    console.log('[chat] turn 2 Twin says:', r2.finalText.slice(0, 400));

    // dump task store entry for debug
    try {
      const { getTask } = await import('../../electron/main/tasks/store');
      const t = await getTask(r1.taskId!);
      console.log(`[debug] task ${r1.taskId} affectedPaths=${JSON.stringify(t?.affectedPaths)} commitsCreated=${JSON.stringify(t?.commitsCreated)}`);
    } catch (e) {
      console.log('[debug] task dump failed:', e);
    }

    // 检查 git log
    const log = await gitLogOneline(repo, 3);
    console.log('[verify] git log:\n  ' + log.join('\n  '));
    const hasNewCommit = log.length >= 2;
    assert(hasNewCommit, 'turn 2: a new commit appeared', `log lines: ${log.length}`);

    // working tree 应该是 clean
    const status = await simpleGit({ baseDir: repo }).status();
    assert(status.isClean(), 'turn 2: working tree clean after commit', `files: ${status.files.map((f) => f.path).join(',')}`);

    // 6. 第三轮：测 rollback（通过 ws 协议）
    console.log('[chat] turn 3: 通过 ws 触发 task.rollback');
    if (r1.taskId) {
      const reqId = send(ws, { type: 'task.rollback', taskId: r1.taskId });
      const ackOrErr = await waitForReply(ws, reqId, 30000);
      const isAck = ackOrErr?.type === 'ack';
      assert(isAck, 'turn 3: task.rollback ack', `got: ${JSON.stringify(ackOrErr).slice(0, 200)}`);
      // 验证：要么 README 被还原（无 commit 路径），要么有 revert commit（已 commit 路径）
      const readmeAfter = await readReadme(repo);
      const revertedFile = !readmeAfter.includes(marker);
      const log2 = await gitLogOneline(repo, 5);
      const hasRevert = log2.some((l) => /Revert/i.test(l));
      assert(revertedFile || hasRevert, 'turn 3: rollback effective (file or revert commit)', `readme has marker: ${!revertedFile}; log has revert: ${hasRevert}`);
    } else {
      assert(false, 'turn 3: no taskId available, skip');
    }
  } finally {
    await cleanup();
  }

  const failed = RESULTS.filter((r) => !r.ok);
  console.log('---');
  console.log(`total: ${RESULTS.length}, pass: ${RESULTS.length - failed.length}, fail: ${failed.length}`);
  if (failed.length > 0) {
    console.error('FAILED:', JSON.stringify(failed, null, 2));
    process.exit(1);
  }
  console.log('ALL PASS');
  process.exit(0);
}

function waitForReply(
  ws: WebSocket,
  reqId: string,
  timeoutMs: number,
): Promise<ServerEvent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      resolve(null);
    }, timeoutMs);
    function onMsg(raw: WebSocket.RawData) {
      try {
        const ev = JSON.parse(raw.toString()) as ServerEvent;
        if (ev.reqId === reqId) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(ev);
        }
      } catch {
        // ignore
      }
    }
    ws.on('message', onMsg);
  });
}

main().catch(async (e) => {
  console.error('SMOKE FAILED:', e);
  try {
    stopWsServer();
  } catch {}
  process.exit(1);
});
