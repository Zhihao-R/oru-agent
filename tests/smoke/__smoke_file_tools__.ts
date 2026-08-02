/**
 * 文件工具 smoke —— list_dir / write_file / edit_file / manage_files + 执行器闭环。
 *
 * 覆盖：list_dir、写操作 symlink 防越界、write_file/edit_file/manage_files 的 emit 构造、
 * 信任模式内联执行、executeFileWriteProposal 执行器、独立执行器安全网（file.write 不走那条路径）。
 *
 * 审批模式（requireApproval=true）用 mock onProposal 捕获 proposal（不落盘、不经独立执行器）。
 * 同步审批语义下工具 emit 后会挂起等用户决定（见 emitProposal.ts）——smoke 没有用户，
 * 捕获到卡片后以 rejected settle 释放工具（不执行、不落盘，恰好保持"只 emit"的断言意图）。
 * 信任模式（requireApproval=false）写类工具直接落盘、不 emit、把真实结果（diff/输出）作为工具结果返回。
 */
import './__smoke_isolate__';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionProposal, ApprovalMode } from '@shared/types';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';
import { makeListDirTool } from '../../electron/main/agent/agentTools/listDir';
import { conversationToolCacheDir } from '../../electron/main/runtime/paths';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { settleProposalDecision } from '../../electron/main/proposals/pendingDecision';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== file tools smoke ===');

const agent = await ensureDefaultAgent();
const OWNER = 'local-user';
const CONV = 'file-tools-conv';

// 捕获 emit 的 proposal
let captured: ActionProposal | null = null;
function makeCtx(approvalMode: ApprovalMode = 'work'): ToolContext {
  return makeToolContext({
    conversationId: CONV,
    agentId: agent.id,
    ownerId: OWNER,
    approvalMode,
    onProposal: async (p) => {
      captured = p;
      // 同步审批语义下 emit 会挂起等用户决定（见 emitProposal.ts）——smoke 无用户，捕获到卡片后
      // 以 rejected settle 释放工具（不执行、不落盘，保持"只 emit"的断言意图，见文件头注）。
      settleProposalDecision(p.id, 'rejected');
    },
  });
}
// 只读重构后：写类工具在 work 挡内联执行落盘（不再"strict 强制 emit"——纯写不是危险动作，
// PRD 决策六默认 work），在 readonly 挡硬拒不落盘。挡位实时读 getAgent，故经 setAgentMode 设真实挡位。
const { updateAgent } = await import('../../electron/main/agent/store/agents');
async function setAgentMode(mode: 'readonly' | 'work' | 'danger'): Promise<void> {
  await updateAgent(agent.id, { approvalMode: mode });
}
await setAgentMode('work');
const ctx = makeCtx('work');
const trustCtx = makeCtx('work');

const root = conversationToolCacheDir(OWNER, agent.id, CONV);
await fs.mkdir(root, { recursive: true });

// ════════════════ Task 3.2: list_dir ════════════════
const listDir = makeListDirTool();
{
  const d = join(root, 'listme');
  await fs.rm(d, { recursive: true, force: true });
  await fs.mkdir(join(d, 'sub'), { recursive: true });
  await fs.writeFile(join(d, 'b.txt'), 'bbb', 'utf-8');
  await fs.writeFile(join(d, 'a.txt'), 'a', 'utf-8');
  await fs.symlink('/etc/hosts', join(d, 'link-to-hosts'));

  const r = await listDir.execute({ path: d }, ctx);
  assert(r.isError !== true, 'list_dir 成功', r.text);
  // 稳定序：目录在前，再按名称 → sub/ 在 a.txt 前
  assert(r.text.indexOf('sub/') < r.text.indexOf('a.txt'), 'list_dir 目录在前+稳定序');
  assert(r.text.indexOf('a.txt') < r.text.indexOf('b.txt'), 'list_dir 文件按名称序');
  assert(/\[link\] link-to-hosts -> \/etc\/hosts/.test(r.text), 'list_dir symlink 标 [link] 带 target', r.text);

  // 超上限截断
  const big = join(root, 'bigdir');
  await fs.rm(big, { recursive: true, force: true });
  await fs.mkdir(big, { recursive: true });
  await Promise.all(
    Array.from({ length: 210 }, (_, i) => fs.writeFile(join(big, `f${String(i).padStart(3, '0')}.txt`), 'x', 'utf-8')),
  );
  const rb = await listDir.execute({ path: big }, ctx);
  assert(rb.text.includes('已截断') && (rb.structured as { truncated?: boolean })?.truncated === true, 'list_dir 超上限截断标注');

  // 白名单外
  const rOut = await listDir.execute({ path: '/etc' }, ctx);
  assert(rOut.isError === true && rOut.text.includes('允许的'), 'list_dir 白名单外 isError 含可写位置', rOut.text);
}

// ════════════════ Task 3.3: 写操作 symlink 防越界 ════════════════
{
  const { assertWritableSandbox, SandboxError } = await import(
    '../../electron/main/agent/agentTools/pathSandbox'
  );

  // 正常嵌套新建（父目录不存在）→ 放行（不抛）
  let nestedOk = false;
  try {
    await assertWritableSandbox(join(root, 'new', 'deep', 'file.txt'), ctx);
    nestedOk = true;
  } catch {
    nestedOk = false;
  }
  assert(nestedOk, '3.3 正常嵌套新建（父目录不存在）→ 放行');

  // 白名单内经 symlink 目录指向外部 → 拒绝
  const evil = join(root, 'symlink-to-etc');
  await fs.rm(evil, { force: true });
  await fs.symlink('/etc', evil); // root 内的 symlink 指向 /etc（沙箱外）
  let blocked = false;
  let msg = '';
  try {
    await assertWritableSandbox(join(evil, 'passwd'), ctx);
  } catch (e) {
    blocked = e instanceof SandboxError;
    msg = (e as Error).message;
  }
  assert(blocked, '3.3 经 symlink 父目录穿越到沙箱外 → 拒绝', msg);
  assert(msg.includes('可写位置') || msg.includes('越界'), '3.3 越界文案含可写位置提示', msg);

  // 白名单外普通路径 → 拒绝
  let outBlocked = false;
  let outMsg = '';
  try {
    await assertWritableSandbox('/etc/evil.txt', ctx);
  } catch (e) {
    outBlocked = e instanceof SandboxError;
    outMsg = (e as Error).message;
  }
  assert(outBlocked && outMsg.includes('可写'), '3.3 白名单外路径 → 拒绝含可写位置', outMsg);
}

// ════════════════ Task 3.4: write_file emit ════════════════
{
  const { makeWriteFileTool } = await import('../../electron/main/agent/agentTools/writeFile');
  const { recordRead } = await import('../../electron/main/agent/conversationFileState');
  const { floorMtime } = await import('../../electron/main/fs/safeWrite');
  const writeFile = makeWriteFileTool();

  // 新路径 → work 挡内联落盘（create：写入确认、无 diff）
  const newPath = join(root, 'created.md');
  await fs.rm(newPath, { force: true });
  const rc = await writeFile.execute({ path: newPath, content: '# 新建\n内容' }, ctx);
  assert(rc.isError !== true && rc.text.includes('已写入新文件'), '3.4 新路径 → create 落盘+写入确认', rc.text);
  assert(existsSync(newPath) && (await fs.readFile(newPath, 'utf-8')) === '# 新建\n内容', '3.4 create 内容正确');

  // 已存在但没整读过 → never-read
  const existing = join(root, 'existing.md');
  await fs.writeFile(existing, 'old content', 'utf-8');
  captured = null;
  const rn = await writeFile.execute({ path: existing, content: 'new' }, ctx);
  assert(rn.isError === true && rn.text.includes('read_file'), '3.4 未读覆盖 → never-read 指引', rn.text);

  // 只部分读过 → partial-only
  recordRead(CONV, existing, { mtime: floorMtime(existing), content: 'old', offset: 1, limit: 1, isPartialView: true });
  const rp = await writeFile.execute({ path: existing, content: 'new' }, ctx);
  assert(rp.isError === true && rp.text.includes('整读'), '3.4 部分读覆盖 → partial-only 指引', rp.text);

  // 整读过 → 守卫放行，但 work 挡覆盖强制审批（PT-004「只在删除/覆盖时问」）：emit forceApproval
  // 提案、不自动落盘。提案带 unified diff（卡片据此渲染）。本 smoke 的 onProposal 捕获后 reject，故不执行。
  recordRead(CONV, existing, { mtime: floorMtime(existing), content: 'old content', isPartialView: false });
  captured = null;
  const ro = await writeFile.execute({ path: existing, content: 'brand new content' }, ctx);
  assert(
    captured !== null &&
      (captured as ActionProposal).kind === 'file.write' &&
      (captured as { forceApproval?: boolean }).forceApproval === true,
    '3.4 整读后覆盖 → emit forceApproval 提案（PT-004）',
    ro.text,
  );
  assert((captured as { diff?: string } | null)?.diff?.includes('@@') === true, '3.4 覆盖提案带 unified diff');
  assert((await fs.readFile(existing, 'utf-8')) === 'old content', '3.4 覆盖未批准 → 不落盘（仍旧内容）');

  // 越界 → isError 含可写位置
  const rOut = await writeFile.execute({ path: '/etc/x.txt', content: 'x' }, ctx);
  assert(rOut.isError === true && rOut.text.includes('可写'), '3.4 越界 write → isError 含可写位置', rOut.text);

  // 大 HTML 覆盖：整读过 → 守卫放行 + emit 审批提案，但 diff 省略（不为预览整读多 MB 旧文件、不算大 diff）
  const bigHtml = join(root, 'big.html');
  const bigContent = '<div>' + 'x'.repeat(600 * 1024) + '</div>';
  await fs.writeFile(bigHtml, bigContent, 'utf-8');
  recordRead(CONV, bigHtml, { mtime: floorMtime(bigHtml), content: bigContent, isPartialView: false });
  captured = null;
  const rbig = await writeFile.execute({ path: bigHtml, content: bigContent + '<!--edit-->' }, ctx);
  assert(
    captured !== null && (captured as { diff?: string }).diff?.includes('省略 diff 预览') === true,
    '3.4 大文件覆盖 → emit 提案且 diff 省略预览',
    rbig.text.slice(0, 60),
  );
  assert((await fs.readFile(bigHtml, 'utf-8')) === bigContent, '3.4 大文件覆盖未批准 → 不落盘');
}

// ════════════════ Task 3.5: edit_file emit ════════════════
{
  const { makeEditFileTool } = await import('../../electron/main/agent/agentTools/editFile');
  const { recordRead } = await import('../../electron/main/agent/conversationFileState');
  const { floorMtime } = await import('../../electron/main/fs/safeWrite');
  const edit = makeEditFileTool();

  // 精确命中 → emit mode='edit'
  const ef = join(root, 'edit-target.md');
  await fs.writeFile(ef, '第一段 30% 增长\n第二段 不变', 'utf-8');
  recordRead(CONV, ef, { mtime: floorMtime(ef), content: '第一段 30% 增长\n第二段 不变', isPartialView: false });
  const re = await edit.execute({ path: ef, old_string: '30%', new_string: '45%' }, ctx);
  assert(re.isError !== true && re.text.includes('@@'), '3.5 精确命中 → 落盘+返回 diff', re.text.slice(0, 80));
  assert((await fs.readFile(ef, 'utf-8')) === '第一段 45% 增长\n第二段 不变', '3.5 edit 落盘内容正确');

  // 弯引号文件 + 直引号 search → 命中
  const cf = join(root, 'curly.md');
  await fs.writeFile(cf, '他说“你好”收尾', 'utf-8');
  recordRead(CONV, cf, { mtime: floorMtime(cf), content: '他说“你好”收尾', isPartialView: false });
  const rc = await edit.execute({ path: cf, old_string: '说"你好"收', new_string: '说"再见"收' }, ctx);
  assert(rc.isError !== true, '3.5 弯引号文件+直引号 search 命中', rc.text);
  // actualOld 保留弯引号、newString 回写保弯引号风格 → 落盘内容为弯引号
  assert((await fs.readFile(cf, 'utf-8')) === '他说“再见”收尾', '3.5 弯引号风格保留落盘', await fs.readFile(cf, 'utf-8'));

  // 没命中（目标段在磁盘定位不到）→ 守卫 target-moved → 指引重读重试（放宽后，§6）
  const rnf = await edit.execute({ path: ef, old_string: '不存在的片段', new_string: 'x' }, ctx);
  assert(rnf.isError === true && rnf.text.includes('read_file'), '3.5 没命中 → 指引重读重试', rnf.text);

  // 多处未 replace_all → 拒绝
  const mf = join(root, 'multi.md');
  await fs.writeFile(mf, 'foo bar foo baz foo', 'utf-8');
  recordRead(CONV, mf, { mtime: floorMtime(mf), content: 'foo bar foo baz foo', isPartialView: false });
  const rm = await edit.execute({ path: mf, old_string: 'foo', new_string: 'X' }, ctx);
  assert(rm.isError === true && rm.text.includes('3 处'), '3.5 多处未 replace_all → 拒绝', rm.text);
  // replace_all=true → 全替换落盘
  const rma = await edit.execute({ path: mf, old_string: 'foo', new_string: 'X', replace_all: true }, ctx);
  assert(rma.isError !== true && (await fs.readFile(mf, 'utf-8')) === 'X bar X baz X', '3.5 replace_all=true 全替换落盘', rma.text.slice(0, 60));

  // 部分读后 edit：目标在范围内 → 放行；范围外 → out-of-view
  const pf = join(root, 'partial-edit.md');
  await fs.writeFile(pf, 'A1\nA2\nTARGET\nA4\nA5', 'utf-8');
  recordRead(CONV, pf, { mtime: floorMtime(pf), content: 'TARGET\nA4', offset: 3, limit: 2, isPartialView: true });
  const rin = await edit.execute({ path: pf, old_string: 'TARGET', new_string: 'DONE' }, ctx);
  assert(rin.isError !== true && (await fs.readFile(pf, 'utf-8')).includes('DONE'), '3.5 部分读 edit 目标在范围内 → 落盘', rin.text);
  // out-of-view 用独立文件：上一条 in-range edit 已 work 挡执行 + afterWrite 标整读，会解除 partial 限制
  const pf2 = join(root, 'partial-edit-2.md');
  await fs.writeFile(pf2, 'A1\nA2\nTARGET\nA4\nA5', 'utf-8');
  recordRead(CONV, pf2, { mtime: floorMtime(pf2), content: 'TARGET\nA4', offset: 3, limit: 2, isPartialView: true });
  const rout = await edit.execute({ path: pf2, old_string: 'A1', new_string: 'Z1' }, ctx);
  assert(rout.isError === true && rout.text.includes('已读过的范围'), '3.5 部分读 edit 目标在范围外 → out-of-view', rout.text);

  // ── §6/§11.9 recovery 上限端到端（含 M-5 回归：超上限后不得 reset 让活锁复活）──
  const rf = join(root, 'recovery.md');
  await fs.writeFile(rf, '开头 TARGET 结尾', 'utf-8');
  recordRead(CONV, rf, { mtime: floorMtime(rf), content: '开头 TARGET 结尾', isPartialView: false });
  await fs.writeFile(rf, '开头 用户改没了 结尾', 'utf-8'); // 用户把目标段改没
  for (let i = 1; i <= 3; i++) {
    const r = await edit.execute({ path: rf, old_string: 'TARGET', new_string: 'X' }, ctx);
    assert(r.isError === true && r.text.includes(`${i}/3`), `3.5 recovery 第 ${i} 次 → 指引重试`, r.text);
  }
  const r4 = await edit.execute({ path: rf, old_string: 'TARGET', new_string: 'X' }, ctx);
  assert(r4.isError === true && r4.text.includes('暂停'), '3.5 recovery 超上限 → 暂停', r4.text);
  const r5 = await edit.execute({ path: rf, old_string: 'TARGET', new_string: 'X' }, ctx);
  // M-5：超上限后**仍是暂停**，不能 reset 成「1/3」让 AI 又能连试 3 次（活锁）
  assert(r5.isError === true && r5.text.includes('暂停') && !r5.text.includes('1/3'), '3.5 M-5：超上限后保持暂停、不复位活锁', r5.text);
  // 用户停手（目标段又能定位）→ 编辑成功落盘 → 计数 reset
  await fs.writeFile(rf, '开头 TARGET 结尾', 'utf-8');
  recordRead(CONV, rf, { mtime: floorMtime(rf), content: '开头 TARGET 结尾', isPartialView: false });
  const rok = await edit.execute({ path: rf, old_string: 'TARGET', new_string: 'DONE' }, ctx);
  assert(rok.isError !== true && (await fs.readFile(rf, 'utf-8')).includes('DONE'), '3.5 用户停手后编辑成功落盘（计数随成功 reset）', rok.text);
}

// ════════════════ Task 3.6: manage_files (delete) emit ════════════════
{
  const { makeManageFilesTool } = await import('../../electron/main/agent/agentTools/manageFiles');
  const { setTrashItemImplForTest } = await import('../../electron/main/proposals/executeFileWriteProposal');
  const manage = makeManageFilesTool();
  // delete 走强制审批（PT-004），本 smoke onProposal 捕获后 reject → 不执行；mock 回收站仅作执行路径兜底
  setTrashItemImplForTest(async (path) => { await fs.rm(path, { force: true }); });

  const delTarget = join(root, 'to-delete.txt');
  await fs.writeFile(delTarget, 'bye', 'utf-8');
  captured = null;
  const rd = await manage.execute({ action: 'delete', path: delTarget }, ctx);
  assert(
    captured !== null && (captured as { forceApproval?: boolean }).forceApproval === true,
    '3.6 work 挡删除 → emit forceApproval 提案（PT-004）',
    rd.text,
  );
  assert(existsSync(delTarget), '3.6 删除未批准 → 文件仍在（不删）');

  // 不存在 → isError
  const rne = await manage.execute({ action: 'delete', path: join(root, 'ghost.txt') }, ctx);
  assert(rne.isError === true && rne.text.includes('不存在'), '3.6 删不存在 → isError');

  // 越界 → isError
  const rout = await manage.execute({ action: 'delete', path: '/etc/hosts' }, ctx);
  assert(rout.isError === true && rout.text.includes('可写'), '3.6 越界 delete → isError 含可写位置', rout.text);

  // 非 delete action → isError
  const rbad = await manage.execute({ action: 'move', path: delTarget }, ctx);
  assert(rbad.isError === true, "3.6 action!='delete' → isError（move 交给 bash）");

  // 还原真实回收站实现，避免影响后续 section（同进程内）
  setTrashItemImplForTest(async (path) => {
    const { shell } = await import('electron');
    await shell.trashItem(path);
  });
}

// ════════════════ Task 3.7: 信任模式内联执行（不 emit、直接落盘、返回真实结果） ════════════════
{
  const { makeWriteFileTool } = await import('../../electron/main/agent/agentTools/writeFile');
  const { makeEditFileTool } = await import('../../electron/main/agent/agentTools/editFile');
  const { makeManageFilesTool } = await import('../../electron/main/agent/agentTools/manageFiles');
  const { setTrashItemImplForTest } = await import('../../electron/main/proposals/executeFileWriteProposal');
  const { recordRead } = await import('../../electron/main/agent/conversationFileState');
  const { floorMtime } = await import('../../electron/main/fs/safeWrite');
  const writeFile = makeWriteFileTool();
  const edit = makeEditFileTool();
  const manage = makeManageFilesTool();

  // create：直接落盘 + 不 emit + 返回写入确认
  captured = null;
  const cpath = join(root, 'trust-create.md');
  await fs.rm(cpath, { force: true });
  const rc = await writeFile.execute({ path: cpath, content: 'hi\nthere' }, trustCtx);
  assert(rc.isError !== true && captured === null, '3.7 信任 create 不 emit proposal', rc.text);
  assert(existsSync(cpath) && (await fs.readFile(cpath, 'utf-8')) === 'hi\nthere', '3.7 信任 create 直接落盘');
  assert(rc.text.includes('已写入新文件'), '3.7 信任 create 返回写入确认', rc.text);

  // edit：直接落盘 + 返回 unified diff（chip 据此渲染彩色 diff）
  const epath = join(root, 'trust-edit.md');
  await fs.writeFile(epath, '增长 30%\n保留', 'utf-8');
  recordRead(CONV, epath, { mtime: floorMtime(epath), content: '增长 30%\n保留', isPartialView: false });
  captured = null;
  const re = await edit.execute({ path: epath, old_string: '30%', new_string: '45%' }, trustCtx);
  assert(re.isError !== true && captured === null, '3.7 信任 edit 不 emit', re.text);
  assert((await fs.readFile(epath, 'utf-8')) === '增长 45%\n保留', '3.7 信任 edit 直接落盘');
  assert(re.text.trimStart().startsWith('Index: ') && re.text.includes('@@'), '3.7 信任 edit 返回 unified diff', re.text.slice(0, 80));

  // delete：work 挡删除强制审批（PT-004「只在删除/覆盖时问」）→ emit 提案、不内联执行（onProposal reject）
  setTrashItemImplForTest(async (path) => {
    await fs.rm(path, { force: true });
  });
  const dpath = join(root, 'trust-delete.txt');
  await fs.writeFile(dpath, 'bye', 'utf-8');
  captured = null;
  const rd = await manage.execute({ action: 'delete', path: dpath }, trustCtx);
  assert(captured !== null, '3.7 work 挡删除 → emit 提案（不内联，PT-004）', rd.text);
  assert(existsSync(dpath), '3.7 删除未批准 → 文件仍在');
  // 恢复真实 trash 实现，避免影响后续 section（同进程内）
  setTrashItemImplForTest(async (path) => {
    const { shell } = await import('electron');
    await shell.trashItem(path);
  });

  // CSV 定型（工具层第一步，先于算 diff）：模型爱给长文本裹引号，那会让表不合「仅必要引号」的
  // 规范格式、用户随后保存时被问一句他无从判断的话。定型在工具层做，才能让回执字节数 / 审批卡
  // diff / 落盘内容是同一份（在执行器里做则「批的是 A、落的是 B」）。
  const csvPath = join(root, 'trust-table.csv');
  await fs.rm(csvPath, { force: true });
  const quoted = '公司,岗位要求\n阿里,"1-2年搜索经验；精通SQL，能搭建指标体系"\n';
  const canonical = '公司,岗位要求\n阿里,1-2年搜索经验；精通SQL，能搭建指标体系\n';
  const rcsv = await writeFile.execute({ path: csvPath, content: quoted }, trustCtx);
  assert((await fs.readFile(csvPath, 'utf-8')) === canonical, '3.7 CSV create 落盘已定型（摘掉不必要的引号）');
  assert(
    rcsv.text.includes(String(Buffer.byteLength(canonical, 'utf-8'))),
    '3.7 CSV 回执字节数 = 落盘字节数（所见即所批）',
    rcsv.text,
  );

  // 安全阀：分号分隔（德/法语区 Excel 默认导出）按逗号模型重排会把整行裹成一个字段 —— 必须原样落盘
  const semiPath = join(root, 'trust-semicolon.csv');
  await fs.rm(semiPath, { force: true });
  const semi = 'Name;Betrag;Notiz\nMüller;1.234,56;"Zahlung; Rest offen"\n';
  await writeFile.execute({ path: semiPath, content: semi }, trustCtx);
  assert((await fs.readFile(semiPath, 'utf-8')) === semi, '3.7 分号表原样落盘（安全阀不按逗号拆坏）');

  // 非 .csv 不受定型影响
  const mdQuotePath = join(root, 'trust-quotes.md');
  await fs.rm(mdQuotePath, { force: true });
  await writeFile.execute({ path: mdQuotePath, content: quoted }, trustCtx);
  assert((await fs.readFile(mdQuotePath, 'utf-8')) === quoted, '3.7 非 .csv 内容原样落盘');

  // 只读挡对照：同一 create 在 readonly 下直接拒、不落盘、不弹卡（只读硬约束，PRD 决策二）。
  // 挡位实时读 getAgent，故经 setAgentMode 设真实挡位。
  await setAgentMode('readonly');
  captured = null;
  const apath = join(root, 'readonly-create.md');
  await fs.rm(apath, { force: true });
  const ra = await writeFile.execute({ path: apath, content: 'x' }, ctx);
  assert(ra.isError !== true && ra.text.includes('只读') && captured === null, '3.7 只读挡：写文件直接拒、不弹卡', ra.text);
  assert(!existsSync(apath), '3.7 只读挡：不落盘');
  await setAgentMode('work');
}

// ════════════════ Task 4.1: executeFileWriteProposal 执行器 ════════════════
{
  const { executeFileWriteProposal, setTrashItemImplForTest } = await import(
    '../../electron/main/proposals/executeFileWriteProposal'
  );
  const { buildFileWriteProposal } = await import('../../electron/main/proposals/makeFileWriteProposal');
  const { recordRead, checkGuard, peekFileState } = await import(
    '../../electron/main/agent/conversationFileState'
  );
  const { floorMtime } = await import('../../electron/main/fs/safeWrite');

  // ① create 落盘 + 落盘后 checkGuard 转 ok（afterWrite 标整读）
  const cpath = join(root, 'exec-create.md');
  await fs.rm(cpath, { force: true });
  await executeFileWriteProposal(
    buildFileWriteProposal({ conversationId: CONV, path: cpath, mode: 'create', content: 'hello\nworld' }),
  );
  assert((await fs.readFile(cpath, 'utf-8')) === 'hello\nworld', '4.1 ① create 落盘内容正确');
  assert(checkGuard(CONV, cpath, 'overwrite') === 'ok', '4.1 ① 落盘后 checkGuard(overwrite)=ok');

  // ② read→write→write 第二次不自卡（afterWrite 后 overwrite 仍 ok）
  await executeFileWriteProposal(
    buildFileWriteProposal({ conversationId: CONV, path: cpath, mode: 'overwrite', content: 'v2' }),
  );
  assert((await fs.readFile(cpath, 'utf-8')) === 'v2', '4.1 ② 第二次 overwrite 落盘');
  assert(checkGuard(CONV, cpath, 'overwrite') === 'ok', '4.1 ② 连续写不自卡');

  // ③ 基线校验（S02 · G88）：emit 时 ok，落盘前文件被外部改 → 执行器拒（baseline-moved 退回重读），
  //    外部版一字不动；重读拿到新基线后再覆盖 → 成功，被覆盖的外部版由 overwrite-guard 兜进历史（不丢）。
  const fileHistory = await import('../../electron/main/fs/fileHistory');
  const gpath = join(root, 'exec-guard.md');
  await fs.writeFile(gpath, 'orig', 'utf-8');
  recordRead(CONV, gpath, { mtime: floorMtime(gpath), content: 'orig', isPartialView: false });
  await fs.writeFile(gpath, 'EXTERNAL EDIT', 'utf-8'); // 审批窗口期外部改动
  let baselineRejected = false;
  try {
    await executeFileWriteProposal(
      buildFileWriteProposal({ conversationId: CONV, path: gpath, mode: 'overwrite', content: 'Oru wrote' }),
    );
  } catch {
    baselineRejected = true;
  }
  assert(baselineRejected, '4.1 ③ 外部改动后 overwrite 被执行器拒（G88 基线校验）');
  assert((await fs.readFile(gpath, 'utf-8')) === 'EXTERNAL EDIT', '4.1 ③ 拒写后外部版一字不动');
  // 重读（拿到新基线）→ 覆盖成功
  recordRead(CONV, gpath, { mtime: floorMtime(gpath), content: 'EXTERNAL EDIT', isPartialView: false });
  await executeFileWriteProposal(
    buildFileWriteProposal({ conversationId: CONV, path: gpath, mode: 'overwrite', content: 'Oru wrote' }),
  );
  assert((await fs.readFile(gpath, 'utf-8')) === 'Oru wrote', '4.1 ③ 重读后 overwrite 成功');
  const gsnaps = await fileHistory.list(gpath);
  const gcontents = await Promise.all(gsnaps.map((s) => fileHistory.restore(gpath, s.id)));
  assert(gcontents.includes('EXTERNAL EDIT'), '4.1 ③ 被覆盖的外部版由 overwrite-guard 兜进历史（不丢）');

  // ④ edit 落盘正确
  const epath = join(root, 'exec-edit.md');
  await fs.writeFile(epath, '价格 30 元\n其它', 'utf-8');
  recordRead(CONV, epath, { mtime: floorMtime(epath), content: '价格 30 元\n其它', isPartialView: false });
  await executeFileWriteProposal(
    buildFileWriteProposal({ conversationId: CONV, path: epath, mode: 'edit', oldString: '30', newString: '45', replaceAll: false }),
  );
  assert((await fs.readFile(epath, 'utf-8')) === '价格 45 元\n其它', '4.1 ④ edit 落盘正确');

  // ⑤ delete：mock trashItem 被调 + onDelete 清条目；reject → 抛错文件还在
  const dpath = join(root, 'exec-delete.txt');
  await fs.writeFile(dpath, 'bye', 'utf-8');
  recordRead(CONV, dpath, { mtime: floorMtime(dpath), content: 'bye', isPartialView: false });
  let trashed = '';
  setTrashItemImplForTest(async (path) => {
    trashed = path;
    await fs.rm(path, { force: true }); // 模拟进回收站
  });
  await executeFileWriteProposal(buildFileWriteProposal({ conversationId: CONV, path: dpath, mode: 'delete' }));
  assert(trashed === dpath, '4.1 ⑤ delete 调 trashItem');
  assert(peekFileState(CONV, dpath) === undefined, '4.1 ⑤ delete 后 onDelete 清条目');

  // trashItem reject → 抛错且文件还在（不降级）
  const dpath2 = join(root, 'exec-delete2.txt');
  await fs.writeFile(dpath2, 'stay', 'utf-8');
  setTrashItemImplForTest(async () => {
    throw new Error('回收站不可用（外接盘）');
  });
  let delThrew = false;
  try {
    await executeFileWriteProposal(buildFileWriteProposal({ conversationId: CONV, path: dpath2, mode: 'delete' }));
  } catch {
    delThrew = true;
  }
  assert(delThrew, '4.1 ⑤ 回收站不可用 → 抛错（不降级永久删）');
  assert(existsSync(dpath2), '4.1 ⑤ 抛错后文件还在');

  // 恢复真实 trash 实现，避免影响其它 smoke（同进程内）
  setTrashItemImplForTest(async (path) => {
    const { shell } = await import('electron');
    await shell.trashItem(path);
  });
}

// ═════════════ Task 4.2: 独立执行器安全网（file.write 不再走那条路径） ═════════════
// 审批 file.write 走同步直唤醒（pendingDecision，端到端见 tests/ws/proposalExecuteRoute.test.ts）、
// 信任模式工具层内联执行——落到独立执行器即 regression，链尾 else 硬失败而非静默 executed。
{
  const { runProposalStandalone } = await import('../../electron/main/proposals/standaloneExec');
  const { buildFileWriteProposal } = await import('../../electron/main/proposals/makeFileWriteProposal');
  type StatusEv = { type: string; proposalId: string; status?: string; failureMessage?: string };
  const events: StatusEv[] = [];
  const broadcast = (ev: unknown) => events.push(ev as StatusEv);

  const e2ePath = join(root, 'e2e-create.md');
  await fs.rm(e2ePath, { force: true });
  const prop = buildFileWriteProposal({ conversationId: CONV, path: e2ePath, mode: 'create', content: 'e2e' });
  await runProposalStandalone(prop, broadcast);
  assert(prop.status === 'failed', '4.2 file.write 落到独立执行器 → 硬失败（防静默 executed）');
  assert(!existsSync(e2ePath), '4.2 安全网拦截后未落盘');
  assert(events.some((e) => e.status === 'failed'), '4.2 广播 failed 状态');

  // 未知 kind 同走链尾 else → failed
  const unknown = { ...prop, kind: 'totally.unknown', id: 'unk-1', status: 'pending' as const };
  events.length = 0;
  await runProposalStandalone(unknown as unknown as Parameters<typeof runProposalStandalone>[0], broadcast);
  assert((unknown as { status: string }).status === 'failed', '4.2 未知 kind → 链尾 else throw → failed（非静默 executed）');
}

const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== file tools smoke: ${RESULTS.length - failed.length}/${RESULTS.length} PASS ===`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL: ${r.name} — ${r.detail ?? ''}`);
  process.exit(1);
}

// 让后续 section 能复用（避免 TS unused 警告）
void (captured as ActionProposal | null);
void makeCtx;
void (null as FileWriteProposal | null);
