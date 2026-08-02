/**
 * 斜杠命令解析（tech design §4.3）——跨平台同源：飞书 / Discord 的 normalize 与桌面输入框
 * 快捷输入都调它，不在各端各写一份（系统性）。只认白名单内的命令，未知斜杠词不当命令
 * （避免把 /foo 误当能力）。命令的结构化类型定义在 shared/platform/message.ts（PlatformCommand）；
 * 带参命令（/mode /model）的取参集中在这里，gateway / 桌面调度层只消费不再二次解析。
 */
import type { PlatformCommand } from './message';
import type { ApprovalMode } from '../types';

// Partial：非法 key 取值为 undefined 是承重路径（→ mode: null → gateway 回用法），
// 类型上显形，别让读者以为 MODES[key] 恒有值。
const MODES: Partial<Record<string, ApprovalMode>> = { readonly: 'readonly', work: 'work', danger: 'danger' };

export function parseCommand(text: string): PlatformCommand | undefined {
  const m = text.trim().match(/^\/(\w+)(?:\s+(\S+))?/);
  if (!m) return undefined;
  const c = m[1]!.toLowerCase();
  if (c === 'stop' || c === 'new' || c === 'status' || c === 'help') return { kind: c };
  // /compact 是 /compress 的别名：解析层归一，下游无感
  if (c === 'compress' || c === 'compact') return { kind: 'compress' };
  // /mode <挡位>：参数缺失 / 非法 → mode: null，由 gateway 回用法提示（不静默放过）
  if (c === 'mode') return { kind: 'setMode', mode: MODES[(m[2] ?? '').toLowerCase()] ?? null };
  // /model [编号]：无参 index: null 列清单；参数非数字 → invalid: true 回用法提示
  // （不静默列清单——用户明明想切却被列单，是错误吞并）。编号超界由 gateway 判（它才知道清单长度）。
  if (c === 'model') {
    const arg = m[2];
    if (arg === undefined) return { kind: 'model', index: null, invalid: false };
    const index = /^\d+$/.test(arg) ? parseInt(arg, 10) : NaN;
    return Number.isNaN(index)
      ? { kind: 'model', index: null, invalid: true }
      : { kind: 'model', index, invalid: false };
  }
  return undefined;
}
