import { TAIL_CHARS } from './tabLayout';

/**
 * 中间省略：前段 truncate 吃掉省略号、后段固定吐尾部，保住 `-1.png` / `-v2.md` 这类唯一辨识位——
 * 一批同前缀文件掐尾巴会长得一模一样，标签就不再是标签了。标签栏与溢出菜单同用一套截断口径。
 *
 * 短到「头段至少还剩两个字符」都不成立时（≤ TAIL_CHARS + 2）直接整段显示：拆开只会得到
 * 一个空头段加一个原样尾段，白拆。
 */
export function MiddleTruncate({ text }: { text: string }): JSX.Element {
  if (text.length <= TAIL_CHARS + 2) return <span className="truncate">{text}</span>;
  return (
    // overflow-hidden：尾段是 shrink-0，窄到连它都放不下时（中文名尤其）由这里裁掉，
    // 而不是让内容顶出去压到邻居身上。
    <span className="flex min-w-0 items-center overflow-hidden">
      <span className="truncate">{text.slice(0, text.length - TAIL_CHARS)}</span>
      <span className="shrink-0">{text.slice(text.length - TAIL_CHARS)}</span>
    </span>
  );
}
