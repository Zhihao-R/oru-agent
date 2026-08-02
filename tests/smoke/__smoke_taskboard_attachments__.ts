/**
 * 任务描述图片附件（项④）后端行为：
 *   1. saveTaskboardAttachments 落盘 → relPath=<taskId>-images/<uuid>.png、文件真在盘上
 *   2. setTaskAttachments 持久化 attachments，落盘不带 displayUrl（瞬态视图不进盘）
 *   3. hydrateTaskboardDisplayUrls 填 oru-board-img:// URL
 *   4. resolveBoardImageRequest：合法 URL 通过；attacker（越界 / 结构不符 / 非图扩展名）一律 null
 */
import './__smoke_isolate__';

import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyAttachmentDelta, createTask, getTask } from '../../electron/main/taskboard/store';
import {
  hydrateTaskboardDisplayUrls,
  saveTaskboardAttachments,
} from '../../electron/main/taskboard/attachments';
import { resolveBoardImageRequest } from '../../electron/main/taskboard/boardImageProtocol';
import { USERS_DIR } from '../../electron/main/runtime/paths';
import { getCurrentOwnerId } from '../../electron/main/identity/getCurrentOwnerId';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

// 8 字节 PNG 签名 + 填充——detectMime 只看 magic bytes，够过校验（不触发压缩）
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0),
]);

async function main() {
  const task = await createTask({ title: '插图任务' }, 'you');
  const item = {
    base64: PNG.toString('base64'),
    mediaType: 'image/png' as const,
    filename: 'a.png',
    bytes: PNG.length,
  };

  // case 1: 落盘
  const saved = await saveTaskboardAttachments(task.id, [item]);
  assert(saved.length === 1, 'saveTaskboardAttachments 返回 1 条');
  assert(
    saved[0].relPath.startsWith(`${task.id}-images/`) && saved[0].relPath.endsWith('.png'),
    'relPath = <taskId>-images/<uuid>.png',
    saved[0].relPath,
  );
  const owner = getCurrentOwnerId();
  const absFile = join(USERS_DIR, owner, 'taskboard', saved[0].relPath);
  assert(existsSync(absFile), '图片文件真落在盘上', absFile);

  // case 2: 持久化 + 落盘不带 displayUrl
  await applyAttachmentDelta(
    task.id,
    saved.map((a) => ({ ...a, displayUrl: 'oru-board-img://should-be-stripped' })),
    [],
  );
  const fresh = await getTask(task.id);
  assert(fresh?.attachments?.length === 1, 'attachments 持久化到 task');
  assert(fresh?.attachments?.[0].displayUrl === undefined, '落盘剥掉 displayUrl');

  // case 3: hydrate URL
  const hy = hydrateTaskboardDisplayUrls(fresh!);
  const url = hy.attachments?.[0].displayUrl ?? '';
  assert(url.startsWith('oru-board-img://local'), 'hydrate 出 oru-board-img:// URL', url);

  // case 4a: 合法 URL 解析通过
  const ok = resolveBoardImageRequest(url);
  assert(ok !== null && ok.contentType === 'image/png', '合法 URL → 通过、mime=image/png');
  assert(ok?.path === absFile, '解析出的路径 = 落盘绝对路径');

  // case 4b: attacker —— 越界（USERS_DIR 之外）
  assert(
    resolveBoardImageRequest('oru-board-img://local/etc/passwd.png') === null,
    'attacker：USERS_DIR 之外 → null',
  );
  // case 4c: attacker —— 结构不符（conversations 而非 taskboard）
  const wrongDir = `oru-board-img://local${encodeURI(join(USERS_DIR, owner, 'conversations', 'x-images', 'a.png'))}`;
  assert(resolveBoardImageRequest(wrongDir) === null, 'attacker：非 taskboard 段 → null');
  // case 4d: attacker —— taskboard 下但非 <id>-images（如 tasks/）
  const wrongSub = `oru-board-img://local${encodeURI(join(USERS_DIR, owner, 'taskboard', 'tasks', 'a.png'))}`;
  assert(resolveBoardImageRequest(wrongSub) === null, 'attacker：taskboard/tasks 非 -images → null');
  // case 4e: attacker —— 非图扩展名
  const badExt = `oru-board-img://local${encodeURI(join(USERS_DIR, owner, 'taskboard', `${task.id}-images`, 'evil.txt'))}`;
  assert(resolveBoardImageRequest(badExt) === null, 'attacker：非图扩展名 → null');

  // case 5: 回归（reviewer 命中的 lost-update）——并发两次增量 add 各读最新盘、都要保留，不互相覆盖。
  // 起点：task 现有 1 张（case 2 落的）。并发再各加一张 → 期望共 3 张。
  const task2 = await createTask({ title: '并发加图' }, 'you');
  const s1 = await saveTaskboardAttachments(task2.id, [{ ...item, filename: 'x.png' }]);
  const s2 = await saveTaskboardAttachments(task2.id, [{ ...item, filename: 'y.png' }]);
  await Promise.all([
    applyAttachmentDelta(task2.id, s1, []),
    applyAttachmentDelta(task2.id, s2, []),
  ]);
  const both = await getTask(task2.id);
  assert(both?.attachments?.length === 2, '并发两次 add 都保留（不 lost-update）', `实际 ${both?.attachments?.length}`);
  // 再并发「加一张 + 删一张」——删的走 removeRelPaths，锁内基于最新盘合成
  const s3 = await saveTaskboardAttachments(task2.id, [{ ...item, filename: 'z.png' }]);
  await Promise.all([
    applyAttachmentDelta(task2.id, s3, []),
    applyAttachmentDelta(task2.id, [], [both!.attachments![0].relPath]),
  ]);
  const after = await getTask(task2.id);
  assert(after?.attachments?.length === 2, '并发「加+删」组合正确（2-1+1=2）', `实际 ${after?.attachments?.length}`);
  assert(
    !after?.attachments?.some((a) => a.relPath === both!.attachments![0].relPath),
    '被删的那张确实没了',
  );

  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
