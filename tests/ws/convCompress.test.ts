/**
 * conv.compress 路由层回归（斜杠命令补全 plan §4）——桌面 /compress 的 ws 入口：
 * 四态（compressed/busy/empty/failed）正确映射进回包，fallback / emptyReason 字段齐全；
 * 内核收到的是路由传入的 broadcast（压缩卡的 chat.contextCompressed 广播靠它送达）。
 *
 * ORU_DIR 范式：顶层先设 env，route 动态 import（paths.ts 在 module load 时固化 ORU_DIR）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConvCompressResultEvent, ServerEvent } from '@shared/protocol';

process.env.ORU_DIR = join(tmpdir(), `oru-test-conv-compress-${Date.now()}`);

const { forceMock } = vi.hoisted(() => ({
  forceMock: vi.fn<(typeof import('../../electron/main/agent/context/manualCompress'))['forceCompressConversation']>(),
}));
vi.mock('../../electron/main/agent/context/manualCompress', async (orig) => ({
  ...(await orig()),
  forceCompressConversation: forceMock,
}));

const { route } = await import('../../electron/main/ws/router');

function callCompress(agentId: string, conversationId: string) {
  const replies: Array<[string, ServerEvent]> = [];
  const events: ServerEvent[] = [];
  return {
    replies,
    events,
    run: () =>
      route(
        { type: 'conv.compress', reqId: 'c1', agentId, conversationId },
        (reqId, ev) => replies.push([reqId, ev]),
        (ev) => events.push(ev),
      ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('conv.compress 路由', () => {
  it('compressed（含 fallback 标记）→ 回包映射齐全，broadcast 透传给内核', async () => {
    forceMock.mockResolvedValue({ status: 'compressed', fallback: true });
    const c = callCompress('a', 'conv1');
    await c.run();
    expect(forceMock).toHaveBeenCalledWith('a', 'conv1', expect.any(Function));
    expect(c.replies).toHaveLength(1);
    const [reqId, ev] = c.replies[0];
    expect(reqId).toBe('c1');
    expect(ev).toEqual({
      type: 'conv.compress.result',
      agentId: 'a',
      conversationId: 'conv1',
      status: 'compressed',
      fallback: true,
    } satisfies ConvCompressResultEvent);
  });

  it('busy → 回包无 fallback/emptyReason 杂项', async () => {
    forceMock.mockResolvedValue({ status: 'busy' });
    const c = callCompress('a', 'conv1');
    await c.run();
    expect(c.replies[0][1]).toEqual({
      type: 'conv.compress.result',
      agentId: 'a',
      conversationId: 'conv1',
      status: 'busy',
    } satisfies ConvCompressResultEvent);
  });

  it('empty → emptyReason 两态如实透传', async () => {
    for (const emptyReason of ['tooShort', 'nothingNew'] as const) {
      forceMock.mockResolvedValue({ status: 'empty', emptyReason });
      const c = callCompress('a', 'conv1');
      await c.run();
      expect(c.replies[0][1]).toMatchObject({ status: 'empty', emptyReason });
    }
  });

  it('failed → 回包 failed（内核自己吞异常，路由不再兜）', async () => {
    forceMock.mockResolvedValue({ status: 'failed' });
    const c = callCompress('a', 'conv1');
    await c.run();
    expect(c.replies[0][1]).toMatchObject({ status: 'failed' });
  });
});
