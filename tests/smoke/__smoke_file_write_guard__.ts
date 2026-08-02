/**
 * 文件防盲覆盖守卫 smoke（核心）—— electron/main/agent/conversationFileState.ts
 *
 * 实时落盘后守卫放宽（技术设计 §6）：
 *   - overwrite：必须读过（never-read / partial-only）；**不再因外部改动拦截**——磁盘随时是用户最新版，
 *     不丢由 §2.5 overwrite-guard 兜底（去掉 'changed' 真阳性风暴）。
 *   - edit：读过即可、目标片段在已读范围内；目标段在当前磁盘定位不到 → 'target-moved'（走 recovery，上限 3 次）。
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  recordRead,
  checkGuard,
  afterWrite,
  onDelete,
  clearConvFileState,
  recordTargetMoved,
  resetTargetMoved,
  MAX_TARGET_MOVED_RETRIES,
} from '../../electron/main/agent/conversationFileState';
import { floorMtime } from '../../electron/main/fs/safeWrite';
import { settleProposalDecision } from '../../electron/main/proposals/pendingDecision';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== file write guard (store) smoke ===');

const CONV = 'guard-conv';
const root = join(tmpdir(), `guard-smoke-${Date.now()}`);
await fs.mkdir(root, { recursive: true });

// 目标不存在 → ok（新建放行）
const ghost = join(root, 'nope.md');
assert(checkGuard(CONV, ghost, 'overwrite') === 'ok', '目标不存在 → ok（新建）');

// ① 未 recordRead → never-read
const f1 = join(root, 'a.md');
await fs.writeFile(f1, 'hello world\nsecond line', 'utf-8');
assert(checkGuard(CONV, f1, 'overwrite') === 'never-read', '① 未读 → never-read');

// ② 整读后 overwrite → ok
recordRead(CONV, f1, { mtime: floorMtime(f1), content: 'hello world\nsecond line', isPartialView: false });
assert(checkGuard(CONV, f1, 'overwrite') === 'ok', '② 整读后 overwrite → ok');

// ③ 只部分读后 overwrite → partial-only
const f2 = join(root, 'big.md');
await fs.writeFile(f2, 'L1\nL2\nL3\nL4\nL5', 'utf-8');
recordRead(CONV, f2, { mtime: floorMtime(f2), content: 'L3\nL4', offset: 3, limit: 2, isPartialView: true });
assert(checkGuard(CONV, f2, 'overwrite') === 'partial-only', '③ 部分读后 overwrite → partial-only');

// ④ 基线判定（S02 · G88，理想页 G3）：读过后被外部改动 → baseline-moved 退回重读——
// 「不丢」由 overwrite-guard 兜底、「不错」靠基线（撤销协同编辑落地前的放宽决策）
const f3 = join(root, 'c.md');
await fs.writeFile(f3, 'orig', 'utf-8');
recordRead(CONV, f3, { mtime: floorMtime(f3), content: 'orig', isPartialView: false });
await fs.writeFile(f3, 'externally changed', 'utf-8');
assert(
  checkGuard(CONV, f3, 'overwrite') === 'baseline-moved',
  '④ 外部改内容后 overwrite → baseline-moved 退回重读（G88 基线判定）',
);

// ⑤ 部分读后 edit：目标在 st.content 内 → ok；不在 → out-of-view
assert(checkGuard(CONV, f2, 'edit', 'L4') === 'ok', '⑤ 部分读 edit 目标在范围内 → ok');
assert(checkGuard(CONV, f2, 'edit', 'L1') === 'out-of-view', '⑤ 部分读 edit 目标在范围外 → out-of-view');
// 整读则全文都算已读
assert(checkGuard(CONV, f1, 'edit', 'second line') === 'ok', '⑤ 整读 edit 任意片段 → ok');

// ⑥ edit 守卫放宽 + target-moved（§6）：用户改无关段放行；恰改目标段 → target-moved
const f5 = join(root, 'e.md');
await fs.writeFile(f5, '第一段：目标内容\n第二段：无关内容', 'utf-8');
recordRead(CONV, f5, { mtime: floorMtime(f5), content: '第一段：目标内容\n第二段：无关内容', isPartialView: false });
await fs.writeFile(f5, '第一段：目标内容\n第二段：用户改了这里', 'utf-8'); // 用户改无关段
assert(checkGuard(CONV, f5, 'edit', '目标内容') === 'ok', '⑥ 用户改无关段、目标仍在 → 放行');
await fs.writeFile(f5, '第一段：目标已被用户改掉\n第二段：用户改了这里', 'utf-8'); // 用户改目标段
assert(checkGuard(CONV, f5, 'edit', '目标内容') === 'target-moved', '⑥ 用户恰改目标段、定位不到 → target-moved');

// ⑦ recovery 上限（§11.9）：连续 target-moved 计数，超 MAX 让 caller 放弃；reset 后重新计数
resetTargetMoved(CONV, f5);
let lastCount = 0;
for (let i = 0; i < MAX_TARGET_MOVED_RETRIES; i++) lastCount = recordTargetMoved(CONV, f5);
assert(lastCount === MAX_TARGET_MOVED_RETRIES, `⑦ 连续重试计数到上限 ${MAX_TARGET_MOVED_RETRIES}`);
assert(recordTargetMoved(CONV, f5) === MAX_TARGET_MOVED_RETRIES + 1, '⑦ 超上限：caller 据此暂停并提示用户');
resetTargetMoved(CONV, f5);
assert(recordTargetMoved(CONV, f5) === 1, '⑦ reset 后重新从 1 计数（编辑成功落盘会 reset）');

// afterWrite：落盘后标整读，后续 overwrite 直接 ok
afterWrite(CONV, f1, { mtime: floorMtime(f1), content: 'hello world\nsecond line', isPartialView: false });
assert(checkGuard(CONV, f1, 'overwrite') === 'ok', 'afterWrite 后 overwrite → ok');

// onDelete：清条目后回到 never-read
onDelete(CONV, f1);
assert(checkGuard(CONV, f1, 'overwrite') === 'never-read', 'onDelete 后 → never-read');

// clearConvFileState：清整桶
clearConvFileState(CONV);
assert(checkGuard(CONV, f3, 'overwrite') === 'never-read', 'clearConvFileState 后 → never-read');

// ════════════════ Task 4.3: 无审批模式守卫回归（防"审批关=守卫关"）════════════════
// 通过真实 write_file 工具 + requireApproval=false 验证守卫独立于审批：
// 没整读就覆盖 → 仍被 never-read/partial-only 拦在执行之前，文件不变；
// 整读后 → 直接内联落盘（信任模式不 emit proposal，emitted 作为 tripwire 必须保持 false）。
{
  const { makeWriteFileTool } = await import('../../electron/main/agent/agentTools/writeFile');
  const { conversationToolCacheDir } = await import('../../electron/main/runtime/paths');
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  const { recordRead, peekFileState } = await import('../../electron/main/agent/conversationFileState');
  const { floorMtime } = await import('../../electron/main/fs/safeWrite');

  const agent = await ensureDefaultAgent();
  const OWNER = 'local-user';
  const NCONV = 'noapproval-conv';
  const sandbox = conversationToolCacheDir(OWNER, agent.id, NCONV);
  await fs.mkdir(sandbox, { recursive: true });

  let emitted = false;
  // work 挡 ctx：create/edit 内联执行不 emit；覆盖/删除强制审批会 emit（PT-004）。emitted 作 tripwire
  // 区分"守卫拦在 emit 之前"与"放行后 emit 审批"。emit 时同步 reject settle 释放工具（不执行、不落盘）。
  const noApprovalCtx = {
    conversationId: NCONV,
    agentId: agent.id,
    ownerId: OWNER,
    usage: 'twinMain' as const,
    approvalMode: 'work',
    abortSignal: new AbortController().signal,
    onProposal: async (p: { id: string }) => {
      emitted = true;
      settleProposalDecision(p.id, 'rejected');
    },
  };

  const writeFile = makeWriteFileTool();

  // 没读过就覆盖 → never-read，emit 不发生，文件不变
  const f = join(sandbox, 'noapproval.md');
  await fs.writeFile(f, '原始内容', 'utf-8');
  emitted = false;
  const r = await writeFile.execute({ path: f, content: '想盖掉' }, noApprovalCtx);
  assert(r.isError === true && r.text.includes('read_file'), '4.3 无审批+没读 → never-read 拦截', r.text);
  assert(emitted === false, '4.3 守卫拦在 emit 之前（onProposal 未触发）');
  assert((await fs.readFile(f, 'utf-8')) === '原始内容', '4.3 无审批下文件未被盖');

  // 只部分读 → partial-only，仍拦
  recordRead(NCONV, f, { mtime: floorMtime(f), content: '原始', offset: 1, limit: 1, isPartialView: true });
  emitted = false;
  const r2 = await writeFile.execute({ path: f, content: '还想盖' }, noApprovalCtx);
  assert(r2.isError === true && r2.text.includes('整读'), '4.3 无审批+部分读 → partial-only 拦截');
  assert((await fs.readFile(f, 'utf-8')) === '原始内容', '4.3 partial-only 下文件仍未变');

  // 整读后 → 守卫放行，但 work 挡覆盖强制审批（PT-004）→ emit 审批提案，不内联落盘（本 smoke reject）
  recordRead(NCONV, f, { mtime: floorMtime(f), content: '原始内容', isPartialView: false });
  emitted = false;
  const r3 = await writeFile.execute({ path: f, content: '正当覆盖' }, noApprovalCtx);
  assert(emitted === true, '4.3 整读后覆盖 → 守卫放行后 emit 审批提案（PT-004）', r3.text);
  assert((await fs.readFile(f, 'utf-8')) === '原始内容', '4.3 覆盖未批准 → 文件仍是原始内容');
  void peekFileState;
}

await fs.rm(root, { recursive: true, force: true });

const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== file write guard (store) smoke: ${RESULTS.length - failed.length}/${RESULTS.length} PASS ===`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL: ${r.name} — ${r.detail ?? ''}`);
  process.exit(1);
}
