/**
 * S5 user 身份真机验收——进程内 UAT 内核建/读/改飞书文档（lark-cli 零参与）。
 *
 * 默认跳过（需真凭证 + 已完成 device flow 授权 + 真网络）：
 *   ORU_FEISHU_E2E=1 [ORU_FEISHU_UAT_FILE=<token 文件路径>] npx vitest run tests/platform/feishuUserAuth.e2e.test.ts
 *
 * token / 凭证直接读文件（不经 store——vitest 的 ORU_DIR 是隔离临时目录）：
 *  - 凭证：~/.oru/users/local-user/platform-credentials.json（同 S4 e2e）
 *  - user token：ORU_FEISHU_UAT_FILE 指定（真机验收指向 playtest 沙箱的
 *    feishu-user-token.json；默认 ~/.oru/users/local-user/feishu-user-token.json）。
 *
 * 验收口径（S5 DoD「真机走一遍授权 → user 身份建文档成功」）：
 *  - create：user 内核建文档——信封 {ok, identity:"user", data.document{document_id,url}}，
 *    无 permission_grant（user 所建归本人，不授权授予——与 bot 的刻意差异）；
 *  - fetch：读回刚建的文档，正文一致；
 *  - update：append 写标记 → str_replace 空 content 删标记收尾。
 * 会在授权用户的云空间留一个「S5 UAT 验收（可删）」文档（归本人所有，与 CLI user 路径所建同类）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeDocsAiKernel, type FeishuDocKernel } from '../../electron/main/platform/feishuDocsAi';
import { makeUatDocsAiTransport, type UatDeps } from '../../electron/main/platform/feishuUat';
import type { StoredUserToken } from '../../electron/main/platform/feishuUserToken';

const RUN = process.env.ORU_FEISHU_E2E === '1';
const USER_DIR = join(homedir(), '.oru', 'users', 'local-user');
const UAT_FILE = process.env.ORU_FEISHU_UAT_FILE ?? join(USER_DIR, 'feishu-user-token.json');

interface Cred {
  appId: string;
  appSecret: string;
}

async function makeRealUserKernel(): Promise<FeishuDocKernel> {
  const { feishu: cred } = JSON.parse(await readFile(join(USER_DIR, 'platform-credentials.json'), 'utf-8')) as {
    feishu: Cred;
  };
  // 内存态 token：从文件读初值，刷新轮换写回文件（与生产同一套 UatDeps 语义，只是 store 换成这份文件）
  const uatDeps: UatDeps = {
    getCredential: async () => cred,
    getToken: async (appId) => {
      const t = JSON.parse(await readFile(UAT_FILE, 'utf-8')) as StoredUserToken;
      return t.appId === appId ? t : null;
    },
    setToken: async (t) => {
      const { writeFile, chmod } = await import('node:fs/promises');
      await writeFile(UAT_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
      await chmod(UAT_FILE, 0o600);
    },
    clearToken: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(UAT_FILE, { force: true });
    },
  };
  return makeDocsAiKernel({
    transport: makeUatDocsAiTransport({
      getCredential: uatDeps.getCredential,
      getValidToken: async () => {
        const { getValidUserAccessToken } = await import('../../electron/main/platform/feishuUat');
        return getValidUserAccessToken(uatDeps);
      },
      forceRefresh: async () => {
        const { forceRefreshUserToken } = await import('../../electron/main/platform/feishuUat');
        return forceRefreshUserToken(uatDeps);
      },
    }),
    loadGrantees: async () => [],
    resolveAppId: async () => cred.appId,
    identity: 'user',
  });
}

describe.skipIf(!RUN || !existsSync(UAT_FILE))('S5 真机：user 身份（UAT 内核）', () => {
  it('create → fetch → update 全链路（user 身份、零 lark-cli）', async () => {
    const kernel = await makeRealUserKernel();
    const marker = `S5-UAT-${Date.now()}`;

    // create：信封 identity=user、无 permission_grant、url 在
    const created = await kernel.create({ title: 'S5 UAT 验收（可删）', content: `<p>验收标记 ${marker}</p>` });
    expect(created.ok, created.text).toBe(true);
    const createdEnv = JSON.parse(created.text) as {
      ok: true;
      identity: string;
      data: { document: { document_id: string; url?: string }; permission_grant?: unknown };
    };
    expect(createdEnv.identity).toBe('user');
    expect(createdEnv.data.permission_grant).toBeUndefined();
    const docId = createdEnv.data.document.document_id;
    expect(docId).toBeTruthy();
    expect(createdEnv.data.document.url).toContain(docId);

    // fetch：读回正文含标记
    const fetched = await kernel.fetch({ doc: docId });
    expect(fetched.ok, fetched.text).toBe(true);
    expect(fetched.text).toContain(marker);

    // update：append 写标记 → str_replace 空 content 删标记
    const appended = await kernel.update({ doc: docId, command: 'append', content: '<p>APPEND-MARK</p>' });
    expect(appended.ok, appended.text).toBe(true);
    const cleaned = await kernel.update({ doc: docId, command: 'str_replace', pattern: 'APPEND-MARK', content: '' });
    expect(cleaned.ok, cleaned.text).toBe(true);

    console.log(`[e2e] user 身份建文档成功：${createdEnv.data.document.url ?? docId}`);
  }, 180_000);
});
