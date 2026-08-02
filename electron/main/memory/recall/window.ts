/**
 * 当前对话窗口的投影 —— 喂给召回挑选器的「洗过的对话」（recall tech-design §1.3）
 *
 * 不照搬 transcript，只留**真人 ↔ 助手的自然语言**：
 * - 保留：role=user / assistant 且 kind===undefined（普通文本消息）、text 非空。最新一条 user = 主查询信号。
 * - 天然剥掉：tool_result / tool_use 参数（不在 ChatMessage.text 里，只在 toolCalls，本函数只读 text）。
 * - 剥掉：一切卡片/脚手架（kind !== undefined：memory-record / proposal / subagent / aside-referent /
 *   turn-terminator …）、system 消息。
 *
 * 窗口有界（按字符预算从尾部保留最近几轮），够判断「话题此刻飘到哪」即可——这也是「延迟不随记忆
 * 变多而变长」的一环（候选简介可缓存，只这段每轮重算）。
 *
 * 注：recall tech-design §1.3 列的「剥上轮注入的记忆块+围栏」在 Oru 是死防御、不实现——召回块注入
 * systemContext（不进 history），而本函数输入是 history，上轮注入块根本进不到这里。
 */
import type { ChatMessage } from '@shared/types';
import type { RecallTurn } from '@shared/memory/recall';

const DEFAULT_MAX_CHARS = 6000;

export function projectConversationWindow(
  history: ChatMessage[],
  opts?: { maxChars?: number },
): RecallTurn[] {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;

  // 1. 投影：只留普通文本的真人↔助手轮
  const turns: RecallTurn[] = [];
  for (const m of history) {
    if (m.kind !== undefined) continue; // 卡片/脚手架（含 turn-terminator）一律剥
    if (m.role !== 'user' && m.role !== 'assistant') continue; // 剥 system
    const text = m.text.trim();
    if (!text) continue;
    turns.push({ role: m.role, text });
  }

  // 2. 按字符预算从尾部保留最近几轮（最新 user 是主查询信号，绝不丢——至少留最后一条）
  let used = 0;
  let start = turns.length;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    used += turns[i].text.length;
    if (used > maxChars && i < turns.length - 1) break;
    start = i;
  }
  return turns.slice(start);
}
