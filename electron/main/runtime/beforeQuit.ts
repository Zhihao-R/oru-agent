/**
 * before-quit 编排（从 index.ts 抽出以便单测一次性语义）。
 *
 * 流程：第一次触发 → 停副作用源（timer / ws）→ preventDefault → 异步落盘 → quit()。
 * quit() 会再次触发 before-quit——quitting 守卫直接放行让退出生效，停操作与落盘
 * 都不重复执行。停操作必须在守卫**之内**：放守卫前会在第二次触发时重复执行
 * （stop 已停的东西、关已关的 server）。
 */
type BeforeQuitDeps = {
  /** 同步停掉的副作用源（idle announcer / dream 调度 / ws server） */
  stops: Array<() => void>;
  /** 退出前必须真等完的落盘工作（deck pending commit / access log / MCP 关停 / debug drain） */
  flush: () => Promise<void>;
  quit: () => void;
};

export function createBeforeQuitHandler(
  deps: BeforeQuitDeps,
): (e: { preventDefault(): void }) => void {
  let quitting = false;
  return (e) => {
    if (quitting) return;
    quitting = true;
    for (const stop of deps.stops) stop();
    // 落盘工作得真等完——否则 fire-and-forget 没意义，正常退出仍丢数据。
    // kill -9 / crash 仍会丢，那是 OS 层面，parseNdjson 跳坏行兜底处理。
    e.preventDefault();
    void (async () => {
      try {
        await deps.flush();
      } catch (err) {
        // flush 意外 reject 也必须 quit——否则首次 Cmd+Q 静默失效，要按第二次才退得出去
        console.error('[before-quit] 落盘收尾失败（仍继续退出）:', err);
      }
      deps.quit();
    })();
  };
}
