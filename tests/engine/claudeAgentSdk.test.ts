/**
 * stderr 接住 + 进程退出错误增强 —— 把 SDK 默认丢弃的子进程 stderr 补回错误信息。
 *
 * 背景：SDK 子进程非正常退出时只抛 "Claude Code process exited with code 1"，
 * 真因全在被丢弃的 stderr 里。createStderrTail 接住 stderr 末尾，
 * enrichProcessExitError 在「进程退出」类错误上把这段 stderr 拼进 message。
 */
import { describe, it, expect } from 'vitest';
import {
  createLiveInputChannel,
  createStderrTail,
  enrichProcessExitError,
  PROCESS_EXIT_ERROR_RE,
} from '../../electron/main/engine/claudeAgentSdk';
import type { EngineEvent } from '../../electron/main/engine/types';

describe('createStderrTail', () => {
  it('只保留末尾 capChars 字符，丢开头', () => {
    const t = createStderrTail(10);
    t.push('1234567890ABCDE'); // 15 字符
    expect(t.text()).toBe('67890ABCDE'); // 末尾 10 个
  });

  it('多次 push 跨边界累积，仍只留末尾', () => {
    const t = createStderrTail(8);
    t.push('hello ');
    t.push('world!!'); // 累积 "hello world!!"（13 字符）
    expect(t.text()).toBe('world!!'); // 末尾 8 = " world!!"，trim 后 "world!!"
  });

  it('text() 去掉首尾空白', () => {
    const t = createStderrTail();
    t.push('\n  boom  \n');
    expect(t.text()).toBe('boom');
  });
});

describe('PROCESS_EXIT_ERROR_RE', () => {
  it('匹配 SDK 的三种进程退出错误文案', () => {
    expect(PROCESS_EXIT_ERROR_RE.test('Claude Code process exited with code 1')).toBe(true);
    expect(PROCESS_EXIT_ERROR_RE.test('Claude Code process terminated by signal SIGKILL')).toBe(true);
    expect(PROCESS_EXIT_ERROR_RE.test('Failed to spawn Claude Code process: ENOENT')).toBe(true);
  });

  it('不误伤无关错误', () => {
    expect(PROCESS_EXIT_ERROR_RE.test('HTTP 429: rate limited')).toBe(false);
    expect(PROCESS_EXIT_ERROR_RE.test('fetch failed')).toBe(false);
  });
});

async function collect(
  events: AsyncIterable<EngineEvent>,
): Promise<{ items: EngineEvent[]; error: unknown }> {
  const items: EngineEvent[] = [];
  let error: unknown;
  try {
    for await (const e of events) items.push(e);
  } catch (e) {
    error = e;
  }
  return { items, error };
}

describe('createLiveInputChannel', () => {
  it('首条消息立即可读，session_id 取 resume；文本块翻译成 SDK content', async () => {
    const ch = createLiveInputChannel([{ type: 'text', text: '起回合' }], 'sess-1');
    const first = await ch.stream.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '起回合' }] },
      session_id: 'sess-1',
    });
    ch.close();
  });

  it('push 持续推入新消息、close 后流终止', async () => {
    const ch = createLiveInputChannel([{ type: 'text', text: 'a' }], undefined);
    const got: string[] = [];
    const consumer = (async () => {
      for await (const m of ch.stream) {
        const block = m.message.content[0] as { type: string; text?: string };
        got.push(block.text ?? '');
      }
    })();
    // 起回合后续喂两条，再 close
    ch.push([{ type: 'text', text: 'b' }]);
    ch.push([{ type: 'text', text: 'c' }]);
    ch.close();
    await consumer;
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('close 之后 push 被忽略（不复活已收尾的流）', async () => {
    const ch = createLiveInputChannel([{ type: 'text', text: 'a' }], undefined);
    const got: unknown[] = [];
    const consumer = (async () => {
      for await (const m of ch.stream) got.push(m);
    })();
    ch.close();
    ch.push([{ type: 'text', text: 'late' }]);
    await consumer;
    expect(got).toHaveLength(1); // 只有起回合那条
  });
});

describe('enrichProcessExitError', () => {
  it('进程退出错误 + 有 stderr → 透传已 yield 的事件并把 stderr 拼进 message', async () => {
    const tail = createStderrTail();
    tail.push('Error: model claude-bogus-9 is not available');
    async function* boom(): AsyncIterable<EngineEvent> {
      yield { type: 'assistant_text', text: 'hi' };
      throw new Error('Claude Code process exited with code 1');
    }
    const { items, error } = await collect(enrichProcessExitError(boom(), tail));
    expect(items).toEqual([{ type: 'assistant_text', text: 'hi' }]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('exited with code 1');
    expect((error as Error).message).toContain('claude-bogus-9 is not available');
  });

  it('进程退出错误但 stderr 为空 → message 不变', async () => {
    const tail = createStderrTail();
    async function* boom(): AsyncIterable<EngineEvent> {
      throw new Error('Claude Code process exited with code 1');
    }
    const { error } = await collect(enrichProcessExitError(boom(), tail));
    expect((error as Error).message).toBe('Claude Code process exited with code 1');
  });

  it('非进程退出错误 → 原样抛，即使 stderr 有内容也不污染', async () => {
    const tail = createStderrTail();
    tail.push('some noise');
    async function* boom(): AsyncIterable<EngineEvent> {
      throw new Error('HTTP 429: rate limited');
    }
    const { error } = await collect(enrichProcessExitError(boom(), tail));
    expect((error as Error).message).toBe('HTTP 429: rate limited');
  });

  it('正常结束（无错误）→ 全部事件透传', async () => {
    const tail = createStderrTail();
    async function* ok(): AsyncIterable<EngineEvent> {
      yield { type: 'assistant_text', text: 'a' };
      yield { type: 'result', resultText: 'done', isError: false };
    }
    const { items, error } = await collect(enrichProcessExitError(ok(), tail));
    expect(error).toBeUndefined();
    expect(items).toHaveLength(2);
  });
});
