/**
 * 把外部 MCP server 暴露的工具反射成 Oru AgentTool。
 *
 * 命名规则：`mcp__<serverId>__<toolName>` —— 跟 Claude Agent SDK 透传 mcpServers
 * 后的命名一致，让 ClaudeCodeBackend / Anthropic 直连 / OpenAI-compatible 三个 backend
 * 的 LLM 看到同一组名字。
 *
 * 三个 backend 都走 registerTool 反射路径（2026-07-27 起）。ClaudeCode 曾经跳过 mcp__ 前缀、
 * 改由 SDK 原生 mcpServers 透传，已随「外部 MCP 进程复用」退场——透传让 SDK 每回合新 spawn 一份
 * server，按连接进程授权的下游（Chrome CDP）会反复弹授权。现在它与自有工具一起桥进 'oru'，
 * SDK 再加一层前缀成 mcp__oru__mcp__<serverId>__<tool>，normalizeToolName 剥掉外层后正是本文件
 * 的注册名（「归一名 == 注册名」不变量，见 shared/agent/toolName.ts）。
 *
 * **懒重连（技术设计 §4.4）**：execute 命中 `failed`（运行中崩溃）时调 deps.ensureReconnected
 * 自愈一次。重连内部 `new` 了新 client 实例，闭包捕获的旧 client 已孤立——故每次都通过
 * deps.currentClient(serverId) 重读 registry 里的当前实例，绝不沿用闭包里的旧引用
 * （CLAUDE.md「await 后重读」在 reflectTool 层的体现）。掉线文案按 owner 语言走 i18n。
 */
import type { AgentTool, ToolResult, ToolResultImage } from '@shared/agent/backend';
import { decodeThumbnails, IMAGE_VIEW_MAX_WIDTH } from '../render/imageDecoder';
import { frameUntrusted } from '../agent/untrustedContent';
import { getSettings } from '../projects/store';
import { resolveEffectiveLang } from '../i18n/effectiveLang';
import { t } from '../i18n/t';
import type { McpServerClient } from './client';
import type { ReconnectOutcome } from './registry';
import type { McpToolMeta } from './types';
import { ORU_MCP_TOOL_PREFIX } from '@shared/agent/toolName';

/**
 * 模型接口对工具名的硬约束：`^[a-zA-Z0-9_-]{1,64}$`（不是 Oru 定的，改不了）。
 * claude-code 下模型看到的 wire 名 = `mcp__oru__` + 本文件生成的注册名，故这里的预算要先扣掉桥接前缀。
 */
const MAX_WIRE_LENGTH = 64;
const LEGAL_NAME = /^[a-zA-Z0-9_-]+$/;
const MAX_REFLECTED_LENGTH = MAX_WIRE_LENGTH - ORU_MCP_TOOL_PREFIX.length;

/** 稳定短哈希（djb2）——同样的输入永远得同样的 4 位，unregister 靠重算找回同一个名字。 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 4).padStart(4, '0');
}

/**
 * registry 注入的依赖——直接 import registry 会形成循环（registry → reflectTool），
 * 故由 registry 在反射时把自己的两个函数传下来。
 */
export type ReflectDeps = {
  /** 懒重连入口（registry.ensureReconnected）——execute 命中 failed 时调。 */
  ensureReconnected: (serverId: string) => Promise<ReconnectOutcome>;
  /** 取 registry 里该 serverId 的当前 client——重连后是新实例，闭包里的旧 client 已孤立。 */
  currentClient: (serverId: string) => McpServerClient | undefined;
};

/**
 * 第三方 server 回传的图过与 read_file 同一条归一（长边封顶 + 统一 PNG）。
 * 不归一的话原始字节直灌上下文：一张全页截图可能几 MB，轻则挤掉前面的对话，重则整轮请求超限。
 * 解码失败的那张跳过（decodeThumbnails 的契约），不连累同批其它图与工具本身的文字结果。
 */
const MAX_IMAGES_PER_CALL = 4;

async function normalizeImages(
  images: ToolResultImage[],
  signal: AbortSignal,
): Promise<{ images?: ToolResultImage[]; note?: string }> {
  // 用户已按停就别再起离屏窗口解码——整轮在 Promise.all 等齐，这里不返回就收不了尾
  if (signal.aborted) return {};
  // 张数封顶：server 回多少张不受我们控制，每张都要过一次离屏解码
  const taken = images.slice(0, MAX_IMAGES_PER_CALL);
  const decoded = await decodeThumbnails(
    taken.map((i) => ({ bytes: Buffer.from(i.base64, 'base64'), mime: i.mediaType })),
    IMAGE_VIEW_MAX_WIDTH,
  ).catch(() => [] as Array<null>);
  const out = decoded.flatMap((d) =>
    d ? [{ base64: d.pngBase64, mediaType: 'image/png' as const }] : [],
  );
  if (out.length === 0) {
    // 与「模型不支持看图」同一立场：告知而非静默丢，否则模型会对着看不见的图编描述
    return { note: '\n[这个工具回传的图片解码失败，你没有看到它]' };
  }
  const dropped = images.length - out.length;
  return {
    images: out,
    note: dropped > 0 ? `\n[另有 ${dropped} 张图未能送达（超出单次上限或解码失败）]` : undefined,
  };
}

/** 按 owner 语言取掉线文案的语言（与 approvalGate 同口径）。 */
async function ownerLang(): Promise<'zh' | 'en'> {
  return resolveEffectiveLang((await getSettings().catch(() => null))?.language);
}

export function reflectMcpTool(
  client: McpServerClient,
  tool: McpToolMeta,
  deps: ReflectDeps,
): AgentTool {
  const serverId = client.config.id;
  const label = client.config.label;
  const name = reflectedToolName(serverId, tool.name);
  const description = `[MCP: ${label}] ` + (tool.description || `(no description)`);
  const toolRef = `${serverId}/${tool.name}`;

  return {
    name,
    mutatesEnvironment: true,
    description,
    inputSchema: tool.inputSchema,
    async execute(input, ctx): Promise<ToolResult> {
      // 当前 registry 实例——重连后是新 client，不读闭包捕获的旧 client（可能已孤立 failed）
      const live = deps.currentClient(serverId) ?? client;

      // probe_failed：下游探活没通，维持现状给明确文案（不触发重连——重连治不了下游依赖）
      if (live.status === 'probe_failed') {
        const lang = await ownerLang();
        return {
          isError: true,
          text: t('main:mcp.probeFailed', lang, {
            label,
            reason: live.lastError ?? t('main:mcp.unknownReason', lang),
          }),
        };
      }

      // failed：运行中崩溃 → 懒重连一次
      if (live.status === 'failed') {
        const outcome = await deps.ensureReconnected(serverId);
        if (outcome === 'circuit_open') {
          return { isError: true, text: t('main:mcp.circuitOpen', await ownerLang(), { label }) };
        }
        if (outcome === 'reconnect_failed') {
          return { isError: true, text: t('main:mcp.reconnectFailed', await ownerLang(), { label }) };
        }
        // ready → 落入下面正常 callTool（用重连后的当前实例）
      }

      // ★ await ensureReconnected 后重读当前实例：重连把 client 换成了新的
      const target = deps.currentClient(serverId) ?? live;
      if (target.status !== 'connected' && target.status !== 'connected_ready') {
        return {
          isError: true,
          text: t('main:mcp.notReady', await ownerLang(), { label, status: target.status }),
        };
      }

      try {
        // 透传对话中断信号：用户按 Esc 中断对话时，正在跑的 MCP 调用立即被 SDK 取消
        const r = await target.callTool(tool.name, input, ctx.abortSignal);
        const norm = r.images?.length
          ? await normalizeImages(r.images, ctx.abortSignal)
          : {};
        // 第三方 server 的返回是外部内容（chrome-devtools 回的就是网页原文），按来源框定——
        // 与 web_fetch / browser_* / read_file 同一纪律。不框的话 server 能在自己的文字里
        // 伪造系统口吻的旁白（"当前模型不支持看图""这台 server 已获授权"），模型无从分辨。
        // 我们自己的补充说明（归一失败等）拼在框定之后，属于 Oru 的声音、不进不可信区。
        const framed = r.isError ? r.text : frameUntrusted('web', r.text);
        // images 归一后透传，三个后端都消费：claude-code 转 MCP image block、anthropic 拼进
        // tool_result 的图像块、openaiCompatible 按 supportsVision 透出或追加「看不到图」的说明。
        return {
          isError: r.isError,
          text: norm.note ? `${framed}${norm.note}` : framed,
          images: norm.images,
        };
      } catch (e) {
        // 用户中断对话时 SDK 取消调用会抛错——这不是工具失败，按中性"已取消"回执（与前台 bash
        // 取消语义一致），别用"失败"文案误导模型重试
        if (ctx.abortSignal.aborted) {
          return { isError: false, text: t('main:mcp.callCancelled', await ownerLang(), { tool: toolRef }) };
        }
        return {
          isError: true,
          text: t('main:mcp.callFailed', await ownerLang(), { tool: toolRef, error: (e as Error).message }),
        };
      }
    },
  };
}

/**
 * 合成反射工具名——**纯函数**，unregister 靠重算找回同一个名字，故不可依赖任何外部状态。
 *
 * 名字撞上接口约束时**改写而不是丢工具**：这个名字是 Oru 自己合成的别名（真正发给 server 的是
 * `tool.name`），我们对它有完全的自由度；为守住自己造的名字的格式而丢掉第三方真实存在的能力，
 * 方向是反的。与「畸形 schema 跳过该工具」不同构——那是信息缺失（造不出正确的参数结构），
 * 这里是格式不合（完全能造一个合规的等价名）。
 *
 * 两步：非法字符换 `_`；仍超长则压缩 **serverId**（我们造的那段）而不是 toolName——模型是靠
 * 工具名挑工具的，toolName 才是携带"这个工具干什么"的那段。serverId 压成 4 位稳定哈希后仍超长
 * （toolName 本身极长）才截 toolName，尾部接哈希防撞。
 *
 * 实例：出厂预设 id 是 `preset-chrome-devtools`（22 字符），
 * `performance_analyze_insight` 拼完 wire 名 66 > 64 —— 压缩后仍可用。
 */
export function reflectedToolName(serverId: string, toolName: string): string {
  // 非法字符不能只替换成 `_`——「飞书」「钉钉」都会变成同样的下划线串而撞名。
  // 含非法字符的段一律接一段取自原文的稳定哈希，保证不同原文得不同结果。
  const safeSegment = (s: string): string =>
    LEGAL_NAME.test(s) ? s : `${s.replace(/[^a-zA-Z0-9_-]/g, '_')}_${shortHash(s)}`;
  const sid = safeSegment(serverId);
  const tool = safeSegment(toolName);

  const full = `mcp__${sid}__${tool}`;
  if (full.length <= MAX_REFLECTED_LENGTH) return full;

  // 压 serverId：哈希取自**原始** serverId，保证同一台 server 恒得同一段
  const compact = `mcp__${shortHash(serverId)}__${tool}`;
  if (compact.length <= MAX_REFLECTED_LENGTH) return compact;

  // toolName 自身就超预算：截断 + 尾部哈希（取自原始 toolName）防同前缀撞名
  const suffix = `_${shortHash(toolName)}`;
  const head = compact.slice(0, MAX_REFLECTED_LENGTH - suffix.length);
  return head + suffix;
}
