/**
 * file.write 执行器 —— create / overwrite / edit / delete 的真正落盘。
 *
 * 由 asyncExec 在 proposal 落定（审批通过 或 无审批信任模式）后调用。
 * 落盘前再复检一次防盲覆盖守卫（审批窗口可能分钟级，emit 时的判断会过期）；
 * 落盘后回写 fileState（afterWrite/onDelete）。抛错由 asyncExec 转 failed 广播。
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { FileWriteProposal } from '@shared/types';
import { floorMtime, readWithMeta } from '../fs/safeWrite';
import { applyEdit, countMatches, findActualString } from '../fs/editMatch';
import { commitWorkfileWrite, commitWorkfileEdit } from '../fs/workfileWrite';
import { joinAppend } from '../fs/appendText';
import {
  afterWrite,
  checkGuard,
  forgetAfterBlindWrite,
  grantOwnership,
  onDelete,
  peekFileState,
  recordTargetMoved,
  renewOwnershipAfterEdit,
  resetTargetMoved,
} from '../agent/conversationFileState';
import { assertTableGate } from './tableGate';
import { isConflictOpen, recordDeferredWrite } from '../fs/conflictRegistry';
import { trashPath } from '../fs/trash';
import { moveEntry, renameEntry } from '../fs/mutate';
import { toPosix } from '../fs/tree';
import { findProjectByPath } from '../projects/store';
import { broadcastFileChanged } from '../fs/fsChanged';
import { getSettings } from '../projects/store';
import { resolveEffectiveLang } from '../i18n/effectiveLang';
import { t } from '../i18n/t';

// 删到回收站的内核已抽到 fs/trash（用户文件 fs.trash 与本执行器共用一处）。
// setTrashItemImplForTest 从 trash re-export——smoke 仍从本模块 import，路径不变。
export { setTrashItemImplForTest } from '../fs/trash';

export async function executeFileWriteProposal(p: FileWriteProposal): Promise<void> {
  // AI 出口闸门（覆盖"AI 用文件工具代改某个格子"）：目标有未保存草稿 → 先保存；
  // 目标是已存在的非 UTF-8 CSV → 先走转换提案。delete / move / rename 既不消费也不产出内容，
  // 写不出混合编码文件、不可逆性为零 → 跳过编码检查（判据见 tableGate 文件头）。
  const noContentOp = p.mode === 'delete' || p.mode === 'move' || p.mode === 'rename';
  // 闸门查询超时依赖 DEFAULT_TIMEOUT_MS=2000 默认；渲染端 dirtyFiles 的应答 cap=1200 严格小于它
  // （2026-08-02 闸门修复）。不要给这里传更小的 timeoutMs，除非同步收紧渲染端 cap。
  await assertTableGate([p.path], { cwd: dirname(p.path), skipEncodingCheck: noContentOp });
  // 守卫复检失败的 throw → asyncExec 转 proposal.failureMessage → 提案卡原样显示，属用户文案；
  // 按 owner 语言取词（一次解析、line~60 的 apply 闭包也捕获本 lang）。
  const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);

  // S29·G90③ 冲突卡未决期间 AI 对同一文件的**内容后续写入**：不进锁队列等（会与用户拍板后的落盘互等成死锁），
  // 并行 defer——记一笔挂起来自本对话，抛「已挂起」交回 AI，用户拍板后 conflictCard.resolved 起新轮把裁决交回。
  // 只拦内容写（create/overwrite/edit）：冲突卡是内容段层面的，move/rename/delete 动的是整个文件、不涉冲突段，
  // defer 它们会把「内容裁决」交回一个想移动/删除文件的 AI，语义错位——放行。
  const isContentWrite =
    p.mode === 'create' || p.mode === 'overwrite' || p.mode === 'edit' || p.mode === 'append';
  if (isContentWrite && isConflictOpen(p.path)) {
    recordDeferredWrite(p.path, p.conversationId);
    throw new Error(t('main:fileWrite.conflictDeferred', lang, { path: p.path }));
  }

  if (p.mode === 'create' || p.mode === 'overwrite') {
    const exists = existsSync(p.path);
    // overwrite 必复检；create 若目标在审批窗口期被外部创建，也按 overwrite 复检防盖未知内容。
    // 此复检在锁外、只为早失败（含 baseline-moved）；锁内的 baseline/expectAbsent 才作数（G88）。
    if (p.mode === 'overwrite' || (p.mode === 'create' && exists)) {
      const g = checkGuard(p.conversationId, p.path, 'overwrite');
      if (g !== 'ok') {
        throw new Error(t('main:fileWrite.overwriteGuardUnread', lang, { guard: g, path: p.path }));
      }
    }
    const content = p.content ?? '';
    const lineEnding = exists ? readWithMeta(p.path).lineEnding : 'LF';
    // 走统一临界区：锁内基线校验（G88——覆盖要求磁盘仍是 AI 读到的那版、新建要求路径仍空着），
    // 通过后覆盖前把磁盘当前版兜进 FileHistory（不丢），并给我的版本打 'ai' 留底。
    // baseline/expectAbsent/mark 都绑定 p.mode 而非此刻 existsSync（review M2）：overwrite 提案
    // 在审批窗口期目标被删时，绑 existsSync 会落成「静默复活 + 不打 ai 标」——绑 mode 则
    // baseline 仍在、锁内按「文件已消失 = 认知过期」拒写退回，与理想页 G3 口径接上。
    // baseline 取守卫记录的整读内容：checkGuard 已保证 st 存在且整读（never-read/partial-only 先拦）。
    const st = peekFileState(p.conversationId, p.path);
    const result = await commitWorkfileWrite({
      absPath: p.path,
      content,
      lineEnding,
      by: 'ai', // AI 落盘（G91）——覆盖用户版则被覆盖版打可见 handoff 标
      mark: p.mode === 'overwrite' ? 'ai' : undefined,
      baseline: p.mode === 'overwrite' && st ? { content: st.content } : undefined,
      expectAbsent: p.mode === 'create',
    });
    if (result.status === 'rejected') {
      // 锁内拒绝同样计入 recovery（review M1）：「emit 预检 → 进锁」窗口被反复命中时，
      // 活锁防线不能只靠 emit 层——工具下次预检会按累计次数触发暂停
      recordTargetMoved(p.conversationId, p.path);
      throw new Error(
        result.reason === 'path-occupied'
          ? t('main:fileWrite.createPathOccupied', lang, { path: p.path })
          : t('main:fileWrite.overwriteBaselineMoved', lang, { path: p.path }),
      );
    }
    resetTargetMoved(p.conversationId, p.path); // 覆盖成功落盘 → 清 recovery 计数
    grantOwnership(p.conversationId, p.path, content); // D3：整篇产出建立免审凭据
    afterWrite(p.conversationId, p.path, { mtime: floorMtime(p.path), content, isPartialView: false });
    await broadcastFileChanged(p.path, 'ai'); // AI 落盘后广播：协同接收方「看见」（块①）+ 作者标（S27）
    return;
  }

  if (p.mode === 'append') {
    if (!existsSync(p.path)) throw new Error(t('main:fileWrite.editTargetGone', lang, { path: p.path }));
    // 拼接在锁内做（读—拼—写不跨 await）：审批窗口期别人也往这个文件写过时两笔都不丢，
    // 不像 overwrite 那样只能拿基线拒写退回。追加动不了已有内容，故不设基线、不必先读过。
    await commitWorkfileEdit({
      absPath: p.path,
      mark: 'ai',
      apply: (cur) => joinAppend(p.path, cur, p.appendText ?? ''),
    });
    // 盲写收尾：模型只供了尾巴、没见过整篇 → 认知与所有权归零（否则「加一行」会附带解锁
    // 「整篇覆盖免审」，且随后的 read_file 会命中去重 stub 拿不到内容）。
    forgetAfterBlindWrite(p.conversationId, p.path);
    await broadcastFileChanged(p.path, 'ai');
    return;
  }

  if (p.mode === 'edit') {
    if (!existsSync(p.path)) throw new Error(t('main:fileWrite.editTargetGone', lang, { path: p.path }));
    const g = checkGuard(p.conversationId, p.path, 'edit', p.oldString);
    if (g !== 'ok') {
      throw new Error(t('main:fileWrite.editGuardChanged', lang, { guard: g, path: p.path }));
    }
    // read-apply-write 整段在 workfile 锁内（commitWorkfileEdit）：消除 TOCTOU + 覆盖前兜底不丢 + 打 'ai' 标。
    // apply 闭包即锁内重验挂点（S02 · G89，理想页 G3「锁内数到的才作数」）：与 emit 同套匹配语义
    // （弯引号归一 + 计数）重找——守卫二在锁外只为早失败，审批窗口内出现第二处相同原文时这里拦住。
    // 以异常穿透而非 CommitResult：重验逻辑属执行器（workfileWrite 不认识 oldString），只能从闭包抛出。
    let preEditContent = ''; // 锁内捕获改动前内容——D3 凭据续期要判「改动前磁盘仍与凭据相符」
    const updated = await commitWorkfileEdit({
      absPath: p.path,
      mark: 'ai',
      apply: (cur) => {
        preEditContent = cur;
        // 锁内冲突同样计入 recovery（review M1，出口与 emit 层同一活锁防线）。
        // 已接受的残余边缘：p.newString 的引号风格按 emit 时的 actualOld 调过（preserveQuoteStyle），
        // 若审批窗口内用户恰把目标段引号风格改掉，归一重找仍命中时替换产物可能引号混搭——
        // 修复需在 proposal 里存未调风格的原始 new_string，为极端场景扩字段不值当。
        const actualOld = findActualString(cur, p.oldString ?? '');
        if (actualOld === null) {
          recordTargetMoved(p.conversationId, p.path);
          throw new Error(t('main:fileWrite.editGuardChanged', lang, { guard: 'target-moved', path: p.path }));
        }
        if (!(p.replaceAll ?? false)) {
          const n = countMatches(cur, actualOld);
          if (n !== 1) {
            recordTargetMoved(p.conversationId, p.path);
            throw new Error(t('main:fileWrite.editTargetNotUnique', lang, { count: n, path: p.path }));
          }
        }
        const next = applyEdit(cur, actualOld, p.newString ?? '', p.replaceAll ?? false);
        if (next === cur) {
          throw new Error(t('main:fileWrite.editNoChange', lang, { path: p.path }));
        }
        return next;
      },
    });
    resetTargetMoved(p.conversationId, p.path); // 编辑成功落盘 → 清 recovery 计数
    // D3：edit 只能**续**所有权（迭代自己的产物），不能建立——对用户内容的 edit 会把凭据清掉
    renewOwnershipAfterEdit(p.conversationId, p.path, preEditContent, updated);
    afterWrite(p.conversationId, p.path, { mtime: floorMtime(p.path), content: updated, isPartialView: false });
    await broadcastFileChanged(p.path, 'ai'); // AI 落盘后广播：协同接收方「看见」（块①）+ 作者标（S27）
    return;
  }

  if (p.mode === 'delete') {
    await trashPath(p.path); // 抛错不 catch——回收站不可用时不降级永久删
    onDelete(p.conversationId, p.path);
    return;
  }

  if (p.mode === 'move' || p.mode === 'rename') {
    // S32·G49：复用项目相对的 mutate 内核（moveEntry/renameEntry）——含 .md+.assets 联动、引用回写、
    // 历史时间轴迁移（G93）、workfile 锁，绝不覆盖撞名。AI 侧只带绝对路径，故由前缀反查所属项目算相对路径。
    if (!existsSync(p.path)) throw new Error(t('main:fileWrite.mutateTargetGone', lang, { path: p.path }));
    const project = await findProjectByPath(p.path);
    if (!project) throw new Error(t('main:fileWrite.mutateNotInProject', lang, { path: p.path }));
    const srcRel = toPosix(relative(project.path, p.path));
    let r;
    if (p.mode === 'rename') {
      r = await renameEntry(project.path, srcRel, p.newName ?? '');
    } else {
      // 目标目录须在同一项目内（跨项目移动不支持——两套历史/资产根，语义复杂，超本期范围）
      const destProject = p.destDir ? await findProjectByPath(p.destDir) : null;
      if (!destProject || destProject.id !== project.id) {
        throw new Error(t('main:fileWrite.moveCrossProject', lang, { path: p.path }));
      }
      // 目标目录须已存在且是目录——否则 moveEntry 内核的 rename 会抛裸 ENOENT 穿透 i18n（review C-1）。
      if (!existsSync(p.destDir!) || !statSync(p.destDir!).isDirectory()) {
        throw new Error(t('main:fileWrite.moveDestNotDir', lang, { path: p.destDir }));
      }
      r = await moveEntry(project.path, srcRel, toPosix(relative(project.path, p.destDir!)));
    }
    if (r.status !== 'ok') {
      throw new Error(t(`main:fileWrite.mutate_${r.status}`, lang, { path: p.path }));
    }
    onDelete(p.conversationId, p.path); // 源路径已迁走，清对话对旧路径的读认知（防 stale 判定）
    const { broadcast } = await import('../ws/server'); // 树结构变了：目录级 fs.changed 刷新文件树/编辑器
    broadcast({ type: 'fs.changed', projectId: project.id });
    return;
  }
}
