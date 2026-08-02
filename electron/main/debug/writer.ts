/**
 * NDJSON 落盘 writer —— 全局串行队列
 *
 * 设计权衡（详见 docs/tech/2026-05-10-debug-module-tech-design.md §4.4）：
 * - 不分 per-conversation 队列：单条 append 几十微秒级，多 conversation 同时跑
 *   的场景几乎不存在；维护 Map<conversationId, AsyncQueue> 反而带来 drain loop
 *   管理 / 句柄池 / close 信号传递等复杂度，性价比极低。
 * - drain loop 主动 polling，不依赖 AsyncIterable close 协议——零死锁风险。
 * - kill -9 / Electron crash 时积压 records 必然丢失、文件可能截断在某行 JSON
 *   中间——这是落盘类 logger 的固有限制，解法在读侧（parseNdjson 跳坏行）。
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { DebugRecord } from '@shared/debug/types';
import { debugConvFile } from '../runtime/paths';
import { dateKey } from './retention';
import { redact } from './redact';

export class DebugWriter {
  private queue: DebugRecord[] = [];
  private wakeup: (() => void) | null = null;
  private handles = new Map<string, FileHandle>();
  private closed = false;
  private drainPromise: Promise<void>;

  constructor() {
    this.drainPromise = this.drain();
  }

  /** 主路径调用：O(1)，零阻塞 */
  enqueue(rec: DebugRecord): void {
    if (this.closed) return; // use-after-close 保护
    this.queue.push(rec);
    this.wakeup?.();
  }

  /** 等待所有积压 record 落盘后关闭句柄。重复调用幂等 */
  async flushAndClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.wakeup?.();
    await this.drainPromise;
    for (const h of this.handles.values()) {
      try {
        await h.close();
      } catch {
        // 关闭失败吞掉：句柄反正进程退出会回收
      }
    }
    this.handles.clear();
  }

  private async drain(): Promise<void> {
    while (!this.closed || this.queue.length > 0) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.wakeup = resolve;
        });
        this.wakeup = null;
        continue;
      }
      const rec = this.queue.shift()!;
      try {
        const path = debugConvFile(rec.ownerId, dateKey(rec.ts), rec.conversationId);
        const handle = await this.getHandle(path);
        await handle.appendFile(JSON.stringify(redact(rec)) + '\n');
      } catch (e) {
        // debug 模块 die quietly：吞错不影响主对话
        console.warn('[debug.writer] append failed', e);
      }
    }
  }

  private async getHandle(path: string): Promise<FileHandle> {
    let handle = this.handles.get(path);
    if (handle) return handle;
    await fs.mkdir(dirname(path), { recursive: true });
    handle = await fs.open(path, 'a');
    this.handles.set(path, handle);
    return handle;
  }
}
