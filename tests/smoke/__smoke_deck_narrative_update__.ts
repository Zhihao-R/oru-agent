/**
 * Deck 叙事文稿 · 「据文稿更新演示设计」派发 smoke（Task 3.2/3.3）
 *
 * 钉本任务核心风险（决策 D-A：文稿喂模型但不刷屏）：
 * 1. updateFromNarrative(includeAnnotations:false) → 建了**空标注**提交组
 *    （getByArtifact 有组、annotationIds 空、有 beforeVersionId 改前版本）。
 * 2. **核心断言**：派发把文稿放进 extraDynamicSystemPrompt（→ runChat 的 systemContext）
 *    而非 userText——
 *      - userText / userMessage === '据当前文稿更新这份演示设计'（不含文稿全文）
 *      - 落盘的用户消息文本同样是这一行（不刷屏）
 *      - systemContext 含文稿内容 + groupId（喂给模型）
 * 3. includeAnnotations:true → 该 deck 所有 pending 标注被并入组（annotationIds 非空）。
 *
 * 通过 fake backend 捕获 runConversation 入参（userMessage / systemContext）——驱动真实
 * route() handler，验证从 WS 入口到 runChat 的整条接线，而非只测工厂函数。不打真 Claude。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { ChatMessage } from '@shared/types';
import type { AgentBackend, ConversationEvent, ConversationInput } from '@shared/agent/backend';
import type { ServerEvent } from '@shared/protocol';
import { __setBackendFactoryForTest } from '../../electron/main/agent/backends/factory';
import { createSubConversation, readHistory } from '../../electron/main/conversations/store';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { route } from '../../electron/main/ws/router';
import { createDeck } from '../../electron/main/deck/store';
import { initManifest, readManifest } from '../../electron/main/deck/history';
import { deckNarrativePath } from '../../electron/main/deck/pathResolver';
import { addAnnotation } from '../../electron/main/deck/annotations';
import { getByArtifact, __resetForTest as resetSubmissions } from '../../electron/main/deck/submissions';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

const FILLED_HTML = '<!doctype html><html><body><section class="slide">REAL</section></body></html>';
const region = (comment: string) => ({
  comment,
  htmlSnippet: '',
  text: '',
  locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex: 0 },
});

/** 捕获 runConversation 入参的 fake backend；run() 解析后 captured 已填。 */
function makeCapturingBackend(): { backend: AgentBackend; done: Promise<void>; captured: { input?: ConversationInput } } {
  const captured: { input?: ConversationInput } = {};
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const backend: AgentBackend = {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'mdl_fake',
    providerId: 'prv_fake',
    runConversation: (input: ConversationInput) => {
      captured.input = input;
      return {
        events: (async function* (): AsyncIterable<ConversationEvent> {
          yield { type: 'session', sessionId: 's1' };
          yield { type: 'result', resultText: 'ok', isError: false };
          resolveDone();
        })(),
      };
    },
    runOneShot: async () => ({ text: 'irrelevant' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'fake' }),
  } as unknown as AgentBackend;
  return { backend, done, captured };
}

async function main() {
  resetSubmissions();
  const agent = await ensureDefaultAgent();
  const conv = await createSubConversation(agent.id, '新对话');

  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'deck-narr-update-'));
  const projectPath = join(tmpRoot, 'prj');
  await fs.mkdir(projectPath, { recursive: true });

  const events: ServerEvent[] = [];
  const broadcast = (ev: ServerEvent) => events.push(ev);
  const replies: ServerEvent[] = [];
  const reply = (_reqId: string, ev: ServerEvent) => replies.push(ev);

  // ─── case 1+2: includeAnnotations:false → 空组 + 文稿进 system 不进 userText ───
  {
    const { backend, done, captured } = makeCapturingBackend();
    const restore = __setBackendFactoryForTest(async () => backend);
    try {
      const deck = await createDeck({ projectId: 'prj_u', projectPath, name: 'upd1' });
      await initManifest(deck.id, FILLED_HTML);
      const narrative = '# 叙事文稿\n\n开场讲新痛点 X，再递进到方案 Y，结尾呼吁行动 Z。';
      await fs.writeFile(deckNarrativePath(deck.path), narrative, 'utf-8');
      const beforeVersion = (await readManifest(deck.id))!.currentVersion;

      events.length = 0;
      replies.length = 0;
      await route(
        {
          type: 'artifact.updateFromNarrative',
          reqId: 'r1',
          artifactId: deck.id,
          conversationId: conv.id,
          includeAnnotations: false,
        },
        reply,
        broadcast,
      );

      // case 1: 建了空标注提交组
      const sub = getByArtifact(deck.id);
      assert(!!sub, 'case1: updateFromNarrative 建了提交组');
      assert(!!sub && sub.annotationIds.length === 0, 'case1: 空标注组（annotationIds 空）', JSON.stringify(sub?.annotationIds));
      assert(!!sub && !!sub.beforeVersionId, 'case1: 组有 beforeVersionId 改前版本');
      assert(!!sub && sub.beforeVersionId === beforeVersion, 'case1: beforeVersionId = 提交前 currentVersion');
      assert(replies.some((e) => e.type === 'ack'), 'case1: 回 ack');
      assert(events.some((e) => e.type === 'chat.started'), 'case1: 广播 chat.started');
      assert(events.some((e) => e.type === 'artifact.submissionChanged'), 'case1: 广播 submissionChanged');

      // 等 fire-and-forget runChatAndPersist 跑到 backend
      await done;

      // case 2（核心）：文稿进 system、userText 是干净一行
      const input = captured.input!;
      assert(!!input, 'case2: backend.runConversation 被调（派发成功）');
      assert(
        input.userMessage === '据当前文稿更新这份演示设计',
        'case2(核心): userMessage 是干净一行（不含文稿全文）',
        input.userMessage,
      );
      assert(
        !(input.userMessage ?? '').includes('开场讲新痛点 X'),
        'case2(核心): userMessage 不含文稿内容',
      );
      assert(
        (input.systemContext ?? '').includes('开场讲新痛点 X') &&
          (input.systemContext ?? '').includes('结尾呼吁行动 Z'),
        'case2(核心): systemContext 含文稿全文（喂给模型）',
      );
      assert(
        (input.systemContext ?? '').includes(sub!.groupId),
        'case2(核心): systemContext 含 groupId（告诉模型收尾用它）',
        sub?.groupId,
      );

      // 落盘的用户消息同样只有这一行（不刷屏）
      const msgs = await readHistory(agent.id, conv.id);
      const lastUser = [...msgs].reverse().find((m: ChatMessage) => m.role === 'user');
      assert(
        lastUser?.text === '据当前文稿更新这份演示设计',
        'case2: 落盘 user 消息文本是干净一行（不进 history 刷屏）',
        lastUser?.text,
      );

      // M5 回归：user 消息与 assistant 轮必须各自独立 id（曾共用一个 newMessageId 导致 ID 冲突）
      const started = events.find((e) => e.type === 'chat.started');
      assert(
        !!lastUser && started?.type === 'chat.started' && lastUser.id !== started.messageId,
        'case2(M5 回归): 落盘 user 消息 id ≠ assistant 轮 messageId',
        `user=${lastUser?.id} started=${started?.type === 'chat.started' ? started.messageId : '?'}`,
      );
    } finally {
      restore();
    }
  }

  // ─── case 3: includeAnnotations:true → pending 标注并入组 ───
  {
    resetSubmissions();
    const { backend, done } = makeCapturingBackend();
    const restore = __setBackendFactoryForTest(async () => backend);
    try {
      const deck = await createDeck({ projectId: 'prj_u', projectPath, name: 'upd2' });
      await initManifest(deck.id, FILLED_HTML);
      await fs.writeFile(deckNarrativePath(deck.path), '# 文稿\n\n内容。', 'utf-8');
      const a1 = await addAnnotation(deck.id, region('改这处'));
      const a2 = await addAnnotation(deck.id, region('也改这处'));

      replies.length = 0;
      await route(
        {
          type: 'artifact.updateFromNarrative',
          reqId: 'r3',
          artifactId: deck.id,
          conversationId: conv.id,
          includeAnnotations: true,
        },
        reply,
        broadcast,
      );

      const sub = getByArtifact(deck.id);
      assert(!!sub, 'case3: 建了提交组');
      assert(
        !!sub && sub.annotationIds.length === 2 && sub.annotationIds.includes(a1.id) && sub.annotationIds.includes(a2.id),
        'case3: includeAnnotations:true → 两条 pending 标注并入组',
        JSON.stringify(sub?.annotationIds),
      );
      await done;
    } finally {
      restore();
    }
  }

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
