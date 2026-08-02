/**
 * 飞书 scope 一键开通（tech design §A，体验优化研究 §A/落地清单①）——
 * 让首次「开哪些权限」从一项项找变成点 Oru 给的一键深链全部预勾。
 *
 * 承重纯逻辑（可单测）：
 * - parseSchemaScopes：从 `lark-cli schema <svc.res.method>` 的 `_meta.scopes` 取 scope（飞书改了跟着变）。
 * - computeRequiredScopes：schema 能算的自动算、算不出（docs 等非 schema 服务）用 PoC 实证种子，取并集。
 * - buildScopeAuthLink：拼飞书原生权限申请深链（格式取自 lark-cli 二进制内模板 `/app/%s/auth?q=%s`）。
 * - parseAppScopes / checkAppScopes：走 `auth scopes` 查**应用已开通** scope（与登录身份无关），算缺哪项。
 *   不用 `auth check`（只验当前用户 OAuth token，bot 身份下没人登录会恒报 not_logged_in 假阴性）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseSchemaScopes,
  buildScopeAuthLink,
  parseAppScopes,
  checkAppScopes,
  computeRequiredScopes,
} from '../../electron/main/platform/feishuScope';
import type { LarkCliResult } from '../../electron/main/platform/feishuCli';

/** fake runLarkCli：只给 checkAppScopes 用到的承重子集，satisfies 防接口漂移假绿。 */
type ScopeRunResult = Pick<LarkCliResult, 'stdout' | 'stderr' | 'authFailure'>;
const fakeRun = (res: Partial<ScopeRunResult>) =>
  vi.fn(
    async (): Promise<ScopeRunResult> =>
      ({ stdout: '', stderr: '', authFailure: { needsReauth: false }, ...res }) satisfies ScopeRunResult,
  );

// 真实 `lark-cli schema im.reactions.create` 输出片段（含 _meta.scopes）
const REACTION_SCHEMA = JSON.stringify({
  name: 'im reactions create',
  inputSchema: { type: 'object' },
  _meta: {
    scopes: ['im:message', 'im:message.reactions:write_only'],
    required_scopes: [],
    danger: true,
  },
});

describe('parseSchemaScopes', () => {
  it('从 _meta.scopes 取 scope 列表', () => {
    expect(parseSchemaScopes(REACTION_SCHEMA)).toEqual(['im:message', 'im:message.reactions:write_only']);
  });
  it('无 _meta / 非 JSON / 结构错都返回空（不抛）', () => {
    expect(parseSchemaScopes('{}')).toEqual([]);
    expect(parseSchemaScopes('not json')).toEqual([]);
    expect(parseSchemaScopes(JSON.stringify({ _meta: { scopes: 'x' } }))).toEqual([]);
  });
});

describe('buildScopeAuthLink', () => {
  it('拼飞书原生权限申请深链（逗号分隔 scope，无空格）', () => {
    const link = buildScopeAuthLink('cli_abc', ['docx:document', 'im:message']);
    expect(link).toBe('https://open.feishu.cn/app/cli_abc/auth?q=docx:document,im:message');
    expect(link).not.toMatch(/\s/); // q 值无空格（CLI 检测正则要求）
  });
  it('lark 品牌走 larksuite 域名', () => {
    expect(buildScopeAuthLink('cli_abc', ['im:message'], 'lark')).toBe(
      'https://open.larksuite.com/app/cli_abc/auth?q=im:message',
    );
  });
});

describe('parseAppScopes', () => {
  // 真实 `auth scopes --json` 带前导行（CLI 先打 "Querying app scopes..." 再吐 JSON）
  const withPreamble = (obj: unknown) => `Querying app scopes...\n\n${JSON.stringify(obj)}`;

  it('剥前导行后从 userScopes 取已开通 scope', () => {
    const out = withPreamble({ appId: 'cli_x', tokenType: 'user', userScopes: ['im:message', 'docx:document'] });
    expect(parseAppScopes(out)).toEqual(['im:message', 'docx:document']);
  });
  it('取 userScopes ∪ tenantScopes 并集去重（身份不同字段不同，不能只读一个）', () => {
    const out = JSON.stringify({
      userScopes: ['docx:document', 'im:message'],
      tenantScopes: ['im:message', 'im:message.reactions:write_only'],
    });
    expect(parseAppScopes(out)?.sort()).toEqual(['docx:document', 'im:message', 'im:message.reactions:write_only']);
  });
  it('合法 JSON 但无 scope 字段 → 空数组（应用真没开通，区别于查不了）', () => {
    expect(parseAppScopes(JSON.stringify({ appId: 'cli_x', count: 0 }))).toEqual([]);
  });
  it('解析不出 JSON 对象 → null（表示查不了，非"没开通"）', () => {
    expect(parseAppScopes('boom no json here')).toBeNull();
    expect(parseAppScopes('')).toBeNull();
  });
});

describe('checkAppScopes', () => {
  const okJson = (scopes: string[]) => JSON.stringify({ tokenType: 'user', count: scopes.length, userScopes: scopes });

  it('所需全部已开通 → ok，无 missing', async () => {
    const run = fakeRun({ stdout: okJson(['im:message', 'docx:document', 'docx:document:create']) });
    const r = await checkAppScopes(['im:message', 'docx:document'], run);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.granted).toEqual(['im:message', 'docx:document']);
  });

  it('缺一项 → ok:false + 只列缺的那项 + 已开通归入 granted', async () => {
    const run = fakeRun({ stdout: okJson(['im:message', 'docx:document']) });
    const r = await checkAppScopes(['im:message', 'im:message.reactions:write_only', 'docx:document'], run);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['im:message.reactions:write_only']);
    expect(r.granted).toEqual(['im:message', 'docx:document']);
    expect(r.error).toBeUndefined();
  });

  it('回归：真机完整输出（含前导行/全字段）端到端解析正确，且不依赖用户登录', async () => {
    // 旧 auth check 在"无用户登录"下吐 {error:"not_logged_in", missing:[全部]} 假报全缺；
    // auth scopes 用应用凭证查、带 "Querying app scopes..." 前导行——验证整条真机形态算得对
    const stdout = `Querying app scopes...\n\n${JSON.stringify({
      appId: 'cli_x',
      brand: 'feishu',
      count: 2,
      tokenType: 'user',
      userScopes: ['im:message', 'docx:document'],
    })}`;
    const r = await checkAppScopes(['im:message', 'docx:document'], fakeRun({ stdout }));
    expect(r.ok).toBe(true);
    expect(r.granted).toEqual(['im:message', 'docx:document']);
    expect(r.error).toBeUndefined();
  });

  it('CLI 失败/解析不出 → error 态：不假报"缺权限"（missing 留空，UI 不引导申请）', async () => {
    const run = fakeRun({ stdout: '', stderr: 'connection refused', authFailure: { needsReauth: false } });
    const r = await checkAppScopes(['im:message'], run);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([]); // 关键：不能算成"缺 im:message → 点这申请"
    expect(r.error).toBeTruthy();
  });

  it('认证失效 → error 透出 CLI 的 hint（引导重新授权，而非沉默或假装缺权限）', async () => {
    const run = fakeRun({ stderr: '', authFailure: { needsReauth: true, hint: '飞书未配置，先填 App Secret' } });
    const r = await checkAppScopes(['im:message'], run);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('飞书未配置');
  });
});

describe('computeRequiredScopes', () => {
  it('schema 能算的自动算 + 非 schema 的静态种子，取并集去重排序', async () => {
    // runSchema fake：reactions 返回 schema scope；其它 path 不会被调（docs 走静态种子）
    const runSchema = vi.fn(async (path: string) =>
      path === 'im.reactions.create' ? ['im:message', 'im:message.reactions:write_only'] : [],
    );
    const scopes = await computeRequiredScopes(runSchema);
    // 含 reactions schema scope + docs PoC 种子
    expect(scopes).toContain('im:message');
    expect(scopes).toContain('im:message.reactions:write_only');
    expect(scopes).toContain('docx:document');
    expect(scopes).toContain('docx:document:create');
    // 去重 + 排序
    expect(scopes).toEqual([...new Set(scopes)].sort());
    expect(runSchema).toHaveBeenCalledWith('im.reactions.create');
  });

  it('schema 调用失败（返回空）回退到该能力的种子，不产出缺权限的链接', async () => {
    const runSchema = vi.fn(async () => [] as string[]); // 全部 schema 失败
    const scopes = await computeRequiredScopes(runSchema);
    // 回退种子仍覆盖 reactions + docs
    expect(scopes).toContain('im:message');
    expect(scopes).toContain('im:message.reactions:write_only');
    expect(scopes).toContain('docx:document');
  });
});
