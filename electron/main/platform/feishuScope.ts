/**
 * 飞书 scope 一键开通（tech design §A，体验优化研究 §A/落地清单①）——
 * 把「首次要开哪些权限、要一项项找」变成「点 Oru 给的一键深链，全部预勾、确认+发布」。
 *
 * scope 来源分两路（第一性：能自动算就别手维护，算不出的才静态种子，且标清来源）：
 *  - **schema 自动算**：对 API 式能力跑 `lark-cli schema <svc.res.method>`，取 `_meta.scopes`——
 *    飞书改了 scope 要求会跟着变，不手维护。
 *  - **静态种子**：docs 等是 `+create` 短命令、非 schema 服务（`schema docs.*` 报 Unknown service），
 *    其 scope 由真凭证 PoC 实证（docx:document + docx:document:create，§7/§10 假设 C），静态登记。
 *
 * 深链格式取自 lark-cli 二进制内权威模板 `https://%s/app/%s/auth?q=%s`（逗号分隔 scope、无空格）。
 */
import { runLarkCli, type LarkCliResult } from './feishuCli';

/** Oru 用到的能力 → 所需 scope。schemaPath 存在则 schema 自动算、种子作失败回退；否则纯静态种子。 */
interface ScopeCapability {
  key: string;
  /** `lark-cli schema <path>` 路径；存在则自动算 scope（飞书改了跟着变）。 */
  schemaPath?: string;
  /** schemaPath 缺省时的静态 scope；有 schemaPath 时作为 schema 失败的回退（避免产出缺权限的链接）。 */
  scopes: string[];
}

/**
 * 第一期能力清单（milestone 1）：
 * - 收发消息 + 表情回应：adapter 自身能力。`im:message` 是「获取与发送单聊/群组消息」总伞，覆盖收+发；
 *   表情回应另需 `im:message.reactions:write_only`。两者由 `schema im.reactions.create` 自动算。
 * - 写飞书文档：agent 跑 `lark-cli docs +create`。docs 非 schema 服务，scope 由 PoC 实证、静态种子。
 * 加第二个能力（base/sheets/calendar…）= 往这里加一行（API 式给 schemaPath、自动算）。
 */
const LARK_CAPABILITIES: ScopeCapability[] = [
  { key: 'im-messaging', schemaPath: 'im.reactions.create', scopes: ['im:message', 'im:message.reactions:write_only'] },
  { key: 'docs-write', scopes: ['docx:document', 'docx:document:create'] },
  // 绑定白名单时抓发话人昵称（contact.v3.user.get）——静态种子（schema contact.* 报 Unknown service）。
  { key: 'contact-read', scopes: ['contact:user.base:readonly'] },
];

const SCOPE_DOMAIN = { feishu: 'open.feishu.cn', lark: 'open.larksuite.com' } as const;
export type Brand = keyof typeof SCOPE_DOMAIN;

/** 从 `lark-cli schema <path>` 输出取 `_meta.scopes`；无 / 非法一律空数组（不抛）。 */
export function parseSchemaScopes(output: string): string[] {
  try {
    const o = JSON.parse(output) as { _meta?: { scopes?: unknown } };
    const s = o._meta?.scopes;
    return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 飞书原生权限申请深链：`https://{domain}/app/{appId}/auth?q={scope1,scope2}`（逗号分隔、无空格）。 */
export function buildScopeAuthLink(appId: string, scopes: string[], brand: Brand = 'feishu'): string {
  return `https://${SCOPE_DOMAIN[brand]}/app/${appId}/auth?q=${scopes.join(',')}`;
}

export interface ScopeGapResult {
  ok: boolean;
  /** 所需 ∩ 应用已开通。 */
  granted: string[];
  /** 所需 − 应用已开通（真缺，给「点这申请」深链）。 */
  missing: string[];
  /** 查不了（CLI 失败 / 未配置 / 解析不出）时的提示——区别于"真缺权限"，UI 不引导申请。 */
  error?: string;
}

/**
 * 从 `lark-cli auth scopes --json` 输出取应用已开通 scope 集合（`userScopes ∪ tenantScopes`）。
 * CLI 先打 "Querying app scopes..." 前导行再吐 JSON——从首个 `{` 起 parse。
 * 解析不出 JSON 对象返回 **null**（表示"查不了"），区别于返回 `[]` 的"应用没开通任何 scope"。
 * 身份不同 CLI 输出字段不同（user→`userScopes` / tenant→`tenantScopes`），两者都读、取并集，避免换身份读空假报缺。
 */
export function parseAppScopes(output: string): string[] | null {
  const start = output.indexOf('{');
  if (start < 0) return null;
  let o: { userScopes?: unknown; tenantScopes?: unknown } | null;
  try {
    o = JSON.parse(output.slice(start));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return [...new Set([...strs(o.userScopes), ...strs(o.tenantScopes)])];
}

/**
 * 算出 Oru 需要的全部 scope 并集（schema 为准、种子兜底；去重排序）。runSchema 注入便于测试瞬时化。
 * schema 算出非空则以它为准（飞书改了跟着变）；算不出 / 失败回退该能力的静态种子（不产出缺权限的链接）。
 */
export async function computeRequiredScopes(runSchema: (path: string) => Promise<string[]>): Promise<string[]> {
  const all = new Set<string>();
  for (const cap of LARK_CAPABILITIES) {
    const derived = cap.schemaPath ? await runSchema(cap.schemaPath) : [];
    const scopes = derived.length ? derived : cap.scopes;
    for (const s of scopes) all.add(s);
  }
  return [...all].sort();
}

/** 跑 `lark-cli schema <path>` 并取 scope（真实接线；computeRequiredScopes 的生产 runSchema）。 */
async function runSchemaScopes(path: string): Promise<string[]> {
  const res = await runLarkCli(['schema', path], { timeoutMs: 30_000 });
  return parseSchemaScopes(res.stdout);
}

/**
 * Oru 需要的全部 scope 并集（真实接线；scope link 与 doctor 自检共用，单一来源）。
 * 进程内缓存：所需 scope 一个会话内确定，避免重复点「检查 / 一键开通」反复 spawn schema（npx 慢）。
 */
let cachedScopes: Promise<string[]> | null = null;
export function getRequiredScopes(): Promise<string[]> {
  return (cachedScopes ??= computeRequiredScopes(runSchemaScopes));
}

/** 算出所需 scope（跑 CLI）并拼一键开权限深链（设置页「一键开通权限」按钮后端）。 */
export async function resolveScopeSetup(appId: string, brand: Brand = 'feishu'): Promise<{ link: string; scopes: string[] }> {
  const scopes = await getRequiredScopes();
  return { link: buildScopeAuthLink(appId, scopes, brand), scopes };
}

/** 注入的 lark-cli 执行器（取承重子集，便于测试瞬时化）。 */
type ScopeRunner = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<Pick<LarkCliResult, 'stdout' | 'stderr' | 'authFailure'>>;

/**
 * 验证 Oru 所需 scope 是否已在应用开通（设置页「检查」用）。走 `auth scopes`（查**应用**已开通、与登录身份无关）——
 * 不用 `auth check`（只验当前用户 OAuth token，bot 身份下没人登录会恒报 `not_logged_in` + 全 missing 假阴性）。
 * 三态：齐全(`ok`) / 真缺(`missing` 非空) / 查不了(`error`，`missing` 留空、UI 不引导申请)。run 注入便于测试。
 */
export async function checkAppScopes(required: string[], run: ScopeRunner = runLarkCli): Promise<ScopeGapResult> {
  const res = await run(['auth', 'scopes', '--json'], { timeoutMs: 30_000 });
  // 成功走 stdout、结构化错误可能走 stderr——两边取能解析出 scope 集合的
  const enabled = parseAppScopes(res.stdout) ?? parseAppScopes(res.stderr);
  if (!enabled) {
    // 认证失效与连接失败导向不同的用户动作（重新授权 vs 查 CLI/网络），分开兜底
    const fallback = res.authFailure.needsReauth ? '认证失效，请重新配置飞书凭证' : '检查权限失败，请确认 CLI 配置与网络';
    return { ok: false, granted: [], missing: [], error: res.authFailure.hint ?? fallback };
  }
  const set = new Set(enabled);
  const granted = required.filter((s) => set.has(s));
  const missing = required.filter((s) => !set.has(s));
  return { ok: missing.length === 0, granted, missing };
}
