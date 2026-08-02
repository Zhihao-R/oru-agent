import type { ChatRef } from '@shared/types';

/**
 * 把 composer 里的引用 chip 渲染成只读上下文块，拼进最终发给模型的消息。
 *
 * 每条引用 = 一段 markdown 引用块（逐行 `> ` 前缀）+ 一行「来源: path[:line]」，
 * 让模型清楚这是用户从某文件选来的原文、而非要执行的指令。无 ref 时原样返回 draft。
 *
 * 形态（draft 非空时）：
 *   > 引文第一行
 *   > 引文第二行
 *   来源: q2-复盘/.narrative.md:12
 *
 *   <draft>
 */
export function buildMessageWithRefs(draft: string, refs: ChatRef[]): string {
  if (refs.length === 0) return draft;
  const blocks = refs.map(renderRef).join('\n\n');
  return draft ? `${blocks}\n\n${draft}` : blocks;
}

// 注：「引用文件:」「来源:」是消息内容——chatStore.send 的 finalText 既进用户自己的气泡
// （appendUserMessage）又发 wire（chat.send），二者必须一致（见 chatStore 注释）。因这条 wire==display
// 硬约束，整体作为消息内容固定中文、不随界面语言翻译（翻显示就改了 AI 收到的 wire 与落进历史的内容）。
// 留下的张力：英文用户引用文件后自己气泡里会看到中文前缀——属 UX 决策，待文案/脚手架分离专项（见汇报）。
function renderRef(ref: ChatRef): string {
  // 整文件引用：只带路径让 agent 用读文件工具去读（不内联全文，防大文件撑爆消息），不渲染 blockquote
  if (ref.kind === 'file') return `引用文件: ${ref.sourcePath}`;
  // 选段引用（缺省 / 'quote'）：blockquote + 来源行，形态不变（无回归）
  const quoted = ref.quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const source = ref.line != null ? `${ref.sourcePath}:${ref.line}` : ref.sourcePath;
  return `${quoted}\n来源: ${source}`;
}
