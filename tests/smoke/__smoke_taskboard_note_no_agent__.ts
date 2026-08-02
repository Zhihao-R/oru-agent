/**
 * plain 留言路径：直接调 router 内部依赖（appendMessage + incrementCommentCount），
 * 验证：
 *   1. 留言落盘到评论 conv 的 jsonl
 *   2. task.commentCount +1
 *   3. mentions 字段持久化（数组形态预留 v2）
 *   4. 不触发任何 agent runChat（不依赖 fake backend：不 import 不 setup → runChat 不会被调）
 */
import './__smoke_isolate__';

import { newMessageId } from '@shared/ids';
import type { ChatMessage } from '@shared/types';
import { appendMessage, readHistory } from '../../electron/main/conversations/store';
import {
  createTask,
  ensureCommentConversation,
  getTask,
  incrementCommentCount,
} from '../../electron/main/taskboard/store';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function main() {
  const t = await createTask({ title: '留言测试' }, 'you');
  const { conv } = await ensureCommentConversation(t.id);

  // 模拟 router taskboard.note.add 的核心动作
  const userMsg: ChatMessage = {
    id: newMessageId(),
    conversationId: conv.id,
    role: 'user',
    text: '明天再做这件事',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    mentions: [], // 纯留言：mentions 空数组
  };
  await appendMessage(conv.agentId, conv.id, userMsg);
  await incrementCommentCount(t.id);

  // case 1: 落盘
  const history = await readHistory(conv.agentId, conv.id);
  assert(history.length === 1, '历史含 1 条消息');
  assert(history[0].text === '明天再做这件事', '消息文本正确');
  assert(history[0].role === 'user', '消息 role=user');
  assert(Array.isArray(history[0].mentions) && history[0].mentions.length === 0, '消息 mentions 是空数组');

  // case 2: commentCount +1
  const t1 = await getTask(t.id);
  assert(t1?.commentCount === 1, 'task.commentCount=1');

  // case 3: 多次留言累加
  for (let i = 0; i < 3; i += 1) {
    await appendMessage(conv.agentId, conv.id, {
      id: newMessageId(),
      conversationId: conv.id,
      role: 'user',
      text: `留言 ${i}`,
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
      mentions: [],
    });
    await incrementCommentCount(t.id);
  }
  const t4 = await getTask(t.id);
  assert(t4?.commentCount === 4, '4 条后 task.commentCount=4');

  // case 4: mentions 数组形态——v2 多 @
  const noteWithMention: ChatMessage = {
    id: newMessageId(),
    conversationId: conv.id,
    role: 'user',
    text: '@oru 看看',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    mentions: ['oru'],
  };
  await appendMessage(conv.agentId, conv.id, noteWithMention);
  const all = await readHistory(conv.agentId, conv.id);
  const last = all[all.length - 1];
  assert(last.mentions?.[0] === 'oru', '带 @oru 的留言 mentions 含 "oru"');

  // 汇总
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
