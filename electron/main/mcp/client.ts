/**
 * 单个 MCP server 的客户端封装。
 *
 * - spawn 子进程（stdio transport）
 * - handshake（initialize）
 * - 可选 probe（调一次 probeTool 探活）
 * - 拉 listTools 缓存到 `tools`
 * - callTool 转发
 * - close 收尾
 *
 * 生命周期单向：idle → starting → connected → [probe_failed | connected_ready] → failed/closed
 */
import type { McpServerConfig, McpServerStatus } from '@shared/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpError } from './errors';
import type { McpToolCallResult, McpToolMeta } from './types';

const HANDSHAKE_TIMEOUT_MS = 30_000;
// 对话内工具调用的兜底超时：只防 server 挂死，实际时长由调用方传入的 abortSignal 主导
// （用户中断对话即取消）。故放得宽，不再是治时长的主控。
const TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_BUF_CAP = 2048;

export class McpServerClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private _status: McpServerStatus = 'idle';
  private _lastError?: string;
  private _lastStderr?: string;
  private _tools: McpToolMeta[] = [];
  private stderrBuf = '';
  private stderrHandler?: (chunk: Buffer | string) => void;

  constructor(public readonly config: McpServerConfig) {}

  get status(): McpServerStatus {
    return this._status;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }
  /** 最近一次 spawn / handshake / runtime exit 失败时的 stderr 节选（最多 ~2KB） */
  get lastStderr(): string | undefined {
    return this._lastStderr;
  }
  get tools(): McpToolMeta[] {
    return this._tools;
  }

  /** 把 stderrBuf 内容快照到 _lastStderr —— spawn / handshake / runtime exit 三种失败时机都调 */
  private snapshotStderr(): void {
    if (this.stderrBuf) {
      this._lastStderr = this.stderrBuf;
    }
  }

  /**
   * 启动 server：spawn + handshake + 可选探活 + 拉 listTools。
   * 单次调用，重复调要先 close()。
   *
   * `handshakeTimeoutMs`：覆盖握手 + 探活（"连接就绪"阶段）的超时，缺省 30s（启动期）。
   * 懒重连传 5s 短超时——用户在 reflectTool.execute 上同步干等，不能复用启动期的 30s
   * （见 registry.ensureReconnected / 技术设计 §4.3）。只透传一个数字，不涉及中断逻辑。
   */
  async start(opts: { handshakeTimeoutMs?: number } = {}): Promise<void> {
    const handshakeTimeout = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    if (this._status !== 'idle' && this._status !== 'failed') {
      throw new McpError('start_failed', `cannot start: already ${this._status}`);
    }
    this._status = 'starting';
    this._lastError = undefined;
    this._lastStderr = undefined;
    this.stderrBuf = '';

    try {
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        // 刻意不走 buildSubprocessEnv（不剥 ANTHROPIC_BASE_URL）：外部 MCP server 是
        // 用户自配的第三方进程，可能合法需要该变量；劫持风险只针对我们自己的 claude-code 子进程
        env: { ...process.env, ...this.config.env } as Record<string, string>,
        // SDK 默认 'inherit'——stderr 直接进主进程 stderr，拿不到 stream。
        // 显式 'pipe' 让我们能 listen transport.stderr。
        stderr: 'pipe',
      });

      // 监听子进程 stderr：环形缓冲最近 2KB，同时 console.error 让 dev 仍能看到
      const t = this.transport as unknown as { stderr?: NodeJS.ReadableStream | null };
      if (t.stderr) {
        this.stderrHandler = (chunk: Buffer | string) => {
          const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          // dev 可观测性：开 pipe 后子进程 stderr 不再自动流向主进程 stderr，这里补一遍
          console.error(`[mcp:${this.config.id}]`, s.trimEnd());
          this.stderrBuf += s;
          if (this.stderrBuf.length > STDERR_BUF_CAP) {
            this.stderrBuf = this.stderrBuf.slice(-STDERR_BUF_CAP);
          }
        };
        t.stderr.on('data', this.stderrHandler);
      }

      this.client = new Client(
        { name: 'oru', version: '0.5.0' },
        { capabilities: {} },
      );
      // SDK 的 connect 内部做 initialize handshake
      await withTimeout(
        this.client.connect(this.transport),
        handshakeTimeout,
        'handshake timeout',
      );

      // 监听 runtime exit —— spec 三种失败时机之一：handshake 已通但运行中崩
      // SDK 的 client 有 onclose 回调；transport 底层 ChildProcess 退出会触发它
      this.client.onclose = () => {
        // 仅在仍认为"在跑"时才把状态置 failed；正常 close() 会先把 _status 改成 idle/failed
        if (
          this._status === 'connected' ||
          this._status === 'connected_ready' ||
          this._status === 'probe_failed'
        ) {
          this.snapshotStderr();
          this._status = 'failed';
          this._lastError = this._lastError ?? 'server 运行中退出';
        }
      };

      // handshake OK
      this._status = 'connected';

      // 拉工具列表（即使探活失败也能拿到，settings UI 用来显示）
      try {
        const r = await this.client.listTools();
        this._tools = (r.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema ?? { type: 'object' }) as object,
        }));
      } catch (e) {
        this._lastError = `listTools failed: ${(e as Error).message}`;
        // 不致命——保持 connected 但 tools 为空
      }

      // 可选探活；没配 probeTool 则停在 'connected' 不升级到 connected_ready
      if (this.config.probeTool) {
        try {
          await withTimeout(
            this.client.callTool({ name: this.config.probeTool, arguments: {} }),
            handshakeTimeout, // 探活与握手同属"连接就绪"阶段，共用同一超时（懒重连下也走 5s 短超时）
            'probe timeout',
          );
          this._status = 'connected_ready';
        } catch (e) {
          this._status = 'probe_failed';
          this._lastError = (e as Error).message;
        }
      }
    } catch (e) {
      this._status = 'failed';
      this._lastError = (e as Error).message;
      this.snapshotStderr();
      // 清理已建好的 transport
      await this.close({ keepStderr: true }).catch(() => {});
      throw new McpError('start_failed', this._lastError);
    }
  }

  /**
   * 调用 server 暴露的某个工具。
   *
   * server 必须在 connected / connected_ready 状态——其他状态返回 isError=true。
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolCallResult> {
    if (!this.client || (this._status !== 'connected' && this._status !== 'connected_ready')) {
      throw new McpError(
        'server_not_ready',
        `server ${this.config.id} not ready (status=${this._status})`,
      );
    }
    try {
      // SDK 原生 RequestOptions：signal abort 会真正取消底层请求（手写 withTimeout 只 reject Promise，
      // 底层仍在跑）；timeout 仅作防挂死兜底。
      const r = await this.client.callTool(
        {
          name,
          arguments: (args ?? {}) as Record<string, unknown>,
        },
        undefined,
        { signal, timeout: TOOL_CALL_TIMEOUT_MS },
      );
      // MCP CallToolResult 形态：{ content: [{type:'text',text} | {type:'image',data,mimeType}], isError? }
      // image content 提取成 images 让模型真「看见」（截图类工具靠这个才不废）；text 侧一律留
      // `[<type>]` 占位，保住多段内容的顺序可读。只认 PNG——对齐 ToolResultImage 的字面量约束
      // （shared/agent/backend.ts「本期只产 PNG，真有别的格式再加」），别的格式只留占位不猜。
      const content = (r.content ?? []) as {
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }[];
      const images = content.flatMap((c) =>
        c.type === 'image' && c.mimeType === 'image/png' && typeof c.data === 'string'
          ? [{ base64: c.data, mediaType: 'image/png' as const }]
          : [],
      );
      const text = content
        .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
        .join('\n');
      const isError = r.isError === true;
      return { text, isError, ...(images.length > 0 ? { images } : {}) };
    } catch (e) {
      throw new McpError('tool_call_failed', (e as Error).message);
    }
  }

  /**
   * 关闭子进程 + 清理资源。
   *
   * keepStderr：默认 false 会清 lastStderr；start() 抛错时传 true 保留诊断信息。
   */
  async close(opts: { keepStderr?: boolean } = {}): Promise<void> {
    // detach stderr listener（transport 关后 stream 仍然可能短暂发数据）
    if (this.stderrHandler) {
      const t = this.transport as unknown as { stderr?: NodeJS.ReadableStream | null };
      if (t?.stderr) t.stderr.off('data', this.stderrHandler);
      this.stderrHandler = undefined;
    }
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.transport?.close();
    } catch {
      /* ignore */
    }
    this.client = undefined;
    this.transport = undefined;
    this._tools = [];
    this.stderrBuf = '';
    if (!opts.keepStderr) this._lastStderr = undefined;
    if (this._status !== 'failed') this._status = 'idle';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  // p 落定后必须 clearTimeout——否则每次工具调用泄漏一个最长 ms 的悬空 timer
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
