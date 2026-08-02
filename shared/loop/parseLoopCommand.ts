/**
 * /loop 命令解析（决策 7：只接 /loop 一个，不建通用命令注册表——没有第二命令前不为想象的命令系统设计）。
 *
 * 入口统一手动：前端按钮把 `/loop ` 填到输入框开头，用户接着写目标；发送时 render 端识别
 * "以 /loop 开头的发送"转成带 loop 意图的请求。本函数是那道识别的纯函数核——单独 TDD。
 *
 * 2026-07-28 从 electron/main/loop/ 迁入 shared/：主进程（chat.ts 入口 / 排队转投）与渲染层
 * （输入框摘标签 / 气泡摘徽章）此前各写一份 `/loop` 边界正则、靠注释手工对齐——收敛到本文件
 * 单源，对齐由 import 保证。
 *
 * 技术设计：docs/tech/2026-06-19-loop-mode-tech-design.md 决策 7。
 */

export type LoopCommand = {
  /** 是不是 /loop 命令（边界：/loop 后必须接空白或字符串结束，/loopback 不算）。 */
  isLoop: boolean;
  /**
   * loop 模式：剥掉 /loop 前缀后的目标。非 loop：原文 trim。
   * 可空（用户只打了 /loop 没带目标）——此时 router 不启编排，原文落普通 chat（按钮总会带尾空格，
   * 裸 /loop 是用户删掉目标的边角，不值得为它单建提示路径）。
   */
  goal: string;
};

const LOOP_PREFIX = /^\/loop(?:\s+(.*))?$/s;

/**
 * 输入框「打字中前缀识别」：值以 `/loop` + 分隔空白开头时匹配前缀段（消费方摘成标签、
 * 用 `value.slice(match[0].length)` 保留其余原文）。边界与 parseLoopCommand 一致
 * （须接空白，`/loopback` 不算；打到一半的 `/loop` 未现分隔空白不触发）。
 */
export const LOOP_TYPED_PREFIX = /^\/loop\s+/;

export function parseLoopCommand(input: string): LoopCommand {
  const text = input.trim();
  const m = LOOP_PREFIX.exec(text);
  if (!m) return { isLoop: false, goal: text };
  return { isLoop: true, goal: (m[1] ?? '').trim() };
}
