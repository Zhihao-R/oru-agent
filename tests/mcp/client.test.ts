/**
 * McpServerClient.callTool 回归：用 SDK 原生 RequestOptions 透传 signal + 兜底超时。
 *
 * 锁的目标问题：
 *  ① 调用要带 abortSignal——用户中断对话时 SDK 取消底层请求（此前手写 withTimeout 只 reject Promise，
 *    底层请求仍在跑）。
 *  ② 兜底超时从 60s 放宽到 10min——时长主导权交回用户/对话，固定值只防 server 挂死。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServerConfig } from '@shared/types';

const sdk = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  listTools: vi.fn(async () => ({ tools: [] })),
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onclose?: () => void;
    connect = sdk.connect;
    listTools = sdk.listTools;
    callTool = sdk.callTool;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    stderr = null;
  },
}));

import { McpServerClient } from '../../electron/main/mcp/client';

const config: McpServerConfig = {
  id: 'srv',
  label: 'Srv',
  command: 'echo',
  args: [],
  enabled: true,
};

beforeEach(() => {
  sdk.callTool.mockClear();
  sdk.connect.mockReset();
  sdk.connect.mockImplementation(async () => {});
  sdk.listTools.mockReset();
  sdk.listTools.mockImplementation(async () => ({ tools: [] }));
});

describe('McpServerClient.start 握手超时 override（懒重连用 5s 短超时）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect 挂死时按传入的 handshakeTimeoutMs(5s) 失败，而非启动期 30s', async () => {
    // 懒重连场景：用户在 execute 上同步干等，必须用 5s 短超时兜底，不能复用启动期 30s
    vi.useFakeTimers();
    sdk.connect.mockImplementation(() => new Promise<void>(() => {})); // 永不 resolve

    const client = new McpServerClient(config);
    const started = client.start({ handshakeTimeoutMs: 5_000 });
    // 防 unhandledRejection：先挂 catch
    const settled = started.then(
      () => 'resolved',
      (e) => (e as Error).message,
    );

    // 推进到 5s 前一刻：还不该失败
    await vi.advanceTimersByTimeAsync(4_999);
    let done = false;
    void settled.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);

    // 越过 5s：握手超时
    await vi.advanceTimersByTimeAsync(2);
    const msg = await settled;
    expect(msg).toContain('handshake timeout');
    expect(client.status).toBe('failed');
  });

  it('不传 override 时仍用启动期 30s 超时（4999/5001 都还没超时）', async () => {
    vi.useFakeTimers();
    sdk.connect.mockImplementation(() => new Promise<void>(() => {}));

    const client = new McpServerClient(config);
    const started = client.start();
    const settled = started.then(
      () => 'resolved',
      (e) => (e as Error).message,
    );

    // 5s 已过——若误用了短超时这里就会失败；30s 默认下仍在等
    await vi.advanceTimersByTimeAsync(5_001);
    let done = false;
    void settled.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);

    // 越过 30s 才超时
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await settled).toContain('handshake timeout');
  });
});

describe('McpServerClient.callTool', () => {
  it('把 signal 和 10min 兜底超时交给 SDK', async () => {
    const client = new McpServerClient(config);
    await client.start();

    const ac = new AbortController();
    await client.callTool('do_thing', { x: 1 }, ac.signal);

    expect(sdk.callTool).toHaveBeenCalledTimes(1);
    const [, , options] = sdk.callTool.mock.calls[0] as unknown as [unknown, unknown, { signal?: AbortSignal; timeout?: number }];
    expect(options.signal).toBe(ac.signal);
    expect(options.timeout).toBe(10 * 60 * 1000);
  });
});

/**
 * image content 提取回归：外部 MCP 改走反射后（claude-code 不再原生透传 mcpServers），
 * 截图类工具的图必须能穿过这一层——此前非 text 的 content 一律被压成 `[image]` 占位，
 * 图在这里就丢了，反射路径下 take_screenshot 会直接废掉。
 */
describe('McpServerClient.callTool 的 image content', () => {
  it('PNG 图提取进 images，text 侧留占位保住顺序', async () => {
    sdk.callTool.mockImplementationOnce(async () => ({
      content: [
        { type: 'text', text: '截图如下' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'text', text: '完成' },
      ],
    }));
    const client = new McpServerClient(config);
    await client.start();

    const r = await client.callTool('take_screenshot', {});

    expect(r.images).toEqual([{ base64: 'iVBORw0KGgo=', mediaType: 'image/png' }]);
    // base64 逐字节原样带出，不做任何再编码
    expect(r.images?.[0].base64).toBe('iVBORw0KGgo=');
    expect(r.text).toBe('截图如下\n[image]\n完成');
  });

  it('非 PNG 的图不进 images，只留占位（不猜格式）', async () => {
    sdk.callTool.mockImplementationOnce(async () => ({
      content: [{ type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' }],
    }));
    const client = new McpServerClient(config);
    await client.start();

    const r = await client.callTool('take_screenshot', {});

    expect(r.images).toBeUndefined();
    expect(r.text).toBe('[image]');
  });

  it('纯文本结果不带 images 字段（向后兼容，现有工具行为零变化）', async () => {
    const client = new McpServerClient(config);
    await client.start();

    const r = await client.callTool('do_thing', {});

    expect(r.images).toBeUndefined();
    expect(r.text).toBe('ok');
  });
});
