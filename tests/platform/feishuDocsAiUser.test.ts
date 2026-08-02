/**
 * feishuDocsAi —— user 身份内核（S5：进程内 UAT，取代 lark-cli user 路径）。
 *
 * 对拍基准不变（lark-cli v2 信封形状），user 身份的刻意差异（必测）：
 *  1. 成功/错误信封 identity = "user"（bot 是 "bot"，分流证据）。
 *  2. create 不做授权授予——user 所建文档归本人，无需 grant；url 回落仍在。
 *  3. no-user-token transport 结果 → authentication/token_missing + needsReauth +
 *     中文指引（「设置 ▸ 平台连接」，不再指向 lark-cli auth login）。
 *  4. missing_scope / token_scope_insufficient（user 授权面问题）→ needsReauth
 *     （重新授权带新 scope 是修复路径）；hint 指向设置页重授权，不含 lark-cli。
 *  5. app_scope_not_applied 维持 bot 语义（应用层问题，不是 user 重授权能修的）。
 *
 * 依赖全注入（transport / loadGrantees / resolveAppId），不碰真网络与真凭证文件。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  makeDocsAiKernel,
  type DocsAiTransport,
  type DocsAiTransportResult,
  type FeishuDocKernel,
} from '../../electron/main/platform/feishuDocsAi';

const APP_ID = 'cli_testapp';
type Envelope = Record<string, unknown>;

const okWith = (envelope: Envelope): DocsAiTransportResult => ({ kind: 'ok', envelope });

function makeTransport(result: DocsAiTransportResult | (() => DocsAiTransportResult)) {
  const fn = typeof result === 'function' ? result : () => result;
  return vi.fn<DocsAiTransport>(async () => fn());
}

function makeUserKernel(
  transport: DocsAiTransport,
  opts?: { appId?: string | null },
): FeishuDocKernel {
  return makeDocsAiKernel({
    transport,
    loadGrantees: async () => [],
    resolveAppId: async () => (opts?.appId === undefined ? APP_ID : opts.appId),
    identity: 'user',
  });
}

describe('user 内核 —— 信封 identity', () => {
  it('fetch 成功：{ok:true, identity:"user", data}，2 空格缩进 + 尾换行', async () => {
    const transport = makeTransport(okWith({ code: 0, data: { document: { content: '<p>正文</p>' } } }));
    const r = await makeUserKernel(transport).fetch({ doc: 'ABC' });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('{\n  "ok": true,\n  "identity": "user",\n  "data": {\n    "document": {\n      "content": "<p>正文</p>"\n    }\n  }\n}\n');
  });

  it('update 成功信封 identity 同为 user；校验失败信封也是 user', async () => {
    const transport = makeTransport(okWith({ code: 0, data: {} }));
    const kernel = makeUserKernel(transport);
    const ok = await kernel.update({ doc: 'ABC', command: 'append', content: '<p>x</p>' });
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain('"identity": "user"');
    const bad = await kernel.update({ doc: 'ABC', command: 'str_replace' }); // 缺 pattern
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('"identity": "user"');
  });
});

describe('user 内核 —— create 不授权授予', () => {
  it('user create：url 回落在，但不打 permissions 端点、data 无 permission_grant', async () => {
    const calls: string[] = [];
    const transport = vi.fn<DocsAiTransport>(async (req) => {
      calls.push(req.path);
      return okWith({ code: 0, data: { document: { document_id: 'NEW1' } } });
    });
    const kernel = makeUserKernel(transport);
    const r = await kernel.create({ content: '<p>a</p>' });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['/open-apis/docs_ai/v1/documents']); // 只有 create，无 grant
    const data = JSON.parse(r.text) as { data: { document: { url?: string }; permission_grant?: unknown } };
    expect(data.data.document.url).toBe('https://www.feishu.cn/docx/NEW1'); // url 回落仍在
    expect(data.data.permission_grant).toBeUndefined();
  });
});

describe('user 内核 —— 授权面错误', () => {
  it('no-user-token → authentication/token_missing + needsReauth + 设置页中文指引', async () => {
    const kernel = makeUserKernel(makeTransport({ kind: 'no-user-token' }));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.authFailure.needsReauth).toBe(true);
    expect(r.authFailure.hint).toContain('设置 ▸ 平台连接');
    expect(r.authFailure.hint).not.toContain('lark-cli');
    const wire = JSON.parse(r.text) as { identity: string; error: { type: string; subtype: string; hint: string } };
    expect(wire.identity).toBe('user');
    expect(wire.error.type).toBe('authentication');
    expect(wire.error.subtype).toBe('token_missing');
    expect(wire.error.hint).toContain('设置 ▸ 平台连接');
  });

  it('99991679 missing_scope → needsReauth（重授权带新 scope）；hint 指向设置页、不含 lark-cli', async () => {
    const kernel = makeUserKernel(
      makeTransport(
        okWith({
          code: 99991679,
          msg: 'no scope',
          error: { permission_violations: [{ subject: 'docx:document' }] },
        }),
      ),
    );
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.authFailure.needsReauth).toBe(true);
    const wire = JSON.parse(r.text) as { identity: string; error: { subtype: string; hint: string; missing_scopes: string[] } };
    expect(wire.identity).toBe('user');
    expect(wire.error.subtype).toBe('missing_scope');
    expect(wire.error.missing_scopes).toEqual(['docx:document']);
    expect(wire.error.hint).not.toContain('lark-cli');
    expect(wire.error.hint).toContain('设置');
  });

  it('99991672 app_scope_not_applied → 应用层问题，不算 user 重授权（needsReauth=false）', async () => {
    const kernel = makeUserKernel(
      makeTransport(okWith({ code: 99991672, msg: 'no scope', error: { permission_violations: [{ subject: 'docx:document' }] } })),
    );
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.authFailure.needsReauth).toBe(false);
    const wire = JSON.parse(r.text) as { identity: string; error: { subtype: string; console_url?: string } };
    expect(wire.identity).toBe('user');
    expect(wire.error.subtype).toBe('app_scope_not_applied');
    expect(wire.error.console_url).toContain('scope-apply');
  });

  it('99991677 token_expired（重试一次仍败的残余）→ authentication + needsReauth', async () => {
    const kernel = makeUserKernel(makeTransport(okWith({ code: 99991677, msg: 'expired' })));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.authFailure.needsReauth).toBe(true);
  });
});
