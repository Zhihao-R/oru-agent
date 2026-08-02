/**
 * 脏文件集 —— 实时落盘后，md 编辑器已无「未保存草稿」概念（停手即落、失焦立即落）。
 * 仅表格（tableStore，步骤3 前仍保留草稿）可能持有未落盘改动。
 *
 * 出口闸门（main dirtySet 查询）的语义随之反转：从「拦住 AI、让用户先 ⌘S」改为
 * 「先把渲染端 pending 落盘、再放行」——AI 读磁盘即最新，不再需要拦截（详技术设计 §6 守卫放宽）。
 */
import { useMemo } from 'react';
import { textsReferenceFile } from '@shared/fileRefMatch';
import { wsClient } from '@/lib/ws';
import { basename } from '@/lib/paths';
import { useEditorStore } from '@/stores/editorStore';
import { useTableStore } from '@/stores/tableStore';

export function getDirtyPaths(): string[] {
  // md 编辑器实时落盘，无脏文件；仅表格可能未落盘——多标签下逐个打开的表收集脏 path
  return Object.entries(useTableStore.getState().tables)
    .filter(([, t]) => t.dirty)
    .map(([path]) => path);
}

/** 提案卡阻断态：仅表格的未保存改动会拦提案；md 实时落盘不再参与。 */
export function useDirtyFileHit(texts: string[]): string | null {
  // 任一打开的表有未落盘改动 + 被 proposal 文本引用 → 取第一个命中的
  const tbPath = useTableStore((s) =>
    Object.entries(s.tables).find(([, t]) => t.dirty)?.[0] ?? null,
  );
  return useMemo(() => {
    if (tbPath && textsReferenceFile(texts, tbPath)) return basename(tbPath);
    return null;
    // texts 来自 proposal 字段，渲染间稳定；join 作为比较键
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tbPath, texts.join('\n')]);
}

let bound = false;
/** test-only：重置一次性绑定守卫，便于残留 bound 状态的新旧用例各自独立跑。 */
export function __resetBindRendererQueriesForTest(): void {
  bound = false;
}

/**
 * flush 等待的应答兜底 cap（2026-08-02「编辑器无响应」闸门修复；方案见
 * docs/notes/2026-08-02-editor-unresponsive-gate-fix-plan.md 路线 X）。
 *
 * 钉死 1200ms：必须严格小于 main 侧 DISCLAIMER 里的闸门查询上限（DEFAULT_TIMEOUT_MS=2000，
 * 见 electron/main/agent/rendererQuery.ts），留 800ms 给响应回程 + ack 往返 + 调度抖动。
 * 不允许贴边——会撞 main 2s reject 走「编辑器无响应」保守拦截。未来任何执行点把闸门
 * timeoutMs 改小，须同步收紧本 cap，保持「严格小于」。
 *
 * 语义边界（有意取舍）：flush 未在 cap 内 resolve 时，本处只等到 cap 就返回**当前**
 * getDirtyPaths() 应答——闸门保护时效从「磁盘必最新」退化为「≤cap 前脏集」，极端可能漏拦。
 * 这是 X 接受的结果：cap 窗口内 flush 大概率完成，超时的少数场景宁快不卡。
 */
const FLUSH_ANSWER_CAP_MS = 1200;

/** 一次性绑定：应答 main 的 renderer.query（kind=dirtySet）。先 flush 编辑器 pending 再报脏集。 */
export function bindRendererQueries(): void {
  if (bound) return;
  bound = true;
  wsClient.subscribe((ev) => {
    if (ev.type !== 'renderer.query' || ev.kind !== 'dirtySet') return;
    void (async () => {
      // 实时落盘语义：AI 动手前先把所有编辑器 + 表格 pending 落盘，保证它读到磁盘即最新。
      // queryResult 必须无条件发出：这是 main 侧闸门的取答口，flush 失败 / 挂起也照常回脏集——
      // 若因为 flush 未预期 reject（或 conflictCard/encodingSafe 确认框挂起不 resolve）而掐断应答，
      // main 只能等 2s 超时走「编辑器无响应」保守拦截，闸门被卡死。
      // 用 race 兜底：flush 完成或 cap 到期取先者，cap 到期走当前脏集照常应答。
      // flush 是否真落盘是另一层健壮性（两 store 内各自 try/catch），不应反噬应答链。
      // 单个 cap timer + resolve 标记（方案正文给的替代实现）：flush 先完成或 cap 到期取先者。
      // 任一分支 settle 后 finally 清掉 timer——成对清理，避免高频调用残留 pending one-shot timer。
      // cap 到期以 resolve 收场：不 reject——否则同样掐断应答，只是换了个错误。
      let capSettle: (() => void) | null = null;
      const capTimer = setTimeout(() => capSettle?.(), FLUSH_ANSWER_CAP_MS);
      try {
        await Promise.race([
          Promise.all([
            useEditorStore.getState().flushAll(),
            useTableStore.getState().flushAll(),
          ]),
          new Promise<void>((resolve) => {
            capSettle = resolve;
          }),
        ]);
      } catch {
        // flush 失败：跳过落盘，仍按脏集如实应答（脏标志未清，AI 照样被拦——过滤器语义不破）
      } finally {
        clearTimeout(capTimer);
      }
      await wsClient
        .request({ type: 'renderer.queryResult', queryId: ev.queryId, result: { paths: getDirtyPaths() } })
        .catch(() => {});
    })();
  });
}
