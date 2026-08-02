/**
 * 评论删除（项⑤major）行为：
 *   1. 删一条用户评论 → history 少这条、commentCount -1
 *   2. 回归·关键决策：删 @oru 母评论，Oru 回复保留（只删这一条，不级联）
 *   3. deleteMessage 删不存在的 id → 返回 false、不误扣 commentCount
 *   4. decrementCommentCount 不跌破 0；不存在 / 已删 task 不抛
 */
import './__smoke_isolate__';

import { newMessageId } from '../../shared/ids';
import type { ChatMessage } from '../../shared/types';
import {
  appendMessage,
  deleteMessage,
  readHistory,
} from '../../electron/main/conversations/store';
import {
  createTask,
  decrementCommentCount,
  ensureCommentConversation,
  getTask,
  incrementCommentCount,
  softDeleteTask,
} from '../../electron/main/taskboard/store';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function userMsg(convId: string, text: string, mentions: string[] = []): ChatMessage {
  return {
    id: newMessageId(),
    conversationId: convId,
    role: 'user',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    mentions: mentions as ChatMessage['mentions'],
  };
}
function oruMsg(convId: string, text: string): ChatMessage {
  return {
    id: newMessageId(),
    conversationId: convId,
    role: 'assistant',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  };
}

async function main() {
  const task = await createTask({ title: '删评论测试' }, 'you');
  const { conv } = await ensureCommentConversation(task.id);
  const agentId = conv.agentId;

  // 铺一条 @oru 母评论 + 一条 Oru 回复（模拟 comment.send 路径：各 +1）
  const parent = userMsg(conv.id, '@oru 看看这个', ['oru']);
  await appendMessage(agentId, conv.id, parent);
  await incrementCommentCount(task.id);
  const reply = oruMsg(conv.id, '我看过了，建议如下…');
  await appendMessage(agentId, conv.id, reply);
  await incrementCommentCount(task.id);

  const before = await readHistory(agentId, conv.id);
  assert(before.length === 2, '铺垫后 history 有 2 条');
  assert((await getTask(task.id))?.commentCount === 2, '铺垫后 commentCount=2');

  // case 1 + 2: 删母评论，Oru 回复保留
  const deleted = await deleteMessage(agentId, conv.id, parent.id);
  assert(deleted === true, 'deleteMessage 删中母评论返回 true');
  await decrementCommentCount(task.id);

  const after = await readHistory(agentId, conv.id);
  assert(after.length === 1, '删后 history 剩 1 条');
  assert(after[0]?.id === reply.id, '回归：保留的是 Oru 回复（母评论已删）');
  assert(after.every((m) => m.id !== parent.id), '母评论确已移除');
  assert((await getTask(task.id))?.commentCount === 1, '删后 commentCount=1');

  // case 3: 删不存在的 id → false，不扣数
  const noHit = await deleteMessage(agentId, conv.id, 'msg_does_not_exist');
  assert(noHit === false, 'deleteMessage 删不存在 id 返回 false');
  assert((await getTask(task.id))?.commentCount === 1, '删不存在不改 commentCount');

  // case 4: decrement 不跌破 0
  await decrementCommentCount(task.id); // 1 → 0
  await decrementCommentCount(task.id); // 0 → 0（floor）
  assert((await getTask(task.id))?.commentCount === 0, 'commentCount 不跌破 0');

  // case 4b: 已删 / 不存在 task 不抛
  let threw = false;
  try {
    await decrementCommentCount('bt_nonexistent_xxx');
    await softDeleteTask(task.id, 'you');
    await decrementCommentCount(task.id);
  } catch (e) {
    threw = true;
    console.error('  unexpected throw:', e);
  }
  assert(!threw, 'decrementCommentCount 不存在 / 已删 task 不抛');

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
