/**
 * UserProfile store smoke：
 *  1. 首次 getProfile 触发 bootstrap 写盘
 *  2. updateProfile name 持久化
 *  3. 校验：name 空 / 21 字 / 全空格 都抛 PROFILE_INVALID
 *  4. updateProfile avatarPath 也持久化（null 和具体路径）
 *  5. 重置 cache 后 load 再读，跟之前一致（持久化生效）
 *
 * 不用 __smoke_isolate__（它会拉 agentTools → search → turndown，跟 profile 无关）。
 * 直接设 ORU_DIR 到 tmp。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.ORU_DIR) {
  process.env.ORU_DIR = join(
    tmpdir(),
    `oru-smoke-profile-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
  );
  console.log(`[smoke] ORU_DIR=${process.env.ORU_DIR}`);
}

import { LOCAL_USER_ID } from '../../electron/main/identity/getCurrentOwnerId';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function expectThrow(
  f: () => Promise<unknown>,
  name: string,
  expectedCode = 'PROFILE_INVALID',
): Promise<void> {
  try {
    await f();
    assert(false, name, `expected throw ${expectedCode} but resolved`);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    assert(
      err?.code === expectedCode,
      name,
      `actual code: ${err?.code}, message: ${err?.message}`,
    );
  }
}

async function main() {
  const { getProfile, updateProfile, ensureProfileExists, __resetProfileCache } =
    await import('../../electron/main/identity/profile');

  const ownerId = LOCAL_USER_ID;

  // ─── case 1: bootstrap ───
  await ensureProfileExists(ownerId);
  const p1 = await getProfile(ownerId);
  assert(p1.ownerId === ownerId, 'bootstrap.ownerId 正确');
  assert(p1.name.length >= 1 && p1.name.length <= 20, 'bootstrap.name 长度合法', p1.name);
  assert(p1.avatarPath === null, 'bootstrap.avatarPath 为 null');

  // ─── case 2: update name 持久化 ───
  const p2 = await updateProfile(ownerId, { name: '阮志豪' });
  assert(p2.name === '阮志豪', 'update name 生效', p2.name);

  __resetProfileCache();
  const p2reload = await getProfile(ownerId);
  assert(p2reload.name === '阮志豪', '从盘上 reload 仍是 阮志豪', p2reload.name);

  // ─── case 3: 名字校验 ───
  await expectThrow(() => updateProfile(ownerId, { name: '' }), 'update name 空 → PROFILE_INVALID');
  await expectThrow(
    () => updateProfile(ownerId, { name: '   ' }),
    'update name 全空格 → PROFILE_INVALID',
  );
  await expectThrow(
    () => updateProfile(ownerId, { name: 'a'.repeat(21) }),
    'update name 21 字 → PROFILE_INVALID',
  );
  // trim 后正好 20 字应通过
  const p3 = await updateProfile(ownerId, { name: '  ' + 'b'.repeat(20) + '  ' });
  assert(p3.name === 'b'.repeat(20), 'update name trim 后 20 字通过 + trim 已生效');

  // ─── case 4: avatarPath（必须落在 <userData>/avatars/ 下；外部路径被拒）───
  const { avatarsDir } = await import('../../electron/main/runtime/paths');
  const validPath = `${avatarsDir(ownerId)}/user-1.png`;
  const p4 = await updateProfile(ownerId, { avatarPath: validPath });
  assert(p4.avatarPath === validPath, 'update avatarPath 设为合法路径');

  await expectThrow(
    () => updateProfile(ownerId, { avatarPath: '/tmp/outside.png' }),
    'update avatarPath 外部路径 → PROFILE_INVALID',
  );
  await expectThrow(
    () => updateProfile(ownerId, { avatarPath: '/etc/passwd' }),
    'update avatarPath /etc/passwd → PROFILE_INVALID',
  );

  const p4reset = await updateProfile(ownerId, { avatarPath: null });
  assert(p4reset.avatarPath === null, 'update avatarPath 设为 null（移除）');

  // ─── case 5: 名字保留，仅改 avatarPath ───
  const p5 = await updateProfile(ownerId, {
    avatarPath: `${avatarsDir(ownerId)}/user-2.png`,
  });
  assert(
    p5.name === 'b'.repeat(20),
    '只改 avatarPath 时 name 保留',
    `name=${p5.name}`,
  );

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
