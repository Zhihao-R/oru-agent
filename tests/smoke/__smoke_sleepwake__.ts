/**
 * Smoke：sleep-wake-chat-recovery 主进程侧「唤醒主动推 + 放弃释放」真实链路（可复现）
 *
 * 整机睡眠唤醒的真实硬件事件（powerMonitor 'resume'）由 macOS 电源管理触发、无法在沙盒里
 * 程序化调用。本 smoke 走 electron stub 的 powerMonitor 假件，**真正执行 startWakeRecovery
 * 注册监听 → 显式 emit('resume')**（等价于系统唤醒触发) → 唤醒逻辑真实算出在途对话、广播
 * chat.wakeRecover；再把「放弃」走成 abort 释放 in-flight。两分支都打印真实结果——
 * 作为可在测试环境复现的主进程侧验收记录。
 *
 * 前端的「恢复渲染 / 卡重建 / 半截接回」已被单测覆盖（tests/stores/chatStorePendingTurnState、
 * tests/ws/chatPendingTurnStateQuery），此处专注主进程侧。
 *
 * 用法：
 *   NODE_OPTIONS='--import ./tests/smoke/_electronStub/register.mjs' \
 *     tsx --tsconfig tsconfig.node.json tests/smoke/__smoke_sleepwake__.ts
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import { powerMonitor } from 'electron';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';
import {
  awaitUserChoice,
  settleUserChoice,
  listPendingWaiterConvs,
} from '../../electron/main/proposals/pendingUserChoice';
import { startWakeRecovery, disposeWakeRecovery } from '../../electron/main/ws/wakeRecovery';

const q = (header: string) => ({ question: `${header}？`, header, options: [{ label: 'A' }] });

async function main() {
  const convId = 'smoke_sleepwake_conv';
  const key = steeringKey('twin', convId);

  // 造在途现场：占闸（回合在途）+ 一个在等的提问 waiter
  await steeringQueue.beginDirectTurn(key);
  const sig = new AbortController().signal;
  const waiterP = awaitUserChoice('twin', convId, 'ask_sw1', [q('继续做A还是B')], sig);
  void waiterP.catch(() => {});

  console.log('[smoke-sleepwake] === 恢复分支（startWakeRecovery → emit("resume") → 广播）===');
  const broadcastEvents: { type: string; conversationIds?: string[] }[] = [];
  const broadcast = (ev: unknown) => broadcastEvents.push(ev as { type: string; conversationIds?: string[] });
  startWakeRecovery(broadcast as never);

  // 等价系统唤醒：触发 powerMonitor 的 'resume' 事件
  powerMonitor.emit('resume');

  const wakeEvt = broadcastEvents.find((e) => e.type === 'chat.wakeRecover');
  console.log(
    `[smoke-sleepwake] 唤醒后是否广播 chat.wakeRecover: ${!!wakeEvt}（convIds=${(wakeEvt?.conversationIds ?? []).join(',')}）`,
  );
  if (!wakeEvt || !wakeEvt.conversationIds?.includes(convId)) {
    throw new Error('恢复分支失败：唤醒未把在途对话推给渲染层');
  }
  console.log('[smoke-sleepwake] 恢复分支通过：在途对话被唤醒推给渲染层');

  console.log('');
  console.log('[smoke-sleepwake] === 放弃分支（用户放弃 → waiter 清掉、in-flight 释放）===');
  // 用户点「放弃这题」→ 前端 chatStore.abort → backend abortConversation（abortController.abort）→
  // 该 waiter 的 signal 被置位 → waiter reject 清掉 + 回合 interrupted 落盘后闸释放。
  //（smoke 用 beginDirectTurn 占闸、未真起 runner，abortController 不在 activeAbortControllers，
  //  故这里直接对 waiter 的 signal 触发 abort——等价于 abort 后的信号传播，验证放弃的落地语义。）
  const denyAc = new AbortController();
  const sig2 = denyAc.signal;
  const waiterP2 = awaitUserChoice('twin', convId, 'ask_sw1', [q('继续做A还是B')], sig2);
  void waiterP2.catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  const waitersBefore = listPendingWaiterConvs();
  console.log(
    `[smoke-sleepwake] 放弃前 该对话待答卡(waiter): ${waitersBefore.some((c) => c.conversationId === convId)}`,
  );
  denyAc.abort(); // 用户放弃 → signal 置位
  await waiterP2.catch(() => {}); // waiter reject
  const waitersAfter = listPendingWaiterConvs();
  const waiterGone = !waitersAfter.some((c) => c.conversationId === convId);
  console.log(`[smoke-sleepwake] 放弃后 该对话待答卡(waiter)是否清掉: ${waiterGone}`);
  await steeringQueue.handBackIfRunning(key, steeringQueue.runToken(key));
  const runningAfter = steeringQueue.isRunning(key);
  console.log(`[smoke-sleepwake] 放弃后 回合闸是否释放(running=false): ${!runningAfter}`);
  if (!waiterGone || runningAfter) {
    throw new Error('放弃分支失败：回合未释放/卡片未清');
  }
  console.log('[smoke-sleepwake] 放弃分支通过：回合中断、对话可发新消息');

  disposeWakeRecovery();
  settleUserChoice('ask_sw1', { answers: [{}] });
  await waiterP.catch(() => {});

  console.log('');
  console.log('[smoke-sleepwake] === 恢复 + 放弃 两分支均通过 ===');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[smoke-sleepwake] FAILED:', e);
    process.exit(1);
  });
