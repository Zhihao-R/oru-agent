/**
 * 会话污染检测（G54）——托管后端 resume 的 session 被毒块卡住后永久 400 的判定与信号。
 *
 * 背景：CLI 在调 API 前就把 prompt 落进 session；一旦落进空文本块 / 半截工具调用等非法块，
 * 后续每次 resume 续传都以同样的 400 失败，用户只能手动清空对话重来（记忆见
 * project_claudecode_session_poison、docs/bug/2026-06-09）。源头预防已有（组装滤空块、
 * 半截工具调用合成回执），本模块补「检测到污染 → 自动弃号重灌同路径」的治。
 *
 * 判定放在 backend 事件层而非 runner catch：主对话恒挂 hasPendingSteering 走活流，活流下 API
 * 错误由 SDK 以 result 事件浮出（isError 汇总进返回值、不抛），catch 永远接不到。detectSessionPoison
 * 在事件管道扫描 result，命中即抛 SessionPoisonError，runner 的重试 catch 据此清号重灌。
 *
 * fail-closed：匹配不上的错误照常以 result 浮出，绝不把普通报错误当污染吞掉重跑。模式清单以真机
 * 实测文案为准，按需补充（动手前造一个毒化 session 核实浮出形态）。
 */

/** 会话污染——resume 的厂商会话被毒块卡住，须弃号重灌。runner 重试 catch 据类型识别。 */
export class SessionPoisonError extends Error {
  /** 原始毒化文案，供 debugLogger 留痕、排查模式清单漏配 */
  readonly rawText: string;
  constructor(rawText: string) {
    super(`session poisoned: ${rawText.slice(0, 200)}`);
    this.name = 'SessionPoisonError';
    this.rawText = rawText;
  }
}

/**
 * 毒化模式清单（首批，按实测补充）：
 * - 空文本块类：`text content blocks must be non-empty`（Anthropic 400 原文）
 * - tool_use / tool_result 配对错误类：半截工具调用留下孤块
 */
const POISON_PATTERNS: RegExp[] = [
  // 空文本块类——两条均为 2026-07-01 飞书空消息事故实测浮出文案（docs/tech/2026-07-02-feishu-*、
  // 记忆 project_claudecode_session_poison）；空块落在哪决定报哪条。
  /content blocks? must be non-empty/i,
  /cache_control cannot be set for empty text blocks/i,
  // tool_use / tool_result 配对错误类
  /tool_use\b[^]*\bwithout[^]*\btool_result/i,
  /tool_result\b[^]*\bwithout[^]*\btool_use/i,
  /unexpected `?tool_use`?/i,
];

/** 文案是否匹配已知毒化模式。fail-closed：不匹配返回 false（照常当普通报错浮出）。 */
export function isSessionPoisonText(text: string): boolean {
  if (!text) return false;
  return POISON_PATTERNS.some((re) => re.test(text));
}
