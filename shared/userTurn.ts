import type { ChatMessage } from './types';

/** '（系统记：' 是数据哨兵（AI 产出的系统旁白前缀），自 proposals/systemEvent.ts 迁入——
 *  谓词与哨兵同居一处，口径不散。非界面文案，不翻译 i18n-exempt。 */
export const SYSTEM_NOTE_PREFIX = '（系统记：';

/** 一条消息是否「用户本人写的真实发言」——两个消费点共用同一口径：
 *  主进程记忆抽取按它数轮次；渲染层 ChatArea 置顶气泡按它挑候选。
 *  role=user、无机器 kind、有非空文本、非系统旁白。 */
export function isUserAuthoredMessage(m: ChatMessage): boolean {
  const t = m.text ?? '';
  return m.role === 'user' && m.kind == null && t.trim() !== '' && !t.startsWith(SYSTEM_NOTE_PREFIX);
}
