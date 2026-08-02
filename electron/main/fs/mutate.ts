/**
 * mutate —— 用户对项目内文件的"改名 / 复制 / 移动 / 删除"链路，与 createFile（建新）、
 * 各编辑器 writeMd/writeText（存内容）分开。这一组都是直接操作整个条目（文件或文件夹），
 * 共用一套 MutateResult，承重不变量：撞名绝不覆盖、越界/自吞挡死、源没了如实报 not-found。
 *
 * 后端是真值守门——撞名/自吞/越界一律在这里挡（attacker 也挡得住），前端只做体验预判。
 */
import { cp, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, normalize, resolve } from 'node:path';
import { ensureWithinProject } from './projectPath';
import { trashPath } from './trash';
import { runExclusive } from './runExclusive';
import { readWithMetaAsync, safeWriteAsync } from './safeWrite';
import * as fileHistory from './fileHistory';
import { relocateTablePrefs } from './tablePrefs';

/**
 * S28（G93）：改名/移动成功后把按文件寻址的托管元数据（历史时间轴 + 表格视图偏好）迁到新路径——
 * 二者都按内容寻址=sha256(fileKey)，路径一变寻址即断。
 * best-effort：迁移失败各自降级（历史断链 / 偏好丢失），不回滚已成功的文件移动、不误报移动失败。
 * 在 workfile 锁内调，旧路径此刻无并发落盘。fileKey 口径与 commitWorkfileWrite 一致=resolve(绝对路径)。
 */
async function relocateFileMeta(absSrc: string, absDest: string): Promise<void> {
  try {
    await fileHistory.relocate(resolve(absSrc), resolve(absDest));
  } catch (e) {
    console.warn('[oru.fileHistory] 历史时间轴迁移失败（文件已移动，历史暂断链）:', e);
  }
  try {
    await relocateTablePrefs(resolve(absSrc), resolve(absDest));
  } catch (e) {
    console.warn('[oru.tablePrefs] 表格视图偏好迁移失败（文件已移动，偏好暂丢）:', e);
  }
}

export type MutateResult =
  | { status: 'ok'; path: string; content?: string } // path = 操作后的目标相对路径；content = 改名回写后的新内容（仅 .md+assets 改名）
  | { status: 'conflict' } // 目标已存在 / 撞名
  | { status: 'invalid' } // 越界 / 自吞 / 非法名
  | { status: 'not-found' } // 源已不在（并发被删）
  | { status: 'incomplete' }; // 主操作部分完成、回滚也可能失败——明确未完成，让用户检查（§九）

/**
 * `.assets` 文件夹改名的执行步——抽成可注入变量，供测试注入「rename 失败」验证回滚分支（§十二）。
 * 与 trash.ts 的 trashImpl 同范式。
 */
let assetsRenameImpl: (from: string, to: string) => Promise<void> = (from, to) => rename(from, to);

/** 仅供测试注入 mock assets rename（验证回滚 / incomplete 分支）。 */
export function setAssetsRenameImplForTest(fn: (from: string, to: string) => Promise<void>): void {
  assetsRenameImpl = fn;
}

/** 文件/文件夹名非法字符——与 fsStore.illegalName 同款（不能含路径分隔符）。 */
const ILLEGAL_NAME = /[/:\\]/;

/** 正则元字符转义——旧文档名可能含 . ( ) 等，拼进 RegExp 前先转义。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 改名时把文档内对「自己的 assets」的引用从 `<旧名>.assets/` 回写成 `<新名>.assets/`。
 * 定界锚定：前缀必须是 `(` / `"` / `'`（markdown 链接或 <img src>），可带 `./`，后面紧跟 `.assets/`——
 * 只动真引用，不误伤正文里偶然出现的同名文字，也不碰别篇文档的 assets（名字不同自然不匹配）。
 */
export function rewriteAssetRefs(content: string, oldName: string, newName: string): string {
  const re = new RegExp(`(["'(])(\\./)?${escapeRegExp(oldName)}\\.assets/`, 'g');
  return content.replace(re, (_m, delim: string, dot: string | undefined) => {
    return `${delim}${dot ?? ''}${newName}.assets/`;
  });
}

/** posix 拼接：dir==='.'（根）时不加前缀。relDir 来自 dirname，根为 '.'。 */
function joinRel(relDir: string, leaf: string): string {
  return relDir === '.' || relDir === '' ? leaf : `${relDir}/${leaf}`;
}

/** 同目录改名。撞名 → conflict（不覆盖）；非法名 → invalid；源没了 → not-found。 */
export async function renameEntry(
  projectRoot: string,
  relPath: string,
  newName: string,
): Promise<MutateResult> {
  if (newName === '' || ILLEGAL_NAME.test(newName)) return { status: 'invalid' };
  const norm = normalize(relPath);
  const absSrc = await ensureWithinProject(projectRoot, norm);
  const relDir = dirname(norm);
  const newRel = joinRel(relDir, newName);
  const absDest = await ensureWithinProject(projectRoot, normalize(newRel));

  try {
    await stat(absSrc);
  } catch {
    return { status: 'not-found' };
  }

  // .md 文档改了基名、且同名 .assets 存在：联动改 assets 名 + 回写文档内引用，整段进 workfile 锁（§十一）。
  if (extname(norm).toLowerCase() === '.md') {
    const oldName = basename(norm, extname(norm));
    const newBase = basename(newName, extname(newName));
    if (oldName !== newBase) {
      const absOldAssets = await ensureWithinProject(
        projectRoot,
        normalize(joinRel(relDir, `${oldName}.assets`)),
      );
      if (existsSync(absOldAssets)) {
        const absNewAssets = await ensureWithinProject(
          projectRoot,
          normalize(joinRel(relDir, `${newBase}.assets`)),
        );
        return renameMdWithAssets({ absSrc, absDest, newRel, oldName, newBase, absOldAssets, absNewAssets });
      }
    }
  }

  // 普通改名（非 .md / 无 assets / 仅改扩展名）：也整段进 workfile 锁（G97）——锁 key = resolve(源) =
  // commitWorkfileWrite 同一把锁，与 csv 等的实时保存互斥，挡「改名瞬间恰好 autosave 往旧路径落盘、
  // 把已移走的文件凭空写回」。锁内重检源存在性（对齐 .md 分支）。
  return runExclusive(resolve(absSrc), async () => {
    if (!existsSync(absSrc)) return { status: 'not-found' }; // 锁内重检源（并发删/移）
    if (existsSync(absDest)) return { status: 'conflict' }; // 目标已存在，绝不覆盖
    await rename(absSrc, absDest);
    await relocateFileMeta(absSrc, absDest); // G93：历史随文件走，改名不断链
    return { status: 'ok', path: newRel };
  });
}

/**
 * `.md` + 同名 `.assets` 的联动改名（§九/§十一 承重）。锁 key = resolve(旧 .md) = commitWorkfileWrite
 * 同一把 workfile 锁，天然与实时保存互斥——挡住「改名回写」与「pending autosave」交错丢更新（C-1/C-2）。
 *
 * 顺序：把最难逆的步骤排最后——先写可删的新 .md → 再 rename .assets → 最后删旧 .md 作 commit 点。
 * 回滚是 best-effort：assets rename 失败则删回新 .md、返回 incomplete（非假 ok，让用户检查）。
 */
async function renameMdWithAssets(args: {
  absSrc: string;
  absDest: string;
  newRel: string;
  oldName: string;
  newBase: string;
  absOldAssets: string;
  absNewAssets: string;
}): Promise<MutateResult> {
  const { absSrc, absDest, newRel, oldName, newBase, absOldAssets, absNewAssets } = args;
  return runExclusive(resolve(absSrc), async () => {
    if (!existsSync(absSrc) || !existsSync(absOldAssets)) return { status: 'not-found' }; // 锁内重检源（并发删除）
    if (existsSync(absDest) || existsSync(absNewAssets)) return { status: 'conflict' }; // 绝不覆盖
    const { content, lineEnding } = await readWithMetaAsync(absSrc); // 读最新磁盘版（含 in-flight autosave）
    const rewritten = rewriteAssetRefs(content, oldName, newBase);
    await safeWriteAsync(absDest, rewritten, lineEnding); // 1. 写新 .md（可删）
    try {
      await assetsRenameImpl(absOldAssets, absNewAssets); // 2. rename .assets
    } catch {
      await rm(absDest, { force: true }).catch(() => {}); // 回滚新 .md（best-effort）
      return { status: 'incomplete' };
    }
    await rm(absSrc, { force: true }); // 3. commit point：删旧 .md
    await relocateFileMeta(absSrc, absDest); // G93：.md 历史随文件走（.assets 无独立历史）
    return { status: 'ok', path: newRel, content: rewritten };
  });
}

/**
 * 同目录生成副本：「基础名 <suffix>.ext」，撞名加序号「基础名 <suffix> 2.ext」。文件夹整树复制。
 * `suffix` 是已按 owner 语言解析好的后缀词（zh「副本」/ en「copy」）——内核不持 i18n，由调用方注入译文。
 */
export async function duplicateEntry(projectRoot: string, relPath: string, suffix: string): Promise<MutateResult> {
  const absSrc = await ensureWithinProject(projectRoot, normalize(relPath));
  let isDir: boolean;
  try {
    isDir = (await stat(absSrc)).isDirectory();
  } catch {
    return { status: 'not-found' };
  }
  const norm = normalize(relPath);
  const relDir = dirname(norm);
  const ext = isDir ? '' : extname(norm); // 文件夹不拆扩展名
  const base = basename(norm, ext);

  // .md + 同名 .assets：副本自包含——复制独立 assets + 把副本内引用就地回写指向副本自己（§九，消解多引用隐患）。
  if (!isDir && ext.toLowerCase() === '.md') {
    const absSrcAssets = await ensureWithinProject(
      projectRoot,
      normalize(joinRel(relDir, `${base}.assets`)),
    );
    if (existsSync(absSrcAssets)) {
      return duplicateMdWithAssets(projectRoot, absSrc, relDir, base, ext, absSrcAssets, suffix);
    }
  }

  for (let n = 1; n <= 1000; n++) {
    const candRel = joinRel(relDir, `${base} ${suffix}${n === 1 ? '' : ` ${n}`}${ext}`);
    const absDest = await ensureWithinProject(projectRoot, normalize(candRel));
    try {
      await stat(absDest);
      continue; // 撞名，换下一个序号
    } catch {
      // 空位——落地
    }
    await cp(absSrc, absDest, { recursive: true });
    return { status: 'ok', path: candRel };
  }
  return { status: 'conflict' }; // 1000 个候选都被占（兜底，实际不可达）
}

/**
 * `.md` + 同名 `.assets` 的副本（§九）。副本未打开、无并发，故不入锁。撞名序号要 `.md` 与 `.assets`
 * 双双空位才落地；副本内引用从 `<原名>.assets/` 回写成 `<副本名>.assets/`，指向副本自己的图。
 */
async function duplicateMdWithAssets(
  projectRoot: string,
  absSrc: string,
  relDir: string,
  base: string,
  ext: string,
  absSrcAssets: string,
  suffix: string,
): Promise<MutateResult> {
  for (let n = 1; n <= 1000; n++) {
    const copyBase = `${base} ${suffix}${n === 1 ? '' : ` ${n}`}`;
    const candMdRel = joinRel(relDir, `${copyBase}${ext}`);
    const candAssetsRel = joinRel(relDir, `${copyBase}.assets`);
    const absCandMd = await ensureWithinProject(projectRoot, normalize(candMdRel));
    const absCandAssets = await ensureWithinProject(projectRoot, normalize(candAssetsRel));
    if (existsSync(absCandMd) || existsSync(absCandAssets)) continue; // 任一被占都换序号
    await cp(absSrcAssets, absCandAssets, { recursive: true });
    const { content, lineEnding } = await readWithMetaAsync(absSrc);
    await safeWriteAsync(absCandMd, rewriteAssetRefs(content, base, copyBase), lineEnding);
    return { status: 'ok', path: candMdRel };
  }
  return { status: 'conflict' };
}

/**
 * 移到目标文件夹（destDir 相对项目根，''=根）。三个边界按"绝不误伤"挡：
 *   自吞（destDir 是 src 自身或子孙）→ invalid；原地（destDir 就是当前父目录）→ ok 无操作；
 *   撞名（目标已有同名）→ conflict 留原处。
 */
export async function moveEntry(
  projectRoot: string,
  srcRel: string,
  destDir: string,
): Promise<MutateResult> {
  const srcNorm = normalize(srcRel);
  const absSrc = await ensureWithinProject(projectRoot, srcNorm);
  const destDirNorm = destDir === '' ? '' : normalize(destDir);

  // 自吞：把文件夹移进它自己或子孙目录——目录结构会自吞，挡死
  if (destDirNorm === srcNorm || destDirNorm.startsWith(`${srcNorm}/`)) return { status: 'invalid' };
  // 原地：目标父目录就是当前父目录——无操作（dirname 根为 '.'，destDir 根为 ''）
  const srcParent = dirname(srcNorm);
  if (srcParent === '.' ? destDirNorm === '' : srcParent === destDirNorm) {
    return { status: 'ok', path: srcRel };
  }
  const destRel = joinRel(destDirNorm, basename(srcNorm));
  const absDest = await ensureWithinProject(projectRoot, normalize(destRel));

  try {
    await stat(absSrc);
  } catch {
    return { status: 'not-found' };
  }

  // 任何 .md 的移动都整段进 workfile 锁——防移动中实时保存往旧路径写、把已移走的文件重建出来
  // （§十一 C-2；不止有 .assets 时）。同名 .assets 存在则一并移；相对引用同移不变，不回写内容。
  if (extname(srcNorm).toLowerCase() === '.md') {
    const name = basename(srcNorm, extname(srcNorm));
    const absSrcAssets = await ensureWithinProject(
      projectRoot,
      normalize(joinRel(srcParent, `${name}.assets`)),
    );
    const absDestAssets = await ensureWithinProject(
      projectRoot,
      normalize(joinRel(destDirNorm, `${name}.assets`)),
    );
    return runExclusive(resolve(absSrc), async () => {
      if (!existsSync(absSrc)) return { status: 'not-found' };
      const hasAssets = existsSync(absSrcAssets);
      if (existsSync(absDest) || (hasAssets && existsSync(absDestAssets))) {
        return { status: 'conflict' };
      }
      await rename(absSrc, absDest);
      if (hasAssets) {
        try {
          await rename(absSrcAssets, absDestAssets);
        } catch {
          await rename(absDest, absSrc).catch(() => {}); // 回滚 .md（best-effort）
          return { status: 'incomplete' };
        }
      }
      await relocateFileMeta(absSrc, absDest); // G93：历史随文件走
      return { status: 'ok', path: destRel };
    });
  }

  // 非 .md 也整段进 workfile 锁（G97）——与实时保存互斥，锁内重检源存在性。
  return runExclusive(resolve(absSrc), async () => {
    if (!existsSync(absSrc)) return { status: 'not-found' }; // 锁内重检源（并发删/移）
    if (existsSync(absDest)) return { status: 'conflict' }; // 目标已有同名，留原处
    await rename(absSrc, absDest);
    await relocateFileMeta(absSrc, absDest); // G93：历史随文件走
    return { status: 'ok', path: destRel };
  });
}

/** 删到系统回收站（共用 fs/trash 内核）。源没了 → not-found；.md 连同同名 .assets 一并删。 */
export async function trashEntry(projectRoot: string, relPath: string): Promise<MutateResult> {
  const norm = normalize(relPath);
  const abs = await ensureWithinProject(projectRoot, norm);
  try {
    await stat(abs);
  } catch {
    return { status: 'not-found' };
  }

  // 任何 .md 的删除都整段进 workfile 锁——防删除中实时保存往旧路径写、把已删文件从回收站"复活"
  // （§十一 C-2；不止有 .assets 时）。同名 .assets 存在则一并删。
  if (extname(norm).toLowerCase() === '.md') {
    const name = basename(norm, extname(norm));
    const absAssets = await ensureWithinProject(
      projectRoot,
      normalize(joinRel(dirname(norm), `${name}.assets`)),
    );
    return runExclusive(resolve(abs), async () => {
      if (!existsSync(abs)) return { status: 'not-found' };
      if (!existsSync(absAssets)) {
        await trashPath(abs); // 无附属：单步，trash 抛错原样传播、不降级永久删（决策 5）
        return { status: 'ok', path: norm };
      }
      // 有附属：两步可能部分失败，先删附属（失败则本体原封不动可重试）、再删本体（commit 点）
      try {
        await trashPath(absAssets);
        await trashPath(abs);
      } catch {
        return { status: 'incomplete' }; // 部分失败不裸抛，诚实报未完成
      }
      return { status: 'ok', path: norm };
    });
  }

  // 非 .md 也整段进 workfile 锁（G97）——与实时保存互斥，挡「删除瞬间 autosave 往旧路径落盘复活文件」。
  return runExclusive(resolve(abs), async () => {
    if (!existsSync(abs)) return { status: 'not-found' }; // 锁内重检源（并发删）
    await trashPath(abs);
    return { status: 'ok', path: norm };
  });
}
