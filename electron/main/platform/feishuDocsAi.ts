/**
 * 飞书 docs_ai 内核（S4 · bot 身份进程内 SDK；S5 · user 身份进程内 UAT）—— feishu_doc
 * 工具的执行内核，取代「每次 spawn lark-cli」（冷启动 0.5-2s + 文本解析税）。
 * 身份经 DocsAiKernelDeps.identity 分流：
 * - bot：SDK transport（Lark.Client + tenant token），create 后授权授予白名单；
 * - user：UAT transport（feishuUat.ts，Bearer fetch + 刷新重试），文档归本人、不授权授予，
 *   授权面错误（token 缺失/失效、missing_scope）的修复路径指向「设置 ▸ 平台连接」重授权
 *   （S5 起 lark-cli 退为运维工具，hint 不再指向 `lark-cli auth login`）。
 * 两身份共用同一份对拍基准（下述）。
 *
 * 对拍基准是 lark-cli v2 路径（上游 github.com/larksuite/cli shortcuts/doc/*_v2.go）：
 * 三个 op 都是 docs_ai 单端点薄封装，本文件移植其
 *  - body 构造：buildFetchBody / buildCreateBody / buildUpdateBodyBase（含 title 前置转义、
 *    extra_param、export_option、read_option、append→block_insert_after+block_id "-1"、空 content 不发送）；
 *  - 校验：parseDocumentRef / validateReadModeFlags / validateUpdateV2 子集——内核调用方给不全
 *    锚点的组合（range/keyword/section、block_copy/move）与 lark-cli 一样回结构化 validation 错误
 *    （内核层英文信封是对拍承重；工具层缺参回中文裸文本是给模型的直接指引——两层风格有意不同）；
 *  - 错误分类：errclass/codemeta.go 中 bot 身份可触的码（refresh_token_* 五行只出现在 user
 *    授权流程，不移植）+ BuildAPIError（canonical permission message/hint、console_url 申请链接、
 *    log_id/troubleshooter/details 提升）；
 *  - 输出信封：{ok, identity, data|error}——envelope/error 键序对拍 Go struct 声明序，
 *    2 空格缩进 + 尾换行；data 载荷透传服务端键序（lark-cli 的字典序是 Go map 实现细节，
 *    无程序化消费者按序读键，不对拍——见「已知取舍」）。
 *
 * 已知取舍（有意为之，非遗漏）：
 *  - html5-block 大 reference_map 落本地文件（CLI 行为）不移植——进程内无此必要，数据原样内联返回；
 *  - data 载荷键序透传服务端顺序，不镜像 lark-cli 的 Go map 字典序（形状对拍，键序非形态）；
 *  - bot create 的自动授权对象从「lark-cli 登录用户」换成「飞书白名单条目」（本机没有 CLI 用户概念；
 *    个人助理场景白名单即 owner 绑定身份），member_type 按 id 前缀（ou_→openid / on_→unionid）。
 *    member_type 为 unionid 时结果字段仍叫 user_open_id（形状对拍）——值实为 unionid，消费者按
 *    member_type 解读。
 *
 * client 生命周期：transport 每次调用现读凭证（credentialStore），凭证变更即重建 client——
 * 不靠失效钩子，await 后绝不沿用 await 前读到的凭证（仓规：await 后重检共享状态）。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import type { WhitelistEntry } from '@shared/types';
import type { AuthFailure } from './feishuCli';
import { getFeishuCredential, type FeishuCredential } from './credentialStore';
import { loadWhitelist } from './platformSettings';
import { redactSecrets } from './redact';
import { makeDefaultUatDocsAiTransport } from './feishuUat';

/** docs_ai 端点超时预算（CLI 路径含冷启动沿用同值，见 feishuDoc.ts）。 */
export const FEISHU_DOC_TIMEOUT_MS = 120_000;

// ─────────────────────────── 内核接缝（CLI / SDK 两内核共同实现） ───────────────────────────

export interface FeishuDocFetchReq {
  doc: string;
  scope?: string;
  detail?: string;
  format?: string;
}
export interface FeishuDocCreateReq {
  title?: string;
  format?: string;
  content: string;
}
export interface FeishuDocUpdateReq {
  doc: string;
  command: string;
  pattern?: string;
  blockId?: string;
  format?: string;
  content?: string;
}

export type FeishuDocOutcome =
  | { ok: true; text: string }
  | { ok: false; text: string; authFailure: AuthFailure };

export interface FeishuDocKernel {
  fetch(req: FeishuDocFetchReq): Promise<FeishuDocOutcome>;
  create(req: FeishuDocCreateReq): Promise<FeishuDocOutcome>;
  update(req: FeishuDocUpdateReq): Promise<FeishuDocOutcome>;
}

// ─────────────────────────── transport 抽象（SDK 调用可瞬时化） ───────────────────────────

/** Lark OAPI 响应信封（code=0 成功；error 块载 permission_violations / details / log_id 等）。 */
export interface LarkApiEnvelope {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  error?: {
    log_id?: string;
    troubleshooter?: string;
    permission_violations?: Array<{ subject?: string }>;
    details?: Array<{ value?: string }>;
  };
  log_id?: string;
}

export type DocsAiTransportResult =
  | { kind: 'ok'; envelope: LarkApiEnvelope } // HTTP 2xx；code 可能非 0（交内核分类）
  | { kind: 'http'; status: number; envelope?: LarkApiEnvelope } // HTTP 非 2xx（可带信封）
  | { kind: 'network'; subtype: 'timeout' | 'transport'; message: string }
  | { kind: 'not-configured' } // credentialStore 无飞书凭证
  | { kind: 'no-user-token' }; // 无可用 user token（仅 user transport 回；需到设置页授权）

export type DocsAiTransport = (req: {
  method: 'POST' | 'PUT';
  path: string;
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
  timeoutMs: number;
}) => Promise<DocsAiTransportResult>;

/** client 的最小面（Lark.Client 的 request 子集）——测试注入假 client 满足本类型即可。 */
export interface SdkClient {
  request(opts: {
    method: string;
    url: string;
    data?: unknown;
    params?: unknown;
    timeout?: number;
  }): Promise<unknown>;
}

export interface SdkTransportDeps {
  getCredential: () => Promise<FeishuCredential | null>;
  makeClient: (cred: FeishuCredential) => SdkClient;
}

/**
 * 默认 transport：进程内 Lark.Client 调 OAPI。client 按凭证缓存——每次调用现读凭证，
 * 变了就重建（无失效钩子也不会用到陈旧凭证）。同凭证并发首调可能各建一个 client，
 * 无害（client 无会话态，token 缓存只是省一次请求）。
 */
export function makeSdkTransport(deps: SdkTransportDeps): DocsAiTransport {
  let cached: { cred: FeishuCredential; client: SdkClient } | null = null;
  return async (req) => {
    const cred = await deps.getCredential();
    if (!cred) return { kind: 'not-configured' };
    // await 后重检：比较的是刚读到的凭证，缓存只在完全一致时复用
    if (!cached || cached.cred.appId !== cred.appId || cached.cred.appSecret !== cred.appSecret) {
      cached = { cred, client: deps.makeClient(cred) };
    }
    try {
      const envelope = await cached.client.request({
        method: req.method,
        url: req.path,
        data: req.body,
        params: req.params,
        timeout: req.timeoutMs,
      });
      return { kind: 'ok', envelope: (envelope ?? {}) as LarkApiEnvelope };
    } catch (e) {
      return classifyThrown(e);
    }
  };
}

/** axios 形态异常 → transport 结果（SDK 的 http 层是 axios：4xx/5xx throw、超时 ECONNABORTED）。 */
function classifyThrown(e: unknown): DocsAiTransportResult {
  const err = e as {
    response?: { status?: number; data?: unknown };
    code?: string;
    message?: string;
  } | null;
  if (err && typeof err === 'object') {
    if (err.response && typeof err.response.status === 'number') {
      return {
        kind: 'http',
        status: err.response.status,
        envelope: isRecord(err.response.data) ? (err.response.data as LarkApiEnvelope) : undefined,
      };
    }
    if (err.code === 'ECONNABORTED') {
      return { kind: 'network', subtype: 'timeout', message: err.message ?? 'request timeout' };
    }
    return { kind: 'network', subtype: 'transport', message: err.message ?? String(e) };
  }
  return { kind: 'network', subtype: 'transport', message: String(e) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 授予对象筛选（生产接线的承重逻辑，窄测试锚点）：飞书条目的 id。legacy 无 platform 条目
 * （旧版裸字符串迁移，normalizeWhitelist 留空 platform）按仓库「保守留着」口径一并算入——
 * 非飞书形态的 id 由授予时的 ou_/on_ 前缀守卫挡住，不会授错。 */
export function selectGrantees(whitelist: readonly WhitelistEntry[]): string[] {
  return whitelist.filter((w) => w.platform === 'feishu' || w.platform === undefined).map((w) => w.id);
}

/** 生产默认内核：transport=SDK、授予对象=飞书白名单、appId=当前凭证（console_url 用）。
 * 依赖全部箭头包裹延迟取值——模块 import / 工厂调用都不触达 credentialStore / 真实 client，
 * 只有第一次真发请求才读凭证（测试 mock 掉 credentialStore 也能安全构造工具）。 */
export function makeDefaultDocsAiKernel(): FeishuDocKernel {
  return makeDocsAiKernel({
    transport: makeSdkTransport({
      getCredential: () => getFeishuCredential(),
      makeClient: (cred) =>
        new Lark.Client({
          appId: cred.appId,
          appSecret: cred.appSecret,
          domain: Lark.Domain.Feishu,
          loggerLevel: Lark.LoggerLevel.warn,
        }),
    }),
    loadGrantees: async () => selectGrantees(await loadWhitelist()),
    resolveAppId: async () => (await getFeishuCredential())?.appId ?? null,
  });
}

/** 生产 user 内核（S5）：UAT transport（Bearer fetch + 刷新重试）、不授权授予（文档归本人）。
 * 与 bot 内核共用同一份 body 构造 / 校验 / 错误分类对拍。 */
export function makeUserDocsAiKernel(): FeishuDocKernel {
  return makeDocsAiKernel({
    transport: makeDefaultUatDocsAiTransport(),
    loadGrantees: async () => [],
    resolveAppId: async () => (await getFeishuCredential())?.appId ?? null,
    identity: 'user',
  });
}

// ─────────────────────────── 错误分类（移植 errclass/codemeta + BuildAPIError） ───────────────────────────

/** 内核身份：bot=应用（tenant token）；user=本人（UAT，S5）。 */
export type DocsAiIdentity = 'bot' | 'user';

type Category =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'config'
  | 'network'
  | 'api'
  | 'policy'
  | 'internal';

const CODE_META: Record<number, { category: Category; subtype: string; retryable?: boolean }> = {
  // authentication（bot 只持 tenant_access_token，refresh_token_* 五行不移植——那是 user 授权流程的码）
  99991661: { category: 'authentication', subtype: 'token_missing' },
  99991671: { category: 'authentication', subtype: 'token_invalid' },
  99991668: { category: 'authentication', subtype: 'token_invalid' },
  99991663: { category: 'authentication', subtype: 'token_invalid' },
  99991677: { category: 'authentication', subtype: 'token_expired' },
  // authorization
  99991672: { category: 'authorization', subtype: 'app_scope_not_applied' },
  99991676: { category: 'authorization', subtype: 'token_scope_insufficient' },
  99991679: { category: 'authorization', subtype: 'missing_scope' },
  230027: { category: 'authorization', subtype: 'user_unauthorized' },
  99991673: { category: 'authorization', subtype: 'app_unavailable' },
  99991662: { category: 'authorization', subtype: 'app_disabled' },
  // api
  99991400: { category: 'api', subtype: 'rate_limit', retryable: true },
  1061045: { category: 'api', subtype: 'conflict', retryable: true },
  131009: { category: 'api', subtype: 'conflict', retryable: true },
  1064510: { category: 'api', subtype: 'cross_tenant' },
  1064511: { category: 'api', subtype: 'cross_brand' },
  1310246: { category: 'api', subtype: 'invalid_parameters' },
  1063006: { category: 'api', subtype: 'rate_limit' },
  1063007: { category: 'api', subtype: 'invalid_parameters' },
  231205: { category: 'api', subtype: 'ownership_mismatch' },
  // config
  99991543: { category: 'config', subtype: 'invalid_client' },
  10014: { category: 'config', subtype: 'invalid_client' },
  // policy
  21000: { category: 'policy', subtype: 'challenge_required' },
  21001: { category: 'policy', subtype: 'access_denied' },
};

const OPEN_BASE = 'https://open.feishu.cn';
const WWW_BASE = 'https://www.feishu.cn'; // 品牌标准资源 URL 域（对拍 BuildResourceURL 的 feishu host）

/** 对拍 errclass.ConsoleURL：/page/scope-apply?clientID=…&scopes=逗号连接（各自转义）。 */
function consoleUrl(appId: string | null, scopes: string[]): string {
  if (!appId) return '';
  const base = `${OPEN_BASE}/page/scope-apply?clientID=${encodeURIComponent(appId)}`;
  if (scopes.length === 0) return base;
  return `${base}&scopes=${encodeURIComponent(scopes.join(','))}`;
}

function extractMissingScopes(env: LarkApiEnvelope): string[] {
  const out: string[] = [];
  for (const v of env.error?.permission_violations ?? []) {
    const s = typeof v?.subject === 'string' ? v.subject : '';
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 对拍 CanonicalPermissionMessage（scope 缺失类换 canonical 措辞，其余保留上游 message）。 */
function canonicalPermissionMessage(subtype: string, appId: string | null, missing: string[], fallback: string): string {
  const app = appId ? `app ${appId}` : 'app';
  switch (subtype) {
    case 'app_scope_not_applied':
      return missing.length > 0
        ? `access denied: ${app} has not applied for the required scope(s): ${missing.join(', ')}`
        : `access denied: ${app} has not applied for the required scope(s)`;
    case 'missing_scope':
      return missing.length > 0
        ? `unauthorized: user authorization does not cover the required scope(s): ${missing.join(', ')}`
        : 'unauthorized: user authorization does not cover the required scope';
    case 'token_scope_insufficient':
      return 'token has no permission for this operation; required scope is missing';
    case 'user_unauthorized':
      return 'access denied for this operation; possible causes: missing scope, missing user authorization, or restricted by tenant policy';
    case 'app_unavailable':
      return `unauthorized app: ${app} is not properly installed in this tenant`;
    case 'app_disabled':
      return `${app} is not in use in this tenant (currently disabled)`;
    default:
      return fallback;
  }
}

/** 对拍 PermissionHint（authorization 类的 hint 以 curated 指引为准，覆盖服务端 details）。
 * 只含 CODE_META 可达的 subtype——permission_denied 在本表无码可触，不移植其文案。
 * user 身份的修复路径是设置页重授权（S5 起 lark-cli 退为运维工具，不再指向 `lark-cli auth login`）。 */
function permissionHint(missing: string[], subtype: string, url: string, identity: DocsAiIdentity): string {
  if (identity === 'user') {
    switch (subtype) {
      case 'missing_scope':
      case 'token_scope_insufficient':
        return missing.length > 0
          ? `re-authorize the user in Oru「设置 ▸ 平台连接」（飞书用户身份）so the updated scope set is picked up: ${missing.join(', ')}`
          : 're-authorize the user in Oru「设置 ▸ 平台连接」（飞书用户身份）so the updated scope set is picked up';
      case 'user_unauthorized':
        return 're-authorize the user in Oru「设置 ▸ 平台连接」; if re-auth does not help, the operation may be blocked by external-chat or admin policy';
      // app_* / 其余 subtype 与 bot 同义（应用层问题），落下共用分支
    }
  }
  switch (subtype) {
    case 'app_scope_not_applied':
      return url
        ? `the app developer must apply for the required scope(s) at the developer console: ${url}`
        : 'the app developer must apply for the required scope(s) at the developer console';
    case 'missing_scope':
      return missing.length > 0
        ? `run \`lark-cli auth login --scope "${missing.join(' ')}"\` to re-authorize the user with the updated scope set`
        : 'run `lark-cli auth login` to re-authorize the user with the updated scope set';
    case 'token_scope_insufficient':
      return "check the token's granted scopes; run `lark-cli auth login` to refresh if the scope was added after the token was issued";
    case 'user_unauthorized':
      return 'run `lark-cli auth login` to re-authorize this user; if re-auth does not help, the operation may be blocked by external-chat or admin policy';
    case 'app_unavailable':
      return "ask the tenant admin to check the app's install status in the Lark admin console";
    case 'app_disabled':
      return 'ask the tenant admin to re-enable the app in the Lark admin console';
    default:
      return 'check the calling identity has the required scope';
  }
}

/** 对拍 APIHint（api 类无服务端 details 时的兜底指引；只含 CODE_META 可达的 subtype）。 */
function apiHint(subtype: string): string {
  switch (subtype) {
    case 'conflict':
      return 'retry later and avoid concurrent duplicate requests on the same resource';
    case 'cross_tenant':
      return 'operate on source and target within the same tenant and region/unit';
    case 'cross_brand':
      return 'operate on source and target within the same brand environment';
    default:
      return '';
  }
}

function liftDetailHint(env: LarkApiEnvelope): string {
  const values = (env.error?.details ?? [])
    .map((d) => (typeof d?.value === 'string' ? d.value.trim() : ''))
    .filter((v) => v !== '');
  return values.join('; ');
}

type Classified = { wire: Record<string, unknown>; authFailure: AuthFailure };

/**
 * Lark 信封（code≠0）→ 与 lark-cli 同款结构化错误。
 * wire 键序对拍 Go struct 声明序（Problem: type, subtype, code, message, hint, log_id,
 * troubleshooter, retryable；扩展字段随后）——JSON.stringify 保持插入序。
 */
function classifyApiError(env: LarkApiEnvelope, appId: string | null, identity: DocsAiIdentity): Classified {
  const code = typeof env.code === 'number' ? env.code : 0;
  const msg = typeof env.msg === 'string' && env.msg !== '' ? env.msg : `API error: [${code}]`;
  const meta = CODE_META[code] ?? { category: 'api' as const, subtype: 'unknown' };
  const logId = env.log_id ?? env.error?.log_id;

  const wire: Record<string, unknown> = { type: meta.category, subtype: meta.subtype };
  if (code !== 0) wire.code = code;
  wire.message = msg;
  let hint = liftDetailHint(env);
  if (logId) wire.log_id = logId;
  if (env.error?.troubleshooter) wire.troubleshooter = env.error.troubleshooter;
  if (meta.retryable) wire.retryable = true;

  let authFailure: AuthFailure = { needsReauth: false };

  if (meta.category === 'authorization') {
    const missing = extractMissingScopes(env);
    const url = consoleUrl(appId, missing);
    wire.message = canonicalPermissionMessage(meta.subtype, appId, missing, msg);
    wire.hint = permissionHint(missing, meta.subtype, url, identity);
    if (missing.length > 0) wire.missing_scopes = missing;
    wire.identity = identity;
    // console_url 只对 app_scope_not_applied 上信封（其余 subtype 的恢复路径不是开发者后台）
    if (meta.subtype === 'app_scope_not_applied' && url) wire.console_url = url;
    // user 身份的授权面问题（缺 scope / 未授权），修复路径是设置页重新授权（带新 scope）——
    // 与认证类同归 needsReauth；app_* 是应用层问题，user 重授权修不了，不算
    if (identity === 'user' && (meta.subtype === 'missing_scope' || meta.subtype === 'token_scope_insufficient' || meta.subtype === 'user_unauthorized')) {
      const reauthHint =
        missing.length > 0
          ? `飞书用户授权缺少权限（${missing.join(', ')}），需要到「设置 ▸ 平台连接」重新完成飞书用户授权`
          : '飞书用户授权不足——到「设置 ▸ 平台连接」重新完成飞书用户授权';
      authFailure = { needsReauth: true, hint: reauthHint };
    }
  } else {
    if (meta.category === 'api' && hint === '') hint = apiHint(meta.subtype);
    if (hint !== '') wire.hint = hint;
    if (meta.category === 'authentication' || meta.category === 'config') {
      // 与 S2 对齐：认证 / 配置类 → 重新授权指引（hint 源头脱敏，与 detectAuthFailure 同款纪律）
      authFailure = { needsReauth: true, hint: typeof wire.hint === 'string' ? redactSecrets(wire.hint) : undefined };
    }
  }
  return { wire, authFailure };
}

// ─────────────────────────── 信封序列化 ───────────────────────────

function emitOk(data: Record<string, unknown> | undefined, identity: DocsAiIdentity): string {
  const env: Record<string, unknown> = { ok: true, identity };
  if (data !== undefined) env.data = data; // 键序透传服务端（见文件头「已知取舍」）
  return redactSecrets(JSON.stringify(env, null, 2) + '\n');
}

function emitError(wire: Record<string, unknown>, identity: DocsAiIdentity): string {
  return redactSecrets(JSON.stringify({ ok: false, identity, error: wire }, null, 2) + '\n');
}

const NO_AUTH: AuthFailure = { needsReauth: false };

function failure(wire: Record<string, unknown>, identity: DocsAiIdentity, authFailure: AuthFailure = NO_AUTH): FeishuDocOutcome {
  return { ok: false, text: emitError(wire, identity), authFailure };
}

/** 对拍 validation 错误（lark-cli exit 2 结构化输出）：message + param/params。 */
function validationFailure(
  message: string,
  identity: DocsAiIdentity,
  param?: string,
  params?: Array<{ name: string; reason: string }>,
): FeishuDocOutcome {
  const wire: Record<string, unknown> = { type: 'validation', subtype: 'invalid_argument', message };
  if (param) wire.param = param;
  if (params) wire.params = params;
  return failure(wire, identity);
}

// ─────────────────────────── doc ref 解析（移植 parseDocumentRef） ───────────────────────────

type DocRef = { token: string } | { error: FeishuDocOutcome };

function goQuote(s: string): string {
  return JSON.stringify(s); // Go %q 与 JSON 字符串转义在常见输入上一致
}

function parseDocumentRef(input: string, identity: DocsAiIdentity): DocRef {
  const raw = input.trim();
  if (raw === '') return { error: validationFailure('--doc cannot be empty', identity, '--doc') };
  for (const marker of ['/wiki/', '/docx/', '/doc/']) {
    const idx = raw.indexOf(marker);
    if (idx >= 0) {
      let token = raw.slice(idx + marker.length);
      const end = token.search(/[/?#]/);
      if (end >= 0) token = token.slice(0, end);
      token = token.trim();
      if (token !== '') return { token };
    }
  }
  if (raw.includes('://')) {
    return {
      error: validationFailure(
        `unsupported --doc input ${goQuote(raw)}: use a docx URL/token or a wiki URL that resolves to docx`,
        identity,
        '--doc',
      ),
    };
  }
  if (/[/?#]/.test(raw)) {
    return { error: validationFailure(`unsupported --doc input ${goQuote(raw)}: use a docx token or a wiki URL`, identity, '--doc') };
  }
  return { token: raw };
}

// ─────────────────────────── transport 结果 → outcome ───────────────────────────

/** HTTP 非 2xx 但带回了 Lark 错误码信封 → 交分类器；没带 → 按网络故障归类。 */
function hasLarkErrorCode(res: DocsAiTransportResult & { kind: 'http' }): boolean {
  return typeof res.envelope?.code === 'number' && res.envelope.code !== 0;
}

async function toOutcome(
  res: DocsAiTransportResult,
  deps: DocsAiKernelDeps,
  identity: DocsAiIdentity,
  onSuccess: (data: Record<string, unknown> | undefined) => Promise<Record<string, unknown> | undefined>,
): Promise<FeishuDocOutcome> {
  if (res.kind === 'not-configured') {
    // hint 用中文是有意的：这句是给模型转告用户的配置指引（同信封其余 message 面向开发者保持英文）
    const hint = '飞书应用凭证未配置——到「设置 ▸ 平台连接」完成飞书应用配置后再试';
    return failure({ type: 'config', subtype: 'not_configured', message: 'feishu app credential not configured', hint }, identity, { needsReauth: true, hint });
  }
  if (res.kind === 'no-user-token') {
    // 同上：中文指引给模型转告用户（user 授权在设置页完成，S5 起不再指向 lark-cli）
    const hint = '飞书用户授权未建立或已失效——到「设置 ▸ 平台连接」完成飞书用户授权后再试';
    return failure({ type: 'authentication', subtype: 'token_missing', message: 'user access token not available', hint }, identity, { needsReauth: true, hint });
  }
  if (res.kind === 'network') {
    const wire: Record<string, unknown> = { type: 'network', subtype: res.subtype, message: res.message };
    if (res.subtype === 'timeout') wire.retryable = true;
    return failure(wire, identity);
  }
  if (res.kind === 'http' && !hasLarkErrorCode(res)) {
    const server = res.status >= 500;
    const wire: Record<string, unknown> = {
      type: 'network',
      subtype: server ? 'server_error' : 'transport',
      message: `HTTP ${res.status}`,
    };
    if (server) wire.retryable = true;
    return failure(wire, identity);
  }
  const env = res.envelope ?? {};
  if (typeof env.code === 'number' && env.code !== 0) {
    const classified = classifyApiError(env, await deps.resolveAppId(), identity);
    return failure(classified.wire, identity, classified.authFailure);
  }
  return { ok: true, text: emitOk(await onSuccess(env.data), identity) };
}

// ─────────────────────────── 校验（移植 validateReadModeFlags / validateUpdateV2 子集） ───────────────────────────

/** 工具 schema 给不全锚点参数——与 lark-cli 一样在调用前拒（服务端也会再校验一次）。 */
function validateFetchScope(scope: string | undefined, identity: DocsAiIdentity): FeishuDocOutcome | null {
  switch (scope) {
    case undefined:
    case 'full':
    case 'outline':
      return null;
    case 'range': {
      const reason = 'provide --start-block-id or --end-block-id for range mode';
      return validationFailure('range mode requires --start-block-id or --end-block-id', identity, undefined, [
        { name: '--start-block-id', reason },
        { name: '--end-block-id', reason },
      ]);
    }
    case 'keyword':
      return validationFailure('keyword mode requires --keyword', identity, '--keyword');
    case 'section':
      return validationFailure('section mode requires --start-block-id', identity, '--start-block-id');
    default:
      return validationFailure(`invalid --scope ${goQuote(scope)}`, identity, '--scope');
  }
}

const CONTENT_REQUIRED_COMMANDS = new Set(['block_insert_after', 'block_replace', 'overwrite', 'append']);
const SRC_REQUIRED_COMMANDS = new Set(['block_copy_insert_after', 'block_move_after']);
const BLOCK_ID_REQUIRED_COMMANDS = new Set(['block_delete', 'block_insert_after', 'block_copy_insert_after', 'block_move_after', 'block_replace']);

function validateUpdate(req: FeishuDocUpdateReq, identity: DocsAiIdentity): FeishuDocOutcome | null {
  const cmd = req.command;
  if (cmd === 'str_replace' && !req.pattern) {
    return validationFailure('--command str_replace requires --pattern', identity, '--pattern');
  }
  if (BLOCK_ID_REQUIRED_COMMANDS.has(cmd) && !req.blockId) {
    return validationFailure(`--command ${cmd} requires --block-id`, identity, '--block-id');
  }
  if (SRC_REQUIRED_COMMANDS.has(cmd)) {
    // 工具 schema 没有 srcBlockIds 字段——与 lark-cli 缺 --src-block-ids 同款拒绝。
    // （lark-cli 的 content 互斥校验排在其后，本内核永远走不到，不移植死分支。）
    return validationFailure(`--command ${cmd} requires --src-block-ids`, identity, '--src-block-ids');
  }
  if (CONTENT_REQUIRED_COMMANDS.has(cmd) && !req.content) {
    return validationFailure(`--command ${cmd} requires --content`, identity, '--content');
  }
  return null;
}

// ─────────────────────────── body 构造（移植 build*Body） ───────────────────────────

const FETCH_EXTRA_PARAM = '{"enable_user_cite_reference_map":true,"return_html5_block_data":true}';

function buildFetchBody(req: FeishuDocFetchReq): Record<string, unknown> {
  const format = req.format ?? 'xml';
  const body: Record<string, unknown> = { format, extra_param: FETCH_EXTRA_PARAM };
  // detail 降级（对拍 effectiveFetchDetail）：非 xml 导出表达不了 with-ids/full，降 simple
  const detail = format === 'xml' ? (req.detail ?? 'simple') : 'simple';
  body.export_option =
    detail === 'with-ids'
      ? { export_block_id: true }
      : detail === 'full'
        ? { export_block_id: true, export_style_attrs: true, export_cite_extra_data: true }
        : { export_block_id: false, export_style_attrs: false, export_cite_extra_data: false };
  if (req.scope && req.scope !== 'full') body.read_option = { read_mode: req.scope };
  return body;
}

/** Go xml.EscapeText 同款转义（title 前置进 content 时防注入标签结构）。 */
function escapeDocTitle(title: string): string {
  return title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');
}

function buildCreateBody(req: FeishuDocCreateReq): Record<string, unknown> {
  const title = req.title?.trim();
  return {
    format: req.format ?? 'xml',
    content: title ? `<title>${escapeDocTitle(title)}</title>\n${req.content}` : req.content,
  };
}

function buildUpdateBody(req: FeishuDocUpdateReq): Record<string, unknown> {
  // append 是 block_insert_after 到文末的语法糖（对拍 buildUpdateBodyBase）
  const command = req.command === 'append' ? 'block_insert_after' : req.command;
  const body: Record<string, unknown> = { format: req.format ?? 'xml', command };
  if (req.content) body.content = req.content; // 空串不发送（str_replace 空 content=删除匹配）
  if (req.pattern) body.pattern = req.pattern;
  const blockId = req.command === 'append' ? '-1' : req.blockId;
  if (blockId) body.block_id = blockId;
  return body;
}

// ─────────────────────────── create 后处理（url 回落 + 授权授予） ───────────────────────────

/** 对拍 fallbackDocsCreateURLV2：服务端没给 url 时按品牌标准 URL 回填。 */
function fallbackDocUrl(data: Record<string, unknown> | undefined): void {
  const doc = isRecord(data?.document) ? (data!.document as Record<string, unknown>) : undefined;
  if (!doc) return;
  if (typeof doc.url === 'string' && doc.url.trim() !== '') return;
  const id = typeof doc.document_id === 'string' ? doc.document_id.trim() : '';
  if (id) doc.url = `${WWW_BASE}/docx/${id}`;
}

const GRANT_MEMBER_SCOPE = 'docs:permission.member:create';

/** 单个白名单条目的授予（对拍 autoGrantCurrentUserDrivePermission 的结果形状）。 */
async function grantOne(deps: DocsAiKernelDeps, docId: string, memberId: string): Promise<Record<string, unknown>> {
  const memberType = memberId.startsWith('ou_') ? 'openid' : 'unionid';
  const res = await deps.transport({
    method: 'POST',
    path: `/open-apis/drive/v1/permissions/${encodeURIComponent(docId)}/members`,
    params: { type: 'docx', need_notification: false },
    body: { member_type: memberType, member_id: memberId, perm: 'full_access', type: 'user' },
    timeoutMs: FEISHU_DOC_TIMEOUT_MS,
  });
  const base: Record<string, unknown> = { status: 'granted', perm: 'full_access' };
  base.user_open_id = memberId;
  base.member_type = memberType;
  const env = res.kind === 'ok' || res.kind === 'http' ? res.envelope : undefined;
  const code = env && typeof env.code === 'number' ? env.code : 0;
  if (res.kind === 'ok' && code === 0) {
    base.message = 'Granted the bonded Feishu user full_access on the new document.';
    return base;
  }
  // 失败：形状对拍 buildPermissionGrantResult + annotateGrantPermissionError
  base.status = 'failed';
  const reason = env?.msg ?? (res.kind === 'network' ? res.message : res.kind === 'http' ? `HTTP ${res.status}` : 'unknown error');
  base.message = `Resource was created, but granting the bonded Feishu user full_access failed: ${reason}. You can retry later or continue using bot identity.`;
  // 附加标注（lark_code/required_scope/console_url）只对 authorization 类错误——对拍
  // annotateGrantPermissionError 只认 PermissionError 的口径；其余失败留通用 hint
  if (env && CODE_META[code]?.category === 'authorization') {
    base.lark_code = code;
    const missing = extractMissingScopes(env);
    // required_scope：授予端点的推荐 scope 优先（对拍 registry 选取），否则取第一个缺失项
    const required = missing.includes(GRANT_MEMBER_SCOPE) ? GRANT_MEMBER_SCOPE : missing[0];
    if (required) {
      base.required_scope = required;
      const url = consoleUrl(await deps.resolveAppId(), [required]);
      if (url) {
        base.console_url = url;
        base.hint = `App is missing the "${required}" scope; enable it in the developer console (see console_url), then retry.`;
        return base;
      }
    }
  }
  base.hint = 'Retry later or grant permission manually via the Lark document UI.';
  return base;
}

/** 对拍 augmentDocsCreatePermission：bot 所建文档授权给飞书白名单条目（Oru 无「CLI 登录用户」概念）。
 * 整体 best-effort：授予阶段任何异常降级为 permission_grant failed——与仓里 chip「广播失败不翻转
 * 真实成功」同一不变量，绝不让已创建成功的文档因授予异常被回报成 create 失败。 */
async function augmentGrant(deps: DocsAiKernelDeps, data: Record<string, unknown> | undefined): Promise<void> {
  const doc = isRecord(data?.document) ? (data!.document as Record<string, unknown>) : undefined;
  const docId = typeof doc?.document_id === 'string' ? doc.document_id.trim() : '';
  if (!data || !docId) return;
  try {
    const grantees = (await deps.loadGrantees()).filter((id) => id.startsWith('ou_') || id.startsWith('on_'));
    if (grantees.length === 0) {
      data.permission_grant = {
        status: 'skipped',
        perm: 'full_access',
        message:
          'Resource was created with bot identity, but no bonded Feishu user is known, so full_access was not granted. You can grant permission manually via the Lark document UI.',
        hint: 'No bonded Feishu user in the platform whitelist. Pair a Feishu account first, or grant permission manually via the Lark document UI.',
      };
      return;
    }
    const results: Record<string, unknown>[] = [];
    for (const id of grantees) results.push(await grantOne(deps, docId, id));
    // 单条目与 lark-cli 同形态（对象）；多条目才数组
    data.permission_grant = results.length === 1 ? results[0] : results;
  } catch (e) {
    data.permission_grant = {
      status: 'failed',
      perm: 'full_access',
      message: `Resource was created, but granting the bonded Feishu user full_access failed: ${e instanceof Error ? e.message : String(e)}. You can retry later or continue using bot identity.`,
      hint: 'Retry later or grant permission manually via the Lark document UI.',
    };
  }
}

// ─────────────────────────── 内核 ───────────────────────────

export interface DocsAiKernelDeps {
  transport: DocsAiTransport;
  /** 授权授予对象 id 列表（飞书白名单条目；ou_/on_ 前缀判 member_type，其余忽略）。仅 bot 用。 */
  loadGrantees: () => Promise<readonly string[]>;
  /** console_url 的 clientID 来源（当前 appId；取不到则 console_url 省略）。 */
  resolveAppId: () => Promise<string | null>;
  /** 内核身份（默认 bot）——信封 identity 字段、create 授权授予（仅 bot）、授权面错误修复路径。 */
  identity?: DocsAiIdentity;
}

export function makeDocsAiKernel(deps: DocsAiKernelDeps): FeishuDocKernel {
  const identity = deps.identity ?? 'bot';
  return {
    async fetch(req) {
      const ref = parseDocumentRef(req.doc, identity);
      if ('error' in ref) return ref.error;
      const invalid = validateFetchScope(req.scope, identity);
      if (invalid) return invalid;
      const res = await deps.transport({
        method: 'POST',
        path: `/open-apis/docs_ai/v1/documents/${encodeURIComponent(ref.token)}/fetch`,
        body: buildFetchBody(req),
        timeoutMs: FEISHU_DOC_TIMEOUT_MS,
      });
      return toOutcome(res, deps, identity, async (data) => {
        // detail 降级警告（对拍 addFetchDetailDowngradeWarning）：写进 data.warnings
        if ((req.format ?? 'xml') !== 'xml' && (req.detail === 'with-ids' || req.detail === 'full') && data) {
          const warning = `--detail ${req.detail} is only supported with --doc-format xml; returning ${req.format} output and ignoring the unsupported detail option`;
          const existing = data.warnings;
          data.warnings = Array.isArray(existing) ? [...existing, warning] : [warning];
        }
        return data;
      });
    },

    async create(req) {
      const res = await deps.transport({
        method: 'POST',
        path: '/open-apis/docs_ai/v1/documents',
        body: buildCreateBody(req),
        timeoutMs: FEISHU_DOC_TIMEOUT_MS,
      });
      return toOutcome(res, deps, identity, async (data) => {
        // 后处理对拍 executeCreateV2：url 回落两身份同；授权授予仅 bot（user 所建文档归本人，无需 grant）
        if (data) {
          fallbackDocUrl(data);
          if (identity === 'bot') await augmentGrant(deps, data);
        }
        return data;
      });
    },

    async update(req) {
      const ref = parseDocumentRef(req.doc, identity);
      if ('error' in ref) return ref.error;
      const invalid = validateUpdate(req, identity);
      if (invalid) return invalid;
      const res = await deps.transport({
        method: 'PUT',
        path: `/open-apis/docs_ai/v1/documents/${encodeURIComponent(ref.token)}`,
        body: buildUpdateBody(req),
        timeoutMs: FEISHU_DOC_TIMEOUT_MS,
      });
      return toOutcome(res, deps, identity, async (data) => data);
    },
  };
}
