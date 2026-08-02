import { describe, expect, it } from 'vitest';
import { pipeSdkToEvents } from '../../electron/main/agent/stream';
import { IdleTimeoutError } from '../../electron/main/agent/util/retry';
import type { EngineEvent } from '../../electron/main/engine/types';

// 构造一个最小 StreamCtx：emit 收事件但不校验，ownerId/agentId 用假值；
// 测试里工具结果都很小，不触发 shouldPersist 落盘，所以不碰文件系统。
function makeCtx() {
  return {
    conversationId: 'c1',
    messageId: 'm1',
    ownerId: 'u1',
    agentId: 'a1',
    emit: () => {},
  };
}

describe('pipeSdkToEvents partial 捕获', () => {
  it('事件流中途抛错时，partial 保留已成形的文字和已发起的工具调用', async () => {
    async function* events(): AsyncGenerator<EngineEvent> {
      yield { type: 'assistant_text', text: '我来写这个文件' };
      yield { type: 'tool_use', id: 't1', name: 'write_file', input: { path: '/x.html' } };
      throw new IdleTimeoutError(60000); // 模拟上游挂死
    }
    const partial = { resultText: '', toolCalls: [] as Array<{ name: string; result?: unknown }> };
    await expect(pipeSdkToEvents(events(), makeCtx() as never, partial as never)).rejects.toThrow(
      IdleTimeoutError,
    );
    expect(partial.resultText).toBe('我来写这个文件');
    expect(partial.toolCalls).toHaveLength(1);
    expect(partial.toolCalls[0].name).toBe('write_file');
    expect(partial.toolCalls[0].result).toBeUndefined(); // 悬空：发起了但没拿到结果
  });

  it('正常跑完时也同步 partial，与返回值一致', async () => {
    async function* events(): AsyncGenerator<EngineEvent> {
      yield { type: 'assistant_text', text: '完成了' };
      yield { type: 'result', resultText: null, isError: false };
    }
    const partial = { resultText: '', toolCalls: [] as unknown[] };
    const out = await pipeSdkToEvents(events(), makeCtx() as never, partial as never);
    expect(partial.resultText).toBe(out.resultText);
    expect(partial.resultText).toBe('完成了');
  });
});
