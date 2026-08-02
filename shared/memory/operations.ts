/**
 * 统一的记忆写入操作代数
 *
 * record_memory（用户即时声明）、capture subagent（周期抓取）、dream（复盘升格）
 * 三条写入路径共用同一套 MemoryOp，差异通过 applyOps 的 origin 白名单实现。
 *
 * 加第四条写入路径时，新增 origin 白名单一行即可，不必扩 schema。
 */
import type { EpisodeType } from '../types';

/** create-episode / supersede / correct 共用的 episode 数据 payload */
export type EpisodeCreatePayload = {
  scope: 'agent' | 'project';
  projectId?: string; // scope=project 时必填
  type: EpisodeType;
  title: string;
  slug: string;         // 拉丁字符小写连字符；后端可从 title fallback
  description: string;  // ≤30 字
  tags?: string[];
  content: string;      // episode 正文
  sources?: string[];   // 关联对话 convId
  /**
   * 用户在对话中明确要求记住 → frontmatter.source = 'user-direct'，缺省 = 机器自动（twin-auto）。
   * 标记只承载「用户亲口嘱记过」这个痕迹：夜间整理据此优先保留其原话，但**不禁止任何操作**
   * （据此拒绝 dream 校对/淘汰/合并的硬护栏已于 2026-07-28 拆除，理由见
   * docs/plans/2026-07-28-长会话质量盘点与修复-plan.md 的「记忆合并护栏把方向逼反」）。
   * supersede/correct 时非 true（含显式 false）一律继承旧条标记——false 是
   * "这次不是用户要求"，不是"撤销这个痕迹"（applyOps 落实）。
   */
  userRequested?: boolean;
};

export type MemoryOp =
  // Episode 写入（capture / record 用）
  | { op: 'create-episode'; payload: EpisodeCreatePayload }
  | { op: 'supersede-episode'; oldPath: string; payload: EpisodeCreatePayload }
  // evidence：dream 纠错必填的原文佐证（引用来源对话原文）。只进 changelog，
  // 不落 episode 文件——审计材料与记忆内容分离。capture/record 路径不传。
  | { op: 'correct-episode'; oldPath: string; payload: EpisodeCreatePayload; evidence?: string }
  // Episode 整理（dream 用）：newBody 可选——把 mergeFrom 的互补内容捏进 mergeInto 的一份
  // 综合正文，避免"合并=丢正文"。不传则 mergeInto 正文原样保留（仅适合字面重复的去重）。
  | {
      op: 'merge-episodes';
      mergeInto: string;
      mergeFrom: string[];
      newDescription?: string;
      newBody?: string;
    }
  // Episode 淘汰（dream 用）：status 标 retired 移出活跃召回，不物理删除
  | { op: 'retire-episode'; path: string; reason: string };
// 注：user/self/项目档案的「定区段增改删覆盖」op（add-user-fact / write-user-portrait /
// append-agent-persona / *-project-* …）已全部退役——这三类档案统一走文档模型（write_memory /
// edit_memory + parseProfileDoc，自由分章、永不丢小节）。MemoryOp 现在只承载带索引的 episode 结构化记录。

export type MemoryOpName = MemoryOp['op'];

/**
 * 写入路径的来源标识——决定 op 白名单：
 * - record: 主对话 Twin 通过 record_memory / edit_memory 工具调
 * - capture: 后台 capture 子代理（对话结束抓 episode）
 * - dream: 后台 dream 子代理（复盘升格画像）
 * - ui: 前端 MemoryPage 用户直接编辑
 */
export type MemoryOpOrigin = 'record' | 'capture' | 'dream' | 'ui';

/**
 * 每条写入路径允许使用的 op 子集——隔离意图就是"加 op 时显式想哪个 origin 该有"。
 * 不要把"两边都用"当默认；同 op 出现在两个白名单是有意识的共用，不是疏忽。
 */
export const OP_WHITELIST: Record<MemoryOpOrigin, ReadonlySet<MemoryOpName>> = {
  // 档案类 op 已退役（profile/self/项目走文档模型）；MemoryOp 现在只剩 episode 结构化 op。
  // record（对话侧）：建/取代/纠正/退休全都可做——用户在场，correct/retire 对话侧开放（S35·G102），
  // 纠正强制附依据由工具层强制（S35·G68），写闸由既有挡位闸承接。
  record: new Set<MemoryOpName>([
    'create-episode',
    'supersede-episode',
    'correct-episode',
    'retire-episode',
  ]),
  // capture（后台抽取·通道二）只能追加事件（S35·G67）：无当场语境也无全局视角，无权纠正/取代旧事件。
  // 权限跟着判断力走——纠正/取代交给对话侧（有语境）或 dream（有全局视角）。
  capture: new Set<MemoryOpName>(['create-episode']),
  dream: new Set<MemoryOpName>(['merge-episodes', 'correct-episode', 'retire-episode']),
  // 前端记忆页改走文档模型（memory.doc.write），不再发任何 op；'ui' origin 现无可用 op。
  ui: new Set<MemoryOpName>([]),
};

/** applyOps 返回结果——每个 op 一条 */
export type OpResult =
  | {
      op: MemoryOpName;
      ok: true;
      detail?: string;
      /**
       * 子串匹配类 op（update-* / remove-*）专用：旧文本有没有命中。
       * 调用方判断"是改了还是没改"必须看这个字段——不要 grep detail 字符串。
       */
      matched?: boolean;
    }
  | { op: MemoryOpName; ok: false; error: string };

export type ApplyResult = {
  results: OpResult[];
  okCount: number;
  errCount: number;
};
