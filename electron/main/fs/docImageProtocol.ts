/**
 * oru-doc-img:// 自定义协议 handler —— md 文档本地图片（`<文档名>.assets/`）的渲染端加载通路。
 *
 * 解决问题：与 oru-conv-img:// / oru-toolimg:// 同——主窗口 `<img>` 受 webSecurity 拦不能 file://。
 * 现有四个协议沙箱各自钉死目录结构，没一个服务「项目内文档的 .assets/」，故新增（技术方案 §二）。
 *
 * URL 形态：oru-doc-img://local/<projectId>/<文档项目相对 path>/<图相对文档的引用…>。
 *   前两段是「文档身份」（projectId + 项目相对文档 path），各整段 encodeURIComponent（含其中的 `/`），
 *   其后所有段拼回 = 图相对文档的引用。渲染端只持「项目相对 path」、不碰 fs 绝对布局。
 *
 * 沙箱（两道 ensureWithinProject，缺一不可）：
 *   ① 文档身份一道：URL 自带的文档 path **不能信**（文档内容可手搓 URL 指向 `../../evil`），故拿 projectId
 *      查项目根，把 docPath 经 ensureWithinProject 校验在项目内、逃逸即拒——和 fs.setActiveDoc 当初算
 *      docDir 同一套校验，只是文档身份从「全局推送」改成「URL 自带 + 沙箱兜底」（右栏多标签去全局态，§4.1）。
 *   ② 图片落点一道：再钉死到「该文档自己的 `<文档名>.assets/`」，图引用 imageRef 仍只相对文档解析、
 *      经 ensureWithinProject 校验最终图片在 assets 下（imageRef 含 `../` 逃出 assets 即拒）。
 * assets 在项目内、用户/AI 可写，symlink 风险比 conv-img（隐藏区）大，故 **必须 realpath**（向 tool/crop/avatar 多数派对齐）。
 */
import { protocol } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { ensureWithinProject } from './projectPath';

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 解析出的 URL 三段（projectId / 项目相对文档 path / 图相对文档的引用）。 */
type DocImageRef = { projectId: string; docPath: string; imageRef: string };

/**
 * 把请求 URL 拆成 (projectId, docPath, imageRef) 三段；畸形 URL / 段数不足返回 null（不抛）。
 * pathname 形如 `/<enc projectId>/<enc docPath>/<enc seg>/<enc seg>…`：前两段是文档身份（各整段编码、
 * 解码后即原值含 `/`），第三段起拼回 = imageRef（保留段内 `/` 作分隔）。各段独立 encode 故无分隔歧义。
 */
export function parseDocImageUrl(url: string): DocImageRef | null {
  let segs: string[];
  try {
    // decodeURIComponent 对畸形 % 序列抛 URIError，与 URL 解析一起接住。
    segs = new URL(url).pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segs.length < 3) return null; // 至少 projectId + docPath + 一段 imageRef
  const [projectId, docPath, ...rest] = segs;
  if (!projectId || !docPath) return null;
  return { projectId, docPath, imageRef: rest.join('/') };
}

/**
 * 把 (docPath, imageRef) 解析为通过两道沙箱校验的图片 realpath + mime；不合法返回 null、保证不 throw。
 * 独立成异步纯函数：Electron 之外可单测（含 attacker docPath / imageRef、realpath / symlink 越界）。
 * projectRoot 由 caller 经 projectId 查得（测试直接传临时目录当根）。
 *
 * 判定（全满足才放行）：
 *   1. 文档身份一道：docPath 经 ensureWithinProject 校验在项目内（`../` 逃逸即 throw → null）。
 *   2. 图片落点一道：imageRef 相对 docDir 解析后经 ensureWithinProject 校验仍在项目内（拦 `../` 出项目）。
 *   3. realpath 后必须直属 `<docDir>/<docName>.assets/`——钉死到该文档自己的 assets，
 *      不是「路径里任意一段以 .assets 结尾」（evil.assets / 嵌套 .assets / assets 内再嵌子目录全挡）。
 *   4. assets 目录本身若是 symlink 指向异名目录，realpath 后 basename 变 → 挡住「把 X.assets 软链到别处」。
 *   5. 图片扩展名白名单。
 */
export async function resolveDocImageRequest(
  projectRoot: string,
  docPath: string,
  imageRef: string,
): Promise<{ filePath: string; mime: string } | null> {
  let docDir: string;
  let docName: string;
  let reqAbs: string;
  try {
    // ① 文档身份：URL 里的 docPath 不可信，经沙箱校验逃逸即 throw。校验通过的绝对路径才用来算 docDir。
    const docAbs = await ensureWithinProject(projectRoot, docPath);
    docDir = dirname(docAbs);
    docName = basename(docAbs, extname(docAbs));
    // ② 图片落点：imageRef 仍只相对 docDir 解析，再经沙箱校验仍在项目内（拦 imageRef 里的 `../` 出项目）。
    reqAbs = await ensureWithinProject(projectRoot, resolve(docDir, imageRef));
  } catch {
    return null;
  }

  let realImg: string;
  let realAssets: string;
  try {
    realImg = await realpath(reqAbs);
    // 期望 assets 目录：该文档自己的 <docName>.assets；realpath 抹平 /var→/private/var 等 OS symlink
    realAssets = await realpath(resolve(docDir, `${docName}.assets`));
  } catch {
    return null; // 图片不存在 / assets 目录不存在 → 视为非法
  }

  // 直属该文档 assets（蕴含单层：realImg 的父目录恰是 assets 目录）
  if (dirname(realImg) !== realAssets) return null;
  // assets 目录本身若是 symlink 指向异名目录，realpath 后 basename 会变——挡住「把 X.assets 软链到别处」
  if (basename(realAssets) !== `${docName}.assets`) return null;

  const mime = EXT_MIME[extname(realImg).toLowerCase()];
  if (!mime) return null;
  return { filePath: realImg, mime };
}

/**
 * 在 app.whenReady() 之后调用，注册 oru-doc-img:// 协议的请求 handler。
 * @param resolveProjectRoot 用 projectId 查项目根绝对路径（main 接 projects store 的 getProject）。
 */
export function registerDocImageProtocol(
  resolveProjectRoot: (projectId: string) => Promise<string | null>,
): void {
  protocol.handle('oru-doc-img', async (request) => {
    const ref = parseDocImageUrl(request.url);
    if (!ref) return new Response('Forbidden', { status: 403 });
    const projectRoot = await resolveProjectRoot(ref.projectId).catch(() => null);
    if (!projectRoot) return new Response('Forbidden', { status: 403 });
    const resolved = await resolveDocImageRequest(projectRoot, ref.docPath, ref.imageRef);
    if (!resolved) return new Response('Forbidden', { status: 403 });
    try {
      const data = await readFile(resolved.filePath);
      return new Response(data, { headers: { 'Content-Type': resolved.mime } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
