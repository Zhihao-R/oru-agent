/**
 * 记忆召回的可替换接口（PRD §6 的「选记忆/拼上下文」缝）
 *
 * 「选记忆」（收集候选 + 判断相关）与「拼上下文」（注入 + 围栏）之间这条缝定义成一个接口：
 * 内置流水线（BuiltinRecaller）是默认实现，后续可换成任意外部记忆服务，契约不变。
 *
 * **拼接与围栏不在 recaller 内**——recaller 只「选 + 给线索」，返回是不可信文本；
 * 编排层（runner）负责打围栏后再拼进上下文（PRD §6.2 防注入硬边界）。
 *
 * 与 AgentBackend 同哲学：依赖接口类型即让「加第二实现」零成本；本期只实现 BuiltinRecaller，
 * 不提前加工厂/配置选层（PRD §6「本期只立缝 + 内置实现」）。纯类型，不依赖任何 SDK。
 */

/** 喂给挑选器的对话窗口的一轮（真人 ↔ 助手自然语言投影，见 recall tech-design §1.3） */
export type RecallTurn = { role: 'user' | 'assistant'; text: string };

export type RecallQuery = {
  ownerId: string;
  /** 已洗过的当前对话窗口（projectConversationWindow 的产物） */
  conversationWindow: RecallTurn[];
  /**
   * 当前项目 id（结构粗筛的「当前项目」硬维度，PRD §5.4 / G20）——按归属圈定候选：
   * 保留全局条目 + 该项目条目，排除明确属于其他项目的。空（无当前项目 / 自由聊天 / 渠道回合）
   * 时只圈全局条目。缺省 undefined 等同「无当前项目」。
   */
  activeProjectId?: string | null;
};

/** 选中的一条记忆——用户记忆页里真实存在、可看可删的那一条，原样全文注入（不改写不压缩） */
export type RecalledMemory = { relPath: string; body: string };

/** 线索（PRD §6.1）：排序时阈值正下方那几条 near-miss 邻居的标题；计数 N = neighbors.length */
export type RecallHint = { neighbors: string[] };

export type RecallResult = { selected: RecalledMemory[]; hint?: RecallHint };

export interface MemoryRecaller {
  recall(query: RecallQuery, signal?: AbortSignal): Promise<RecallResult>;
}
