/**
 * feishuDocsAi 真机对拍（S4 DoD）——同一输入，SDK 内核 vs lark-cli 输出形态一致。
 *
 * 默认跳过（需真凭证 + 真网络）：ORU_FEISHU_E2E=1 npx vitest run tests/platform/feishuDocsAi.e2e.test.ts
 *
 * 凭证 / 白名单直接读本机 ~/.oru/users/local-user/ 两份文件（不经 store——vitest 的 ORU_DIR
 * 是隔离临时目录）；lark-cli 走 ORU_LARK_CLI_BIN 或 npx（同 runLarkCli 既有规则）。
 *
 * 对拍口径：
 *  - fetch：同一文档先后跑 CLI 与内核，JSON 解析后深比（同输入同输出，含 revision）；
 *  - update：内核 append 写标记、CLI fetch 验证、内核 str_replace 空 content 删标记收尾；
 *  - create：内核建文档，信封形状（document 键集 + permission_grant 标注键集）与 CLI 基线一致。
 * 会在 bot 云空间留一个「S4 SDK 对拍（可删）」文档（bot 所建仅 bot 可见，与 CLI 基线文档同类）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { makeDocsAiKernel, makeSdkTransport, type FeishuDocKernel } from '../../electron/main/platform/feishuDocsAi';
import { runLarkCli } from '../../electron/main/platform/feishuCli';

const RUN = process.env.ORU_FEISHU_E2E === '1';
const USER_DIR = join(homedir(), '.oru', 'users', 'local-user');
const TEST_DOC = 'BxkqdhJU4on4ZQx58dFckeKynye'; // 08-01 验收的 bot 测试文档

interface Cred {
  appId: string;
  appSecret: string;
}

async function makeRealKernel(): Promise<{ kernel: FeishuDocKernel; cred: Cred; grantees: string[] }> {
  const cred = JSON.parse(await readFile(join(USER_DIR, 'platform-credentials.json'), 'utf-8')) as { feishu: Cred };
  const cfg = JSON.parse(await readFile(join(USER_DIR, 'config.json'), 'utf-8')) as {
    settings: { platforms: { whitelist: Array<{ id: string; platform: string }> } };
  };
  const grantees = cfg.settings.platforms.whitelist.filter((w) => w.platform === 'feishu').map((w) => w.id);
  const kernel = makeDocsAiKernel({
    transport: makeSdkTransport({
      getCredential: async () => cred.feishu,
      makeClient: (c) =>
        new Lark.Client({ appId: c.appId, appSecret: c.appSecret, domain: Lark.Domain.Feishu, loggerLevel: Lark.LoggerLevel.warn }),
    }),
    loadGrantees: async () => grantees,
    resolveAppId: async () => cred.feishu.appId,
  });
  return { kernel, cred: cred.feishu, grantees };
}

/** lark-cli bot 路径（S2 行为基准）。 */
async function cliFetch(doc: string): Promise<unknown> {
  const res = await runLarkCli(['docs', '+fetch', '--doc', doc, '--as', 'bot'], { timeoutMs: 120_000 });
  expect(res.authFailure.needsReauth).toBe(false);
  expect(res.exitCode).toBe(0);
  return JSON.parse(res.stdout);
}

describe.skipIf(!RUN || !existsSync(join(USER_DIR, 'platform-credentials.json')))('真机对拍（bot 内核 vs lark-cli）', () => {
  it('fetch：同一文档 CLI 与内核输出深比一致', async () => {
    const { kernel } = await makeRealKernel();
    const cliOut = (await cliFetch(TEST_DOC)) as Record<string, unknown>;
    const r = await kernel.fetch({ doc: TEST_DOC });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(r.text)).toEqual(cliOut);
  }, 60_000);

  it('update：append 写标记 → CLI 读到 → str_replace 空 content 删除 → CLI 确认干净', async () => {
    const { kernel } = await makeRealKernel();
    const marker = `S4-SDK-parity-${Date.now()}`;

    const appended = await kernel.update({ doc: TEST_DOC, command: 'append', content: `<p>${marker}</p>` });
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      const env = JSON.parse(appended.text) as { data: { result: string; document: { url: string; revision_id: number } } };
      expect(env.data.result).toBe('success');
      expect(env.data.document.url).toContain('/docx/');
    }

    const afterAppend = (await cliFetch(TEST_DOC)) as { data: { document: { content: string } } };
    expect(afterAppend.data.document.content).toContain(marker);

    // str_replace 空 content = 删除匹配（S2 语义，内核 content 不发送）
    const removed = await kernel.update({ doc: TEST_DOC, command: 'str_replace', pattern: marker, content: '' });
    expect(removed.ok).toBe(true);

    const afterRemove = (await cliFetch(TEST_DOC)) as { data: { document: { content: string } } };
    expect(afterRemove.data.document.content).not.toContain(marker);
  }, 90_000);

  it('create：信封形状与 CLI 基线一致（document 键集 + permission_grant 标注）', async () => {
    const { kernel, grantees } = await makeRealKernel();
    const r = await kernel.create({ title: 'S4 SDK 对拍（可删）', content: '<p>S4 内核对拍文档</p>' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const env = JSON.parse(r.text) as {
      ok: boolean;
      identity: string;
      data: { document: Record<string, unknown>; permission_grant: Record<string, unknown> };
    };
    expect(env.ok).toBe(true);
    expect(env.identity).toBe('bot');
    expect(Object.keys(env.data.document).sort()).toEqual(['document_id', 'revision_id', 'url']);
    expect(String(env.data.document.url)).toContain('/docx/');
    // 授权授予：单条目 → 与 lark-cli 同形态对象；缺 scope 时带 failed 标注键集
    const grant = env.data.permission_grant;
    expect(grant).toBeDefined();
    expect(['granted', 'failed']).toContain(grant.status);
    expect(grant.member_type).toBe(grantees[0]?.startsWith('on_') ? 'unionid' : 'openid');
    if (grant.status === 'failed') {
      for (const key of ['lark_code', 'required_scope', 'console_url', 'hint']) expect(grant, key).toHaveProperty(key);
    }
  }, 60_000);

  it('错误对拍：不存在文档的 fetch，内核与 CLI 同为结构化失败（非 authFailure）', async () => {
    const { kernel } = await makeRealKernel();
    const r = await kernel.fetch({ doc: 'ZzzZZZzzZZZzzZZZzzZZZzzZZZ' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.authFailure.needsReauth).toBe(false);
    const env = JSON.parse(r.text) as { ok: boolean; identity: string; error: { type: string; message: string } };
    expect(env.ok).toBe(false);
    expect(env.identity).toBe('bot');
    expect(env.error.type).toBeTruthy();
    expect(env.error.message).toBeTruthy();

    const cli = await runLarkCli(['docs', '+fetch', '--doc', 'ZzzZZZzzZZZzzZZZzzZZZzzZZZ', '--as', 'bot'], { timeoutMs: 120_000 });
    expect(cli.exitCode).not.toBe(0);
    const cliEnv = JSON.parse(cli.stderr) as { error: { type: string } };
    expect(cliEnv.error.type).toBe(env.error.type); // 同输入同错误类目
  }, 60_000);
});
