/**
 * feishuDocsAi —— S4 文档工具内核换 SDK（bot 身份进程内 docs_ai 调用）。
 *
 * 对拍基准：lark-cli v2 路径（上游 github.com/larksuite/cli shortcuts/doc/*_v2.go）——
 * 三个 op 都是 docs_ai 单端点薄封装（fetch=POST …/fetch、create=POST …/documents、
 * update=PUT …/documents/{token}），本内核移植其 body 构造、校验、错误分类（errclass）
 * 与输出信封（{ok, identity, data|error}，envelope/error 键序对拍 Go struct 声明序、
 * 2 空格缩进、尾换行；data 载荷透传服务端键序——键序非形态，不对拍 Go map 字典序）。
 *
 * 验七件承重事：
 *  1. body 构造对拍：fetch（format/extra_param/export_option/read_option）、
 *     create（title 前置 + XML 转义）、update（append→block_insert_after+block_id "-1"、
 *     空 content 不发送）。
 *  2. 校验对拍：range/keyword/section 缺锚点、copy/move 缺 src-block-ids、content 必填、
 *     pattern 必填、非法 doc ref——错误信封与 lark-cli 逐字一致，且不触达 transport。
 *  3. 成功信封形态：{ok:true, identity:"bot", data} 声明序键、2 空格缩进、尾换行。
 *  4. 错误分类：99991672→authorization/app_scope_not_applied（missing_scopes/console_url/
 *     canonical message/hint）；authentication/config → authFailure（对齐 S2 结构化错误）；
 *     未知码 → api/unknown；log_id / troubleshooter / details 提升。
 *  5. bot create 授权授予：白名单条目按 id 前缀（ou_→openid / on_→unionid）授 full_access；
 *     成功 granted / 失败带 scope 标注（required_scope/console_url）/ 无条目 skipped。
 *  6. transport 层：client 缓存（同凭证复用、凭证变更重建）、无凭证 not-configured、
 *     axios 形态异常映射（HTTP 带信封 / 超时 / 传输）。
 *  7. 脱敏：输出文本过 redactSecrets（t-/u- token 不外泄）。
 *
 * 依赖全注入（transport / loadGrantees / resolveAppId / getCredential / makeClient），
 * 不碰真网络与真凭证文件；mock 受 DocsAiTransport 等类型约束（仓规 satisfies 精神）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { WhitelistEntry } from '@shared/types';
import {
  makeDocsAiKernel,
  makeSdkTransport,
  selectGrantees,
  FEISHU_DOC_TIMEOUT_MS,
  type DocsAiTransport,
  type DocsAiTransportResult,
  type FeishuDocKernel,
  type SdkClient,
} from '../../electron/main/platform/feishuDocsAi';

// ─────────────────────────── 测试夹具 ───────────────────────────

const APP_ID = 'cli_testapp';

type Envelope = Record<string, unknown>;

const okWith = (envelope: Envelope): DocsAiTransportResult => ({ kind: 'ok', envelope });

function makeTransport(result: DocsAiTransportResult | ((req: TransportReq) => DocsAiTransportResult)) {
  const fn = typeof result === 'function' ? result : () => result;
  return vi.fn<DocsAiTransport>(async (req) => fn(req as TransportReq));
}
type TransportReq = Parameters<DocsAiTransport>[0];

function makeKernel(
  transport: DocsAiTransport,
  opts?: { grantees?: string[]; appId?: string | null },
): FeishuDocKernel {
  return makeDocsAiKernel({
    transport,
    loadGrantees: async () => opts?.grantees ?? [],
    resolveAppId: async () => opts?.appId === undefined ? APP_ID : opts.appId,
  });
}

/** 成功 fetch 的 docs_ai 响应信封。 */
const FETCH_ENVELOPE = {
  code: 0,
  msg: 'success',
  data: { document: { content: '<p>正文</p>', document_id: 'ABC', revision_id: 3 } },
};

// ─────────────────────────── fetch body 构造 ───────────────────────────

describe('fetch body 构造（对拍 buildFetchBody）', () => {
  it('默认：format xml + extra_param + export_option 全 false，无 read_option', async () => {
    const transport = makeTransport(okWith(FETCH_ENVELOPE));
    const kernel = makeKernel(transport);
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    const req = transport.mock.calls[0]![0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/open-apis/docs_ai/v1/documents/ABC/fetch');
    expect(req.timeoutMs).toBe(FEISHU_DOC_TIMEOUT_MS);
    expect(req.body).toEqual({
      format: 'xml',
      extra_param: '{"enable_user_cite_reference_map":true,"return_html5_block_data":true}',
      export_option: {
        export_block_id: false,
        export_style_attrs: false,
        export_cite_extra_data: false,
      },
    });
  });

  it('doc 为 URL 时抽取 token（docx / wiki 标记）', async () => {
    const transport = makeTransport(okWith(FETCH_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.fetch({ doc: 'https://my.feishu.cn/docx/TOK123?from=chat' });
    expect(transport.mock.calls[0]![0].path).toBe('/open-apis/docs_ai/v1/documents/TOK123/fetch');
    await kernel.fetch({ doc: 'https://my.feishu.cn/wiki/WIKI456#share-x' });
    expect(transport.mock.calls[1]![0].path).toBe('/open-apis/docs_ai/v1/documents/WIKI456/fetch');
  });

  it('detail=with-ids → 仅 export_block_id；detail=full → 三项全开', async () => {
    const transport = makeTransport(okWith(FETCH_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.fetch({ doc: 'ABC', detail: 'with-ids' });
    expect(transport.mock.calls[0]![0].body?.export_option).toEqual({ export_block_id: true });
    await kernel.fetch({ doc: 'ABC', detail: 'full' });
    expect(transport.mock.calls[1]![0].body?.export_option).toEqual({
      export_block_id: true,
      export_style_attrs: true,
      export_cite_extra_data: true,
    });
  });

  it('format=markdown → body.format markdown；scope=outline → read_option', async () => {
    const transport = makeTransport(okWith(FETCH_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.fetch({ doc: 'ABC', format: 'markdown', scope: 'outline' });
    const body = transport.mock.calls[0]![0].body;
    expect(body?.format).toBe('markdown');
    expect(body?.read_option).toEqual({ read_mode: 'outline' });
  });

  it('scope=full → 不带 read_option（服务端默认全文路径）', async () => {
    const transport = makeTransport(okWith(FETCH_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.fetch({ doc: 'ABC', scope: 'full' });
    expect(transport.mock.calls[0]![0].body).not.toHaveProperty('read_option');
  });

  it('markdown + detail=with-ids → export_option 降级 simple 且 data.warnings 追加', async () => {
    const transport = makeTransport(okWith(FETCH_ENVELOPE));
    const kernel = makeKernel(transport);
    const r = await kernel.fetch({ doc: 'ABC', format: 'markdown', detail: 'with-ids' });
    const body = transport.mock.calls[0]![0].body;
    expect(body?.export_option).toEqual({
      export_block_id: false,
      export_style_attrs: false,
      export_cite_extra_data: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('warnings');
      expect(r.text).toContain('--detail with-ids is only supported with --doc-format xml');
    }
  });
});

// ─────────────────────────── fetch 校验对拍 ───────────────────────────

describe('fetch 校验（对拍 validateReadModeFlags，不触达 transport）', () => {
  it.each([
    ['range', 'range mode requires --start-block-id or --end-block-id'],
    ['keyword', 'keyword mode requires --keyword'],
    ['section', 'section mode requires --start-block-id'],
  ] as const)('scope=%s 缺锚点 → validation 错误信封', async (scope, message) => {
    const transport = makeTransport(okWith(FETCH_ENVELOPE));
    const kernel = makeKernel(transport);
    const r = await kernel.fetch({ doc: 'ABC', scope });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { ok: boolean; identity: string; error: Record<string, unknown> };
      expect(env.ok).toBe(false);
      expect(env.identity).toBe('bot');
      expect(env.error.type).toBe('validation');
      expect(env.error.subtype).toBe('invalid_argument');
      expect(env.error.message).toBe(message);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('range 的 params 双条目与 lark-cli 逐字一致', async () => {
    const kernel = makeKernel(makeTransport(okWith(FETCH_ENVELOPE)));
    const r = await kernel.fetch({ doc: 'ABC', scope: 'range' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { error: { params: unknown } };
      expect(env.error.params).toEqual([
        { name: '--start-block-id', reason: 'provide --start-block-id or --end-block-id for range mode' },
        { name: '--end-block-id', reason: 'provide --start-block-id or --end-block-id for range mode' },
      ]);
    }
  });

  it('非法 doc ref：含 :// 无标记 / 裸 token 含斜杠 → validation 错误', async () => {
    const transport = makeTransport(okWith(FETCH_ENVELOPE));
    const kernel = makeKernel(transport);
    const r1 = await kernel.fetch({ doc: 'https://example.com/foo/ABC' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.text).toContain(
        'unsupported --doc input \\"https://example.com/foo/ABC\\": use a docx URL/token or a wiki URL that resolves to docx',
      );
    }
    const r2 = await kernel.fetch({ doc: 'AB/C' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.text).toContain('unsupported --doc input \\"AB/C\\": use a docx token or a wiki URL');
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── create body 构造 ───────────────────────────

describe('create body 构造（对拍 buildCreateBody）', () => {
  const CREATE_ENVELOPE = {
    code: 0,
    msg: 'success',
    data: { document: { document_id: 'NEW1', revision_id: 3, url: 'https://my.feishu.cn/docx/NEW1' } },
  };

  it('无 title：{format, content} 原样', async () => {
    const transport = makeTransport(okWith(CREATE_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.create({ content: '<p>正文</p>' });
    const req = transport.mock.calls[0]![0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/open-apis/docs_ai/v1/documents');
    expect(req.body).toEqual({ format: 'xml', content: '<p>正文</p>' });
  });

  it('有 title：前置 <title>…</title>\\n，XML 特殊字符转义（Go xml.EscapeText 同款）', async () => {
    const transport = makeTransport(okWith(CREATE_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.create({ title: 'A&B <周记> "v1" \'x\'', content: '<p>c</p>' });
    expect(transport.mock.calls[0]![0].body?.content).toBe(
      '<title>A&amp;B &lt;周记&gt; &#34;v1&#34; &#39;x&#39;</title>\n<p>c</p>',
    );
  });

  it('format=markdown → body.format markdown', async () => {
    const transport = makeTransport(okWith(CREATE_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.create({ content: '## 目标', format: 'markdown' });
    expect(transport.mock.calls[0]![0].body?.format).toBe('markdown');
  });

  it('服务端缺 url → 回落 https://www.feishu.cn/docx/<id>；有 url → 保留', async () => {
    const noUrl = { code: 0, data: { document: { document_id: 'NEW2', revision_id: 3 } } };
    const kernel = makeKernel(makeTransport(okWith(noUrl)));
    const r = await kernel.create({ content: '<p>c</p>' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const env = JSON.parse(r.text) as { data: { document: { url: string } } };
      expect(env.data.document.url).toBe('https://www.feishu.cn/docx/NEW2');
    }
  });
});

// ─────────────────────────── bot create 授权授予 ───────────────────────────

describe('bot create 授权授予（对拍 augmentDocsCreatePermission）', () => {
  const CREATE_ENVELOPE = {
    code: 0,
    data: { document: { document_id: 'NEW1', revision_id: 3, url: 'https://my.feishu.cn/docx/NEW1' } },
  };

  it('白名单 ou_ 条目 → openid 授 full_access；on_ → unionid', async () => {
    const transport = makeTransport((req) =>
      req.path === '/open-apis/docs_ai/v1/documents' ? okWith(CREATE_ENVELOPE) : okWith({ code: 0, data: {} }),
    );
    const kernel = makeKernel(transport, { grantees: ['ou_aaa', 'on_bbb'] });
    await kernel.create({ content: '<p>c</p>' });
    expect(transport).toHaveBeenCalledTimes(3);
    const g1 = transport.mock.calls[1]![0];
    expect(g1.method).toBe('POST');
    expect(g1.path).toBe('/open-apis/drive/v1/permissions/NEW1/members');
    expect(g1.params).toEqual({ type: 'docx', need_notification: false });
    expect(g1.body).toEqual({ member_type: 'openid', member_id: 'ou_aaa', perm: 'full_access', type: 'user' });
    const g2 = transport.mock.calls[2]![0];
    expect(g2.body).toEqual({ member_type: 'unionid', member_id: 'on_bbb', perm: 'full_access', type: 'user' });
  });

  it('授予成功 → permission_grant status granted（单条目与 lark-cli 同形态对象）', async () => {
    const transport = makeTransport((req) =>
      req.path === '/open-apis/docs_ai/v1/documents' ? okWith(CREATE_ENVELOPE) : okWith({ code: 0, data: {} }),
    );
    const kernel = makeKernel(transport, { grantees: ['ou_aaa'] });
    const r = await kernel.create({ content: '<p>c</p>' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const env = JSON.parse(r.text) as { data: { permission_grant: Record<string, unknown> } };
      expect(env.data.permission_grant).toMatchObject({
        status: 'granted',
        perm: 'full_access',
        member_type: 'openid',
        user_open_id: 'ou_aaa',
      });
    }
  });

  it('授予撞 99991672 → status failed + lark_code + required_scope + console_url + hint 覆盖', async () => {
    const grantError = {
      code: 99991672,
      msg: 'forbidden',
      error: {
        permission_violations: [
          { subject: 'drive:drive' },
          { subject: 'docs:permission.member:create' },
        ],
      },
    };
    const transport = makeTransport((req) =>
      req.path === '/open-apis/docs_ai/v1/documents' ? okWith(CREATE_ENVELOPE) : okWith(grantError),
    );
    const kernel = makeKernel(transport, { grantees: ['ou_aaa'] });
    const r = await kernel.create({ content: '<p>c</p>' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const env = JSON.parse(r.text) as { data: { permission_grant: Record<string, unknown> } };
      const grant = env.data.permission_grant;
      expect(grant.status).toBe('failed');
      expect(grant.lark_code).toBe(99991672);
      expect(grant.required_scope).toBe('docs:permission.member:create');
      expect(grant.console_url).toBe(
        `https://open.feishu.cn/page/scope-apply?clientID=${APP_ID}&scopes=docs%3Apermission.member%3Acreate`,
      );
      expect(grant.hint).toBe(
        'App is missing the "docs:permission.member:create" scope; enable it in the developer console (see console_url), then retry.',
      );
    }
  });

  it('无白名单条目 → permission_grant status skipped（不触达授予端点）', async () => {
    const transport = makeTransport(okWith(CREATE_ENVELOPE));
    const kernel = makeKernel(transport, { grantees: [] });
    const r = await kernel.create({ content: '<p>c</p>' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const env = JSON.parse(r.text) as { data: { permission_grant: Record<string, unknown> } };
      expect(env.data.permission_grant.status).toBe('skipped');
    }
    expect(transport).toHaveBeenCalledOnce(); // 只有 create 那一次
  });

  it('多条目授予 → permission_grant 为数组（每条目一个结果）', async () => {
    const transport = makeTransport((req) =>
      req.path === '/open-apis/docs_ai/v1/documents' ? okWith(CREATE_ENVELOPE) : okWith({ code: 0, data: {} }),
    );
    const kernel = makeKernel(transport, { grantees: ['ou_aaa', 'ou_bbb'] });
    const r = await kernel.create({ content: '<p>c</p>' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const env = JSON.parse(r.text) as { data: { permission_grant: unknown[] } };
      expect(Array.isArray(env.data.permission_grant)).toBe(true);
      expect(env.data.permission_grant).toHaveLength(2);
    }
  });

  it('授予撞非 authorization 错误（rate_limit）→ failed 但不附加 lark_code/required_scope/console_url', async () => {
    // 对拍 annotateGrantPermissionError 只认 PermissionError 的口径
    const transport = makeTransport((req) =>
      req.path === '/open-apis/docs_ai/v1/documents' ? okWith(CREATE_ENVELOPE) : okWith({ code: 99991400, msg: 'rate limit' }),
    );
    const kernel = makeKernel(transport, { grantees: ['ou_aaa'] });
    const r = await kernel.create({ content: '<p>c</p>' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const grant = (JSON.parse(r.text) as { data: { permission_grant: Record<string, unknown> } }).data.permission_grant;
      expect(grant.status).toBe('failed');
      expect(grant).not.toHaveProperty('lark_code');
      expect(grant).not.toHaveProperty('required_scope');
      expect(grant).not.toHaveProperty('console_url');
    }
  });

  it('授予阶段抛错（loadGrantees/resolveAppId 异常）→ create 仍成功，permission_grant 降级 failed', async () => {
    // 「广播失败不翻转真实成功」同一不变量：文档已建，回执绝不能变成 create 失败
    const transport = makeTransport(okWith(CREATE_ENVELOPE));
    const kernel = makeDocsAiKernel({
      transport,
      loadGrantees: async () => {
        throw new Error('config.json 读取失败');
      },
      resolveAppId: async () => APP_ID,
    });
    const r = await kernel.create({ content: '<p>c</p>' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const env = JSON.parse(r.text) as { data: { document: unknown; permission_grant: Record<string, unknown> } };
      expect(env.data.document).toBeDefined();
      expect(env.data.permission_grant.status).toBe('failed');
      expect(String(env.data.permission_grant.message)).toContain('config.json 读取失败');
    }
  });
});

// ─────────────────────────── update body 构造与校验 ───────────────────────────

describe('update body 构造（对拍 buildUpdateBodyBase）', () => {
  const UPDATE_ENVELOPE = {
    code: 0,
    data: { document: { revision_id: 4, url: 'https://my.feishu.cn/docx/ABC' }, result: 'success', warnings: [] },
  };

  it('append → command block_insert_after + block_id "-1" + content', async () => {
    const transport = makeTransport(okWith(UPDATE_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.update({ doc: 'ABC', command: 'append', content: '<p>尾段</p>' });
    const req = transport.mock.calls[0]![0];
    expect(req.method).toBe('PUT');
    expect(req.path).toBe('/open-apis/docs_ai/v1/documents/ABC');
    expect(req.body).toEqual({
      format: 'xml',
      command: 'block_insert_after',
      block_id: '-1',
      content: '<p>尾段</p>',
    });
  });

  it('str_replace 空 content = 删除匹配：content 不发送、pattern 发送', async () => {
    const transport = makeTransport(okWith(UPDATE_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.update({ doc: 'ABC', command: 'str_replace', pattern: '旧文', content: '' });
    const body = transport.mock.calls[0]![0].body;
    expect(body).toEqual({ format: 'xml', command: 'str_replace', pattern: '旧文' });
    expect(body).not.toHaveProperty('content');
  });

  it('block_delete 带 block_id、无 content；format=markdown 透传', async () => {
    const transport = makeTransport(okWith(UPDATE_ENVELOPE));
    const kernel = makeKernel(transport);
    await kernel.update({ doc: 'ABC', command: 'block_delete', blockId: 'blk1,blk2' });
    expect(transport.mock.calls[0]![0].body).toEqual({
      format: 'xml',
      command: 'block_delete',
      block_id: 'blk1,blk2',
    });
    await kernel.update({ doc: 'ABC', command: 'overwrite', content: '# 新', format: 'markdown' });
    expect(transport.mock.calls[1]![0].body?.format).toBe('markdown');
  });

  it.each([
    [{ doc: 'ABC', command: 'append' }, '--command append requires --content', '--content'],
    [{ doc: 'ABC', command: 'str_replace', content: 'x' }, '--command str_replace requires --pattern', '--pattern'],
    [{ doc: 'ABC', command: 'block_delete' }, '--command block_delete requires --block-id', '--block-id'],
    [
      { doc: 'ABC', command: 'block_move_after', blockId: 'b1' },
      '--command block_move_after requires --src-block-ids',
      '--src-block-ids',
    ],
    [
      { doc: 'ABC', command: 'block_copy_insert_after', blockId: 'b1' },
      '--command block_copy_insert_after requires --src-block-ids',
      '--src-block-ids',
    ],
    [
      { doc: 'ABC', command: 'block_insert_after', content: '<p>x</p>' },
      '--command block_insert_after requires --block-id',
      '--block-id',
    ],
    [{ doc: 'ABC', command: 'overwrite' }, '--command overwrite requires --content', '--content'],
  ] as const)('校验 %j → %s（param=%s，不触达 transport）', async (input, message, param) => {
    const transport = makeTransport(okWith(UPDATE_ENVELOPE));
    const kernel = makeKernel(transport);
    const r = await kernel.update(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { error: Record<string, unknown> };
      expect(env.error).toMatchObject({
        type: 'validation',
        subtype: 'invalid_argument',
        message,
        param,
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('block_move_after 带 content 同样先撞 src 校验（对拍 lark-cli 校验顺序：blockID → src → content 互斥）', async () => {
    const transport = makeTransport(okWith(UPDATE_ENVELOPE));
    const kernel = makeKernel(transport);
    const r = await kernel.update({ doc: 'ABC', command: 'block_move_after', blockId: 'b1', content: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.text).toContain('block_move_after requires --src-block-ids');
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── 信封形态 ───────────────────────────

describe('信封形态（对拍 lark-cli JSON 输出）', () => {
  it('成功：{ok,identity,data} 形状 + 2 空格缩进 + 尾换行（键序非形态，只钉形状）', async () => {
    const envelope = {
      code: 0,
      data: { document: { content: '<p>a</p>', document_id: 'ABC', revision_id: 3 } },
    };
    const kernel = makeKernel(makeTransport(okWith(envelope)));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.text)).toEqual({
        ok: true,
        identity: 'bot',
        data: { document: { content: '<p>a</p>', document_id: 'ABC', revision_id: 3 } },
      });
      expect(r.text.endsWith('}\n')).toBe(true);
      expect(r.text).toContain('\n  "ok": true,\n'); // 2 空格缩进
    }
  });

  it('失败：{ok:false,identity,error} 同形态序列化', async () => {
    const kernel = makeKernel(makeTransport(okWith({ code: 1, msg: 'Internal error. Please retry.' })));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // 键序对拍 Go struct 声明序（Problem: type, subtype, code, message…），非字典序
      expect(r.text).toBe(
        '{\n' +
          '  "ok": false,\n' +
          '  "identity": "bot",\n' +
          '  "error": {\n' +
          '    "type": "api",\n' +
          '    "subtype": "unknown",\n' +
          '    "code": 1,\n' +
          '    "message": "Internal error. Please retry."\n' +
          '  }\n' +
          '}\n',
      );
    }
  });
});

// ─────────────────────────── 错误分类 ───────────────────────────

describe('错误分类（移植 errclass）', () => {
  it('99991672 → authorization/app_scope_not_applied：canonical message + console_url hint + missing_scopes', async () => {
    const envelope = {
      code: 99991672,
      msg: 'access denied',
      error: { permission_violations: [{ subject: 'docx:document:create' }, { subject: 'docx:document:create' }] },
      log_id: 'LOG1',
    };
    const kernel = makeKernel(makeTransport(okWith(envelope)));
    const r = await kernel.create({ content: '<p>c</p>' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { error: Record<string, unknown> };
      expect(env.error).toMatchObject({
        type: 'authorization',
        subtype: 'app_scope_not_applied',
        code: 99991672,
        message: `access denied: app ${APP_ID} has not applied for the required scope(s): docx:document:create`,
        missing_scopes: ['docx:document:create'],
        identity: 'bot',
        log_id: 'LOG1',
        console_url: `https://open.feishu.cn/page/scope-apply?clientID=${APP_ID}&scopes=docx%3Adocument%3Acreate`,
      });
      expect(env.error.hint).toBe(
        `the app developer must apply for the required scope(s) at the developer console: https://open.feishu.cn/page/scope-apply?clientID=${APP_ID}&scopes=docx%3Adocument%3Acreate`,
      );
      expect(r.authFailure.needsReauth).toBe(false);
    }
  });

  it('99991679 → authorization/missing_scope：无 console_url，hint 指引重新授权', async () => {
    const envelope = { code: 99991679, msg: 'unauthorized', error: { permission_violations: [{ subject: 'docx:document:readonly' }] } };
    const kernel = makeKernel(makeTransport(okWith(envelope)));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { error: Record<string, unknown> };
      expect(env.error.subtype).toBe('missing_scope');
      expect(env.error).not.toHaveProperty('console_url');
      expect(env.error.hint).toContain('re-authorize');
    }
  });

  it.each([
    [99991661, 'token_missing'],
    [99991663, 'token_invalid'],
    [99991668, 'token_invalid'],
    [99991677, 'token_expired'],
  ] as const)('authentication 码 %d → subtype %s + authFailure.needsReauth', async (code, subtype) => {
    const kernel = makeKernel(makeTransport(okWith({ code, msg: 'auth error' })));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { error: Record<string, unknown> };
      expect(env.error.type).toBe('authentication');
      expect(env.error.subtype).toBe(subtype);
      expect(r.authFailure.needsReauth).toBe(true);
    }
  });

  it('99991543 → config/invalid_client + authFailure（凭证错=重新配置）', async () => {
    const kernel = makeKernel(makeTransport(okWith({ code: 99991543, msg: 'app secret invalid' })));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { error: Record<string, unknown> };
      expect(env.error).toMatchObject({ type: 'config', subtype: 'invalid_client' });
      expect(r.authFailure.needsReauth).toBe(true);
    }
  });

  it('未知码 → api/unknown；log_id 顶层与 error 嵌套两路提升；troubleshooter 提升', async () => {
    const kernel = makeKernel(
      makeTransport(okWith({ code: 1770001, msg: 'doc not found', error: { log_id: 'NESTED', troubleshooter: 'https://open.feishu.cn/search?x' } })),
    );
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { error: Record<string, unknown> };
      expect(env.error).toMatchObject({
        type: 'api',
        subtype: 'unknown',
        code: 1770001,
        message: 'doc not found',
        log_id: 'NESTED',
        troubleshooter: 'https://open.feishu.cn/search?x',
      });
      expect(r.authFailure.needsReauth).toBe(false);
    }
  });

  it('error.details[].value → api 类 hint（服务端字段级原因）', async () => {
    const kernel = makeKernel(
      makeTransport(okWith({ code: 190014, msg: 'bad param', error: { details: [{ value: 'end_time should be later' }, { value: '' }] } })),
    );
    const r = await kernel.update({ doc: 'ABC', command: 'append', content: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { error: { hint?: string } };
      expect(env.error.hint).toBe('end_time should be later');
    }
  });

  it('msg 缺失 → 回落 "API error: [code]"（信封不留空 message）', async () => {
    const kernel = makeKernel(makeTransport(okWith({ code: 424242 })));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.text).toContain('API error: [424242]');
    }
  });

  it('HTTP 错误带信封 → 按信封码分类；5xx 无信封 → network/server_error；其余无信封 → network/transport', async () => {
    const withEnv = makeKernel(makeTransport({ kind: 'http', status: 403, envelope: { code: 99991672, msg: 'denied' } }));
    const r1 = await withEnv.fetch({ doc: 'ABC' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(JSON.parse(r1.text).error.subtype).toBe('app_scope_not_applied');

    const s500 = makeKernel(makeTransport({ kind: 'http', status: 502 }));
    const r2 = await s500.fetch({ doc: 'ABC' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      const env = JSON.parse(r2.text) as { error: Record<string, unknown> };
      expect(env.error).toMatchObject({ type: 'network', subtype: 'server_error', retryable: true });
    }

    const s404 = makeKernel(makeTransport({ kind: 'http', status: 404 }));
    const r3 = await s404.fetch({ doc: 'ABC' });
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      const env = JSON.parse(r3.text) as { error: Record<string, unknown> };
      expect(env.error.type).toBe('network');
      expect(env.error.subtype).toBe('transport');
    }
  });

  it('网络超时 → network/timeout retryable；传输失败 → network/transport', async () => {
    const timeout = makeKernel(makeTransport({ kind: 'network', subtype: 'timeout', message: 'timeout of 120000ms exceeded' }));
    const r1 = await timeout.fetch({ doc: 'ABC' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      const env = JSON.parse(r1.text) as { error: Record<string, unknown> };
      expect(env.error).toMatchObject({ type: 'network', subtype: 'timeout', retryable: true });
    }
    const down = makeKernel(makeTransport({ kind: 'network', subtype: 'transport', message: 'getaddrinfo ENOTFOUND' }));
    const r2 = await down.fetch({ doc: 'ABC' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      const env = JSON.parse(r2.text) as { error: Record<string, unknown> };
      expect(env.error).toMatchObject({ type: 'network', subtype: 'transport' });
    }
  });

  it('无凭证 → config/not_configured + authFailure + 配置指引', async () => {
    const kernel = makeKernel(makeTransport({ kind: 'not-configured' }));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const env = JSON.parse(r.text) as { error: Record<string, unknown> };
      expect(env.error).toMatchObject({ type: 'config', subtype: 'not_configured' });
      expect(r.authFailure.needsReauth).toBe(true);
      expect(r.authFailure.hint).toContain('平台连接');
    }
  });
});

// ─────────────────────────── 脱敏 ───────────────────────────

describe('输出脱敏', () => {
  it('信封里混入飞书 token 形态字符串 → 输出已脱敏', async () => {
    const envelope = {
      code: 0,
      data: { document: { content: '调试信息 t-a1b2c3d4e5f6g7h8 出现', document_id: 'ABC', revision_id: 1 } },
    };
    const kernel = makeKernel(makeTransport(okWith(envelope)));
    const r = await kernel.fetch({ doc: 'ABC' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).not.toContain('t-a1b2c3d4e5f6g7h8');
    }
  });
});

// ─────────────────────────── 授予对象筛选（生产接线） ───────────────────────────

describe('selectGrantees（生产接线的授予对象筛选）', () => {
  it('飞书条目算入；legacy 无 platform 条目按「保守留着」口径算入；他平台条目排除', () => {
    const whitelist = [
      { id: 'on_union1', platform: 'feishu', source: 'pairing', boundAt: 1, chatId: 'oc_x' },
      { id: 'ou_legacy' }, // 旧版裸字符串迁移条目（normalizeWhitelist 留空 platform）
      { id: 'ou_discord_user', platform: 'discord', source: 'pairing', boundAt: 2, chatId: 'ch1' },
    ] satisfies WhitelistEntry[];
    expect(selectGrantees(whitelist)).toEqual(['on_union1', 'ou_legacy']);
  });

  it('空白名单 → 空数组（内核据此回 skipped）', () => {
    expect(selectGrantees([])).toEqual([]);
  });
});

// ─────────────────────────── transport（SDK client 缓存与异常映射） ───────────────────────────

describe('makeSdkTransport', () => {
  const CRED = { appId: 'cli_a', appSecret: 's1' };

  function fakeClient(impl?: (req: unknown) => Promise<unknown>): SdkClient & { request: ReturnType<typeof vi.fn> } {
    return { request: vi.fn(impl ?? (async () => ({ code: 0, data: {} }))) };
  }

  it('同凭证复用 client；凭证变更重建（await 后重读凭证，不持陈旧 client）', async () => {
    let cred = { ...CRED };
    const makeClient = vi.fn(() => fakeClient());
    const transport = makeSdkTransport({ getCredential: async () => cred, makeClient });
    await transport({ method: 'POST', path: '/open-apis/x', body: {}, timeoutMs: 1000 });
    await transport({ method: 'POST', path: '/open-apis/x', body: {}, timeoutMs: 1000 });
    expect(makeClient).toHaveBeenCalledTimes(1);
    cred = { appId: 'cli_a', appSecret: 's2' };
    await transport({ method: 'POST', path: '/open-apis/x', body: {}, timeoutMs: 1000 });
    expect(makeClient).toHaveBeenCalledTimes(2);
  });

  it('无凭证 → not-configured，不构造 client', async () => {
    const makeClient = vi.fn(() => fakeClient());
    const transport = makeSdkTransport({ getCredential: async () => null, makeClient });
    const r = await transport({ method: 'POST', path: '/open-apis/x', body: {}, timeoutMs: 1000 });
    expect(r.kind).toBe('not-configured');
    expect(makeClient).not.toHaveBeenCalled();
  });

  it('请求形状透传：method/url/params/data/timeout', async () => {
    const client = fakeClient();
    const transport = makeSdkTransport({ getCredential: async () => CRED, makeClient: () => client });
    await transport({
      method: 'PUT',
      path: '/open-apis/docs_ai/v1/documents/ABC',
      body: { command: 'append' },
      params: { type: 'docx' },
      timeoutMs: 1234,
    });
    expect(client.request).toHaveBeenCalledOnce();
    const arg = client.request.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      method: 'PUT',
      data: { command: 'append' },
      params: { type: 'docx' },
      timeout: 1234,
    });
    expect(String(arg.url)).toContain('/open-apis/docs_ai/v1/documents/ABC');
  });

  it('HTTP 2xx 信封原样返回（code≠0 也走 kind ok，交内核分类）', async () => {
    const client = fakeClient(async () => ({ code: 99991672, msg: 'denied' }));
    const transport = makeSdkTransport({ getCredential: async () => CRED, makeClient: () => client });
    const r = await transport({ method: 'POST', path: '/x', body: {}, timeoutMs: 1 });
    expect(r).toEqual({ kind: 'ok', envelope: { code: 99991672, msg: 'denied' } });
  });

  it('axios 形态异常：带 response → http（信封透传）；ECONNABORTED → timeout；其余 → transport', async () => {
    const httpErr = Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      response: { status: 403, data: { code: 99991672, msg: 'denied' } },
    });
    const t1 = makeSdkTransport({ getCredential: async () => CRED, makeClient: () => fakeClient(async () => { throw httpErr; }) });
    const r1 = await t1({ method: 'POST', path: '/x', body: {}, timeoutMs: 1 });
    expect(r1).toMatchObject({ kind: 'http', status: 403, envelope: { code: 99991672 } });

    const timeoutErr = Object.assign(new Error('timeout of 120000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
    const t2 = makeSdkTransport({ getCredential: async () => CRED, makeClient: () => fakeClient(async () => { throw timeoutErr; }) });
    const r2 = await t2({ method: 'POST', path: '/x', body: {}, timeoutMs: 1 });
    expect(r2).toMatchObject({ kind: 'network', subtype: 'timeout' });

    const netErr = Object.assign(new Error('getaddrinfo ENOTFOUND'), { isAxiosError: true, code: 'ENOTFOUND' });
    const t3 = makeSdkTransport({ getCredential: async () => CRED, makeClient: () => fakeClient(async () => { throw netErr; }) });
    const r3 = await t3({ method: 'POST', path: '/x', body: {}, timeoutMs: 1 });
    expect(r3).toMatchObject({ kind: 'network', subtype: 'transport' });
  });
});
