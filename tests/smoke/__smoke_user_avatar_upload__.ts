/**
 * User 头像上传 smoke：
 *  1. saveUserAvatar 写到 avatars/ 目录里 user-<ts>.png
 *  2. 第二次 saveUserAvatar：新文件名带新 ts，旧文件留作孤儿（与 agent 一致；
 *     未来 GC sweep 统一清扫）
 *  3. saveAgentAvatar 也走同一目录、同种命名
 *  4. base64 校验：空 / 非 PNG / 超长 都抛 AvatarUploadError
 *
 * 不用 __smoke_isolate__（它会拉 agentTools → search → turndown，跟 avatar 无关）。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.ORU_DIR) {
  process.env.ORU_DIR = join(
    tmpdir(),
    `oru-smoke-avatar-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
  );
  console.log(`[smoke] ORU_DIR=${process.env.ORU_DIR}`);
}

import { promises as fs } from 'node:fs';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

// 一个最小合法的 1x1 透明 PNG（base64）
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function main() {
  const { saveUserAvatar, saveAgentAvatar, AvatarUploadError } =
    await import('../../electron/main/agent/store/avatar');
  const { LOCAL_USER_ID } = await import('../../electron/main/identity/getCurrentOwnerId');
  const { avatarsDir } = await import('../../electron/main/runtime/paths');

  const ownerId = LOCAL_USER_ID;

  // ─── case 1: 落盘到 user-<ts>.png ───
  const path1 = await saveUserAvatar(ownerId, TINY_PNG_BASE64);
  assert(/user-\d+\.png$/.test(path1), 'saveUserAvatar 文件名匹配 user-<ts>.png', path1);
  const stat1 = await fs.stat(path1);
  assert(stat1.size > 0, '文件实际写入磁盘', `size=${stat1.size}`);

  // ─── case 2: 第二次上传，新文件名带新 ts，旧的留作孤儿 ───
  await new Promise((r) => setTimeout(r, 5));
  const path2 = await saveUserAvatar(ownerId, TINY_PNG_BASE64);
  assert(path1 !== path2, '第二次 saveUserAvatar 文件名不同（timestamp 变了）');
  const dir = avatarsDir(ownerId);
  const entries = await fs.readdir(dir);
  const userFiles = entries.filter((n) => /^user-\d+\.png$/.test(n));
  assert(userFiles.length === 2, '两次 user 上传后两个文件都在（旧的等 GC）', `userFiles=${userFiles.join(',')}`);

  // ─── case 3: agent 头像同目录、同种命名规则 ───
  const agentPath = await saveAgentAvatar(ownerId, 'twin', TINY_PNG_BASE64);
  assert(/twin-twin-\d+\.png$/.test(agentPath), 'saveAgentAvatar 文件名匹配');
  const entries2 = await fs.readdir(dir);
  const agentFiles = entries2.filter((n) => /^twin-/.test(n));
  assert(agentFiles.length >= 1, 'agent 文件正确落盘');

  // ─── case 4: 校验 ───
  let threw = false;
  try {
    await saveUserAvatar(ownerId, '');
  } catch (e) {
    threw = e instanceof AvatarUploadError && (e as { code: string }).code === 'AVATAR_EMPTY';
  }
  assert(threw, '空 base64 → AVATAR_EMPTY');

  threw = false;
  try {
    // 非 PNG 字节（GIF magic）
    await saveUserAvatar(ownerId, Buffer.from('GIF89a').toString('base64'));
  } catch (e) {
    threw = e instanceof AvatarUploadError && (e as { code: string }).code === 'AVATAR_NOT_PNG';
  }
  assert(threw, '非 PNG 字节 → AVATAR_NOT_PNG');

  threw = false;
  try {
    await saveUserAvatar(ownerId, 'A'.repeat(8 * 1024 * 1024 + 1));
  } catch (e) {
    threw = e instanceof AvatarUploadError && (e as { code: string }).code === 'AVATAR_TOO_LARGE';
  }
  assert(threw, '超长 base64 → AVATAR_TOO_LARGE');

  const failed = RESULTS.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[smoke] ${failed.length}/${RESULTS.length} FAIL`);
    process.exit(1);
  }
  console.log(`\n[smoke] ALL PASS (${RESULTS.length}/${RESULTS.length})`);
}

main().catch((e) => {
  console.error('[smoke] crashed:', e);
  process.exit(1);
});
