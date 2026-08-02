/**
 * 对话级刹车——桌面按停 / 删除对话 / 远程 /stop 三入口共用的编排内核，与其收尾。
 *
 * 从 shared.ts 按内聚度拆出（D2(a)）。撤悬命令审批卡走 proposals/registry 的
 * cancelSubagentProposals（注册表已下沉到 proposal 子系统）。
 */
import type { Broadcast } from '../server';
import { resetAutoContinue } from '../../agent/autoContinue';
import { abortConversation } from '../../agent/runner';
import { drainLiveTurn } from '../../agent/liveTurnMark';
import { clearProcessingForItems } from '../../platform/channelProcessing';
import { steeringKey } from '../../agent/steeringQueue';
import { cancelTasksForConversation } from '../../tasks/subagentRunner';
import { cancelQueuedForConversation } from '../../tasks/queue';
import { killBashForConversation } from '../../proposals/executeBashProposal';
import { transitionProposal } from '../../proposals/lifecycle';
import { clearProjections } from '../../platform/approvalProjection';
import { cancelSubagentProposals } from '../../proposals/registry';
import { markAnnounced } from '../../tasks/store';
import { stopLoopForConversation } from '../../loop/registry';

/**
 * 用户主动取消任务的统一收尾（手动 task.cancel 与 chat.abort 对话级刹车共用）：
 * 撤掉该任务悬在主对话的命令审批卡 + markAnnounced 抑制播报轮——用户自己停的，
 * 别让 Oru 转头再起一轮说「任务被取消了」。对话内报告卡写不写的分叉不在这里：
 * runner 的取消路径自行区分（刹车静默 / 手动 task.cancel 保留失败卡）。
 */
export async function finalizeUserCancelledTask(taskId: string, broadcast: Broadcast): Promise<void> {
  cancelSubagentProposals(taskId, broadcast);
  await markAnnounced(taskId);
}

/**
 * 对话级刹车（理想架构 subagent.html#PFail）——桌面按停 / 删除对话 / 远程 /stop 三入口共用的
 * 编排内核。停当前轮 + 取消该对话派出的运行中任务（brakeCancelled 静默标记）+ 撤排队未起跑的
 * 派工 + 杀对话自己的后台 bash。呈现完全静默（PM 拍板）：编排层不追加对话消息，被刹任务也不写
 * 失败报告卡（runner 按刹车打标跳过），面板终态自然反映。
 *
 * 时序不变量：两个同步撤销（cancelTasks / cancelQueued）必须背靠背、中间零 await——被 abort 的
 * 任务 settle 时 runWithDequeue 的 finally 会推进队列，任何 await 间隙都可能让同对话排队项被提升
 * 起跑、两边都抓空。killBash 与撤下项的 pending→rejected 迁移同处这段同步段内。异步收尾（撤悬
 * 命令审批卡 + markAnnounced 抑制播报轮）跨 await，必须后置到同步撤销全部完成之后。
 *
 * UI 收尾（steering 未消费草稿交还输入框）不在此：仅桌面按停有输入框可交还，由 chat.abort
 * 自己 drain；远程无输入框、对话删除后对话已不存在，两者都无草稿可交还。
 */
export async function brakeConversation(
  agentId: string,
  conversationId: string,
  broadcast: Broadcast,
): Promise<void> {
  // 用户按停 / 删除 / 远程 /stop：重置断线自动接续预算——用户已介入，不再自动续写残局（S25）。
  resetAutoContinue(conversationId);
  // §3.2 loop 接管：该对话若有活 loop，stop 它（置 stopRequested + abort 编排）——先于 abortConversation，
  // 好让干活轮 abort、编排 catch 时 stopRequested 已为真，落 user-stopped 终态而非失败态。无活 loop 则 no-op。
  stopLoopForConversation(conversationId);
  // 停当前轮（既有 abortConversation 语义）
  abortConversation(agentId, conversationId);
  // custody 兜底清场（S1 review · I2）：连发撤起已过户、但新回合永不起跑（Esc 抢在 supersede 与
  // begin 之间 / 撤起后落盘失败）时，custody 里的渠道 origin 不属于队列项、无人清——「处理中」
  // 表情会永久悬挂。刹车即对话终止，已消费未交付的表情一律清、条目销。在跑回合的收尾清理幂等。
  clearProcessingForItems(drainLiveTurn(steeringKey(agentId, conversationId)).map((origin) => ({ origin })));
  // ── 同步撤销段（中间零 await，见上「时序不变量」）──
  const cancelledTaskIds = cancelTasksForConversation(conversationId);
  const dequeued = cancelQueuedForConversation(conversationId);
  // 对话自己的后台 bash（task 级的已在 cancelTask 内清）
  killBashForConversation(conversationId);
  // 撤下项走合法终态（拒绝=不执行）。pending 重检：abortConversation 的 turn 撤卡等不走队列的
  // 旁路可能已把它置成终态，重复迁移会 throw。
  for (const p of dequeued) {
    if (p.status === 'pending') transitionProposal(p, 'rejected', broadcast);
    clearProjections(p.id); // 刹车撤下的提案渠道投影一并清，防登记表泄漏
  }
  // ── 异步收尾（后置）──
  for (const taskId of cancelledTaskIds) {
    await finalizeUserCancelledTask(taskId, broadcast);
  }
}
