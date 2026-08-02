import { create } from 'zustand';
import { wsClient } from '@/lib/ws';

/**
 * 项目内文件存在性缓存——正文路径 chip 的第二道闸（fs.stat 探测，错误即不存在）。
 *
 * 正/负结果都按会话缓存：同一路径在长对话里反复出现，不重复打 stat。
 * 已知取舍：负缓存不随后续落盘失效——「提到时还不存在、后来才写出来」的早期消息
 * 保持普通 code（打开入口由回合产物条兜住），不为此接 fs.changed 失效链路。
 */
type PathExistsState = {
  /** key = `${projectId}:${relPath}` */
  known: Record<string, boolean>;
};

const inflight = new Set<string>();

export const usePathExistsStore = create<PathExistsState>(() => ({ known: {} }));

export function pathExistsKey(projectId: string, relPath: string): string {
  return `${projectId}:${relPath}`;
}

/** 未知且不在途时发起一次 stat 探测；结果落缓存驱动订阅方重渲染 */
export function ensurePathChecked(projectId: string, projectRoot: string, relPath: string): void {
  const key = pathExistsKey(projectId, relPath);
  if (key in usePathExistsStore.getState().known || inflight.has(key)) return;
  inflight.add(key);
  void wsClient
    .request({ type: 'fs.stat', filePath: `${projectRoot}/${relPath}` })
    .then(() => true)
    .catch((e: Error & { code?: string }) => {
      // 只有服务端权威答复（带结构化 code 的 error 回执）才算「不存在」；
      // 断连 / 超时等传输失败不是关于文件的事实，不落负缓存——下次渲染自然重试。
      return e.code ? false : undefined;
    })
    .then((exists) => {
      inflight.delete(key);
      if (exists === undefined) return;
      usePathExistsStore.setState((s) => ({ known: { ...s.known, [key]: exists } }));
    });
}

/** 仅测试用 */
export function __resetPathExistsForTest(): void {
  inflight.clear();
  usePathExistsStore.setState({ known: {} });
}
