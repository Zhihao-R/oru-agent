/**
 * assetStore —— md 文档本地图片的落盘内核（粘贴 / 拖入 / 裁剪输出）。
 *
 * 图片字节存每篇文档旁的 `<文档名>.assets/`，引用走相对路径（PRD §二、技术方案 §七）。
 * 不走 safeWrite（只收 string）：Buffer 无 BOM/CRLF 顾虑，用 writeFile(flag:'wx') 原子创建——
 * 撞名抛 EEXIST 即换序号重试，这是内核级防 TOCTOU，比「先探空位再写」少一个并发窗口。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { recordOruWrite } from './oruWrites';

/** 文件名非法字符（与 mutate.ILLEGAL_NAME / fsStore.illegalName 同款，不能含路径分隔符）。 */
const ILLEGAL_NAME = /[/:\\]/g;

/** 图片扩展名白名单（与 docImageProtocol.EXT_MIME 同口径）。后端守门：ext 来自渲染端 IPC，
 *  不校验则恶意 ext（含 `/../`）会让 join 逃出 assetsDir 写任意文件。 */
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** 把任意来源的「期望基名」消解成安全单层 leaf：剥掉目录段、非法字符、前导点，空则兜底。 */
function safeBaseName(preferred: string): string {
  const leaf = basename(preferred).replace(ILLEGAL_NAME, '').replace(/^\.+/, '');
  return leaf === '' ? '图片' : leaf;
}

/** `<文档名>.assets/` 中文档名 = 去掉扩展名的文件基名（方案.md → 方案）。 */
function assetsDirName(docAbsPath: string): string {
  return `${basename(docAbsPath, extname(docAbsPath))}.assets`;
}

/**
 * 纯候选名生成：把「基名 + 序号 + 扩展名」拼成一个候选文件名（§八）。
 * 首个候选（n=1）不带序号；n≥2 在基名与扩展名间插「sep + 序号」，格式对齐 duplicateEntry 的空格序号。
 * 落地真伪不由它判定——由 §7.2 的 `wx` 原子创建裁决，撞名则 n+1 再生成下一个候选。
 *
 * @param base 文件名基（不含扩展名）
 * @param ext  扩展名（含点，extname 直接喂入，如 '.png'）
 * @param n    序号，从 1 起
 * @param sep  基名与序号的分隔符，默认空格
 */
export function uniqueLeaf(base: string, ext: string, n: number, sep = ' '): string {
  return n === 1 ? `${base}${ext}` : `${base}${sep}${n}${ext}`;
}

/**
 * 把图片字节落进文档旁的 `<文档名>.assets/`，返回相对该文档目录的引用（`<文档名>.assets/<唯一名>`）。
 *
 * 并发取名靠 `wx`（O_CREAT|O_EXCL）原子创建挡 TOCTOU：撞名抛 EEXIST → 序号 +1 重生成候选重试。
 * 不靠「先探空位再写」——那有窗口，两图同时落地会互相覆盖（§7.2）。
 *
 * @param docAbsPath 文档绝对路径（已由 ensureWithinProject 校验在项目内，assets 是其同目录附属）
 * @param bytes      图片字节
 * @param preferredBase 期望基名（来自剪贴板文件名 / 默认名，内部消解成安全 leaf）
 * @param ext        扩展名（含点，如 '.png'）
 */
export async function writeImageToAssets(
  docAbsPath: string,
  bytes: Buffer,
  preferredBase: string,
  ext: string,
): Promise<string> {
  const safeExt = ext.toLowerCase();
  if (!IMG_EXTS.has(safeExt)) {
    // 守门：非白名单 ext（含 `/../` 逃逸构造）一律拒，绝不让落盘逃出 assetsDir
    throw new Error(`writeImageToAssets: 非法图片扩展名 ${JSON.stringify(ext)}`);
  }
  const dirName = assetsDirName(docAbsPath);
  const assetsDir = join(dirname(docAbsPath), dirName);
  await mkdir(assetsDir, { recursive: true });

  const base = safeBaseName(preferredBase);
  // 候选序号上限兜底（实际不可达）：1000 个候选都被占则抛，避免无限循环。
  for (let n = 1; n <= 1000; n++) {
    const leaf = uniqueLeaf(base, safeExt, n);
    const abs = join(assetsDir, leaf);
    try {
      await writeFile(abs, bytes, { flag: 'wx' });
      recordOruWrite(abs); // 登记 Oru 自有写盘，免被 bash 后 mtime 校验误报「外部修改」（与 safeWrite 一致）
      return `${dirName}/${leaf}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; // 撞名——换下一个序号
      throw e;
    }
  }
  throw new Error(`writeImageToAssets: 1000 个候选名都被占用：${base}${safeExt}`);
}
