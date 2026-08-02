/**
 * 外发送达痕迹（S26 · G75）——approval.html「外发闸在唯一出口收口」的「落本地历史」半。
 *
 * 批准的 bash 外发（lark-cli 发消息 / curl 送数据）由命令行子进程自行发出，正文抠不出、无法真正
 * 汇入送达内核重发（PM 2026-07-12 拍板「加固现有出口」而非彻底改道）。加固的一环：外发命令跑完
 * 追加一条本地痕迹（渠道 + 收件人 + 时间 + 来源对话），让「往哪发过东西」可审计——与平台回复出口
 * 的「内容进对话历史」形成对称的留痕。
 *
 * append-only JSONL 审计日志（非全量重写，用 appendFile 而非 safeWrite）；留痕是非承重副作用，
 * 故障只 warn 不抛（不该因写不了日志崩掉外发回合）。字段刻意通用（via 区分命令/回复），送达内核
 * 回复出口将来要统一留痕零成本。
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { userDir } from '../runtime/paths';

export type OutboundTrace = {
  /** 送达时刻（epoch ms，调用方传入）。 */
  ts: number;
  /** 记录归属的主人——痕迹与全仓 user-scoped 布局一致，落 userDir(ownerId) 下。 */
  ownerId: string;
  /** 渠道（feishu / discord / web…）。 */
  channel: string;
  /** 收件人（群 id / open_id / host…）；提不出为 null。 */
  recipient: string | null;
  /** 触发外发的对话。 */
  conversationId: string;
  /** 出口来源：命令行外发 / 平台回复出口。 */
  via: 'command' | 'reply';
};

/** 追加一条外发痕迹到 ~/.oru/users/<ownerId>/outbound-history.jsonl。故障只 warn 不抛（留痕是副作用，不阻塞外发回合）。 */
export async function recordOutbound(trace: OutboundTrace): Promise<void> {
  const log = join(userDir(trace.ownerId), 'outbound-history.jsonl');
  try {
    await fs.mkdir(dirname(log), { recursive: true }); // 与 writeOutputCache 一致，先确保目录在
    await fs.appendFile(log, JSON.stringify(trace) + '\n', 'utf-8');
  } catch (e) {
    console.warn('[outbound-history] 追加外发痕迹失败（不阻塞）:', e);
  }
}
