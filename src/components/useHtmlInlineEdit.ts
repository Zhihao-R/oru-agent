import { useEffect, useRef } from 'react';
import { wsClient } from '@/lib/ws';
import type { FsStatEvent } from '@shared/protocol';
import { ErrorCodes } from '@shared/types';

/**
 * HTML 预览「右键改字」写回回路（不 reload + 基线 + 降级回滚）。
 *
 * webview 内 preload（deckPreview.cjs）右键编辑 commit 时 sendToHost('inline:edited')；本 hook 在
 * 主窗口侧接住、直发 `fs.applyTextEdit` 落盘。单 html 文件没有 artifact，不走 artifactStore，
 * 直连 WS 内核（绝对 filePath）。
 *
 * 不 reload 是核心：写成功什么都不做——DOM 已是用户编辑后的最新，整页 reload 会把预览态打掉。
 * 失败按错误码分流回滚（DOM 不能领先磁盘）：
 *   - DEGRADED（定位降级）→ preload 'inline:editRejected' 回滚 + 提示改用 AI 改写
 *   - CONFLICT（基线失配，文件被外部改过）→ preload 'inline:editConflict' 回滚 + 提示先刷新
 *   - 其它（io/超时/断连/未知）→ preload 'inline:editFailed' 回滚 + 提示"请重试"
 *     （是临时错误，不能复用 DEGRADED 的"框选"文案，那会误导用户以为定位不到）
 *
 * 基线 mtime：打开取一次、每次写成功后再取一次（ack 不带 mtime，只能重 stat——
 * 取舍：connect 后到 stat 之间外部若改文件会偶发保守误判 conflict（安全方向），优于让基线漂移必失败）。
 */
export function useHtmlInlineEdit(absPath: string, wv: HtmlInlineEditWebview | null): void {
  // 基线 mtime：请求带 expectedMtimeMs 供 main 冲突校验。ref 而非 state——回调读最新值，
  // 且更新它不该触发重渲染（它纯粹是回路内部状态）。
  const baselineMtimeRef = useRef<number | null>(null);

  // 打开 / 换文件时取一次基线。htmlPath 变即重取（换了文件基线作废）。
  useEffect(() => {
    let alive = true;
    baselineMtimeRef.current = null;
    void wsClient
      .request<FsStatEvent>({ type: 'fs.stat', filePath: absPath })
      .then((r) => {
        // await 后重检：组件可能已卸载 / htmlPath 已变（cleanup 置 alive=false）——别把旧文件的 mtime 写进新基线
        if (alive && r.type === 'fs.stat.result') baselineMtimeRef.current = r.mtimeMs;
      })
      .catch(() => {
        // stat 抛错（路由对 stat 错误回 error/UNKNOWN 事件，wsClient 转 reject）：基线留 null，
        // applyTextEdit 不带 expectedMtimeMs → main 跳过冲突校验
      });
    return () => {
      alive = false;
    };
  }, [absPath]);

  // ipc-message 监听跟着 webview 元素走（参照 PreviewPane）：元素被换/卸载时 cleanup 摘除、新元素重挂。
  useEffect(() => {
    if (!wv) return;
    // 此 effect 的 alive：webview/htmlPath 变或卸载即置 false。refreshBaseline 收在 effect 内复用它——
    // 旧文件迟到的 stat 结果（切文件 / 卸载后才 resolve）绝不写进新文件基线（否则下次编辑带旧 mtime 必假 conflict）。
    let alive = true;

    // 写成功后刷新基线：直接 stat 拿最新 mtime（ack 不带 mtime）。与「打开取基线」是同一动作，收一处。
    const refreshBaseline = async (): Promise<void> => {
      try {
        const r = await wsClient.request<FsStatEvent>({ type: 'fs.stat', filePath: absPath });
        if (!alive) return; // 切文件/卸载后迟到的 stat：丢弃，不污染新基线
        if (r.type === 'fs.stat.result') baselineMtimeRef.current = r.mtimeMs;
      } catch {
        if (!alive) return;
        // 刷不到就置 null：下次编辑不带基线（跳过校验），好过沿用必失配的旧值
        baselineMtimeRef.current = null;
      }
    };

    const onMsg = async (ev: Event) => {
      const e = ev as unknown as { channel: string; args: unknown[] };
      if (e.channel !== 'inline:edited') return;
      const { markerId, oldText, newText } = e.args[0] as {
        markerId: string | null;
        oldText: string;
        newText: string;
        pageIndex: number;
      };
      try {
        await wsClient.request({
          type: 'fs.applyTextEdit',
          filePath: absPath,
          markerId,
          oldText,
          newText,
          // null=stat 没成功，不带基线让 main 跳过校验（undefined 字段不进 payload）
          ...(baselineMtimeRef.current !== null ? { expectedMtimeMs: baselineMtimeRef.current } : {}),
        });
        // 成功（ack）：DOM 已是最新，不 reload、不重渲染；只推进基线（自身这次写造成的 mtime 变化不该误判 conflict）
        await refreshBaseline();
      } catch (err) {
        const code = (err as { code?: string }).code;
        // 三类失败三种文案，都回滚 DOM（DOM 不能领先磁盘）：
        //   CONFLICT（文件被外部改过）→ editConflict「请刷新」
        //   DEGRADED（定位不到 / 歧义）→ editRejected「框选交给 AI 改」
        //   其它（io/超时/断连/未知，main 回 UNKNOWN）→ editFailed「请重试」——
        //     临时错误，提示框选会误导用户以为是定位问题
        const event =
          code === ErrorCodes.FS_TEXT_EDIT_CONFLICT
            ? 'inline:editConflict'
            : code === ErrorCodes.FS_TEXT_EDIT_DEGRADED
              ? 'inline:editRejected'
              : 'inline:editFailed';
        try { wv.send(event); } catch { /* webview 未 ready */ }
      }
    };
    wv.addEventListener('ipc-message', onMsg);
    return () => {
      alive = false;
      wv.removeEventListener('ipc-message', onMsg);
    };
  }, [wv, absPath]);
}

/** webview 元素：本 hook 只用 send() + ipc-message 监听（不 import 'electron' 类型，原因见 FileWebview 注释）。 */
export type HtmlInlineEditWebview = HTMLElement & { send(channel: string, ...args: unknown[]): void };
