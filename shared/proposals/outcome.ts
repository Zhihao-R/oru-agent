/**
 * 装卸类提案的执行结果——纯执行内核（perform*）与 chip 落点之间的数据形状。
 *
 * 住在 shared 是因为工具侧要经 ToolContext 回调把它递出去（backend.ts 引不到 electron/）。
 * 文案不在这里：warnings 只带结构化的 code + names，译词收在 chip 落点一处按 owner 语言做。
 */

/** 装了但有非致命问题。 */
export type ProposalWarning =
  | { code: 'mcp-conflict-skipped'; names: string[] }
  | { code: 'mcp-start-failed'; names: string[] };

export type ProposalOutcome =
  | {
      ok: true;
      /** perform 拿到的真实显示名（如 plugin manifest 里的名字）；缺省用提案自带的。 */
      name?: string;
      warnings?: ProposalWarning[];
    }
  | { ok: false; error: string };
