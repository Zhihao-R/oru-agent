/**
 * splitSystemForCache —— 把 system context 拆成 stable + dynamic 两段。
 *
 * 用途：让需要显式 cache breakpoint 的 backend（Anthropic 直连 / OpenRouter
 * 转发到 Anthropic/Qwen/etc）能精确在 stable 段末尾打 cache_control。
 * 各 backend 自己包装成对应 wire 形态。
 *
 * 不变量：runner.ts 拼接 systemContext 时保证 systemContext.startsWith(stableSystemContext)。
 * 若违反（编程错误），保底返回 {stable:'', dynamic: full}——整段当动态、不命中缓存
 * 但不破坏请求。
 */
export type SystemSplit = { stable: string; dynamic: string };

export function splitSystemForCache(full: string, stable: string | undefined): SystemSplit {
  if (!stable || stable.length === 0) return { stable: '', dynamic: full };
  if (!full.startsWith(stable)) return { stable: '', dynamic: full };
  return { stable, dynamic: full.slice(stable.length) };
}

/**
 * 两层缓存切分（快照进缓存）。前缀关系：stable ⊆ sessionStable ⊆ full。
 * - stable：人设等"agent 生命周期稳定"内容——子 agent 也复用这段缓存（第一个 cache breakpoint）。
 * - sessionExtra：sessionStable 比 stable 多出的"会话级稳定"增量（能力 prompt + 记忆快照）（第二个 breakpoint）。
 * - dynamic：每轮变化的尾部（当前时间等），不缓存。
 *
 * 为什么要两段而非把快照并进 stable：子 agent fork 的是纯 stable（不含快照），靠命中主对话的
 * stable 缓存省钱。若主对话只在"含快照"处打一个缓存点，子 agent 的纯 stable 前缀就命中不了。
 * 两个 breakpoint 让主对话同时缓存 [stable] 与 [stable+快照]——子 agent 复用前者、主对话读后者。
 *
 * 任一前缀关系不成立（编程错误）→ 优雅退化（退回单层 / 整段动态），不破坏请求。
 */
export type SystemTwoTierSplit = { stable: string; sessionExtra: string; dynamic: string };

export function splitSystemForTwoTierCache(
  full: string,
  stable: string | undefined,
  sessionStable: string | undefined,
): SystemTwoTierSplit {
  const base = splitSystemForCache(full, stable);
  if (!base.stable) return { stable: '', sessionExtra: '', dynamic: full };
  // 无 sessionStable / 与 stable 相同 / 前缀关系不成立 → 退回单层（sessionExtra 空）
  if (
    !sessionStable ||
    sessionStable === base.stable ||
    !sessionStable.startsWith(base.stable) ||
    !full.startsWith(sessionStable)
  ) {
    return { stable: base.stable, sessionExtra: '', dynamic: base.dynamic };
  }
  return {
    stable: base.stable,
    sessionExtra: sessionStable.slice(base.stable.length),
    dynamic: full.slice(sessionStable.length),
  };
}

export type CachedSegment = { text: string; cached: boolean };

/**
 * 把 system context 切成有序的"缓存段 / 动态段"序列，供 backend 映射成各自 wire 形态
 * （cache_control 标记）。cached 段对应一个 cache breakpoint。
 * 空段不产出；全空（不应发生）兜底为单段未缓存 full。
 */
export function cachedSystemSegments(
  full: string,
  stable: string | undefined,
  sessionStable: string | undefined,
): CachedSegment[] {
  const { stable: s, sessionExtra, dynamic } = splitSystemForTwoTierCache(full, stable, sessionStable);
  const segs: CachedSegment[] = [];
  if (s) segs.push({ text: s, cached: true });
  if (sessionExtra) segs.push({ text: sessionExtra, cached: true });
  if (dynamic) segs.push({ text: dynamic, cached: false });
  return segs.length > 0 ? segs : [{ text: full, cached: false }];
}
