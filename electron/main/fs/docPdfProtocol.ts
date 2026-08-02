/**
 * oru-doc-pdf:// 自定义协议 handler —— PDF 查看器（自绘）的渲染端加载通路（tech design §二）。
 *
 * 解决问题：与 oru-doc-img:// 同——主窗口受 webSecurity 拦不能 file://；pdfjs 的 getDocument({url})
 * 需一个可 fetch 的 URL。既有五个图片协议各钉死目录结构、都不服务「项目内任意 PDF」，故新增。
 *
 * URL 形态：oru-doc-pdf://local/<enc projectId>/<enc 项目相对 pdf path>。两段各整段
 *   encodeURIComponent（含其中的 `/`），渲染端只持「项目相对 path」、不碰 fs 绝对布局。
 *   比 docImage 少第三段 imageRef——PDF 是文件本身，无 `.assets/` 落点概念，故只一道沙箱。
 *
 * 沙箱：pdfPath 不可信（渲染端可手搓 URL 指向 `../../evil`），一道 ensureWithinProject 校验在项目内、
 *   逃逸即拒 + realpath 抹平 symlink（项目内 symlink 指向项目外的 pdf 也挡掉），扩展名白名单只 `.pdf`。
 *   第一期整份 readFile 返回 200，不做 Range（本地读非瓶颈，见 tech design §二）。
 */
import { protocol } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import { extname, relative, isAbsolute } from 'node:path';
import { ensureWithinProject } from './projectPath';

/** 解析出的 URL 两段（projectId / 项目相对 pdf path）。 */
type DocPdfRef = { projectId: string; pdfPath: string };

/**
 * 把请求 URL 拆成 (projectId, pdfPath) 两段；畸形 / 段数不为 2 返回 null（不抛）。
 * pathname 形如 `/<enc projectId>/<enc pdfPath>`：各段独立 encode，解码后即原值（含 `/`）。
 * 严格要求恰好两段——多余段视为畸形，直接拒（PDF URL 无第三段语义）。
 */
export function parseDocPdfUrl(url: string): DocPdfRef | null {
  let segs: string[];
  try {
    // decodeURIComponent 对畸形 % 序列抛 URIError，与 URL 解析一起接住。
    segs = new URL(url).pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segs.length !== 2) return null;
  const [projectId, pdfPath] = segs;
  if (!projectId || !pdfPath) return null;
  return { projectId, pdfPath };
}

/**
 * 把 pdfPath 解析为通过沙箱校验的 pdf realpath；不合法返回 null、保证不 throw。
 * 独立成异步纯函数：Electron 之外可单测（attacker path / 绝对路径 / symlink 越界 / 非 .pdf）。
 *
 * 判定（全满足才放行）：
 *   1. pdfPath 经 ensureWithinProject 校验在项目内（`../` / 绝对路径逃逸即 throw → null）。
 *   2. realpath 后仍在项目内（挡项目内 symlink 指向项目外）——realpath 抹平 /var→/private/var 等 OS symlink。
 *   3. 扩展名 `.pdf`（大小写不敏感）。
 */
export async function resolveDocPdfRequest(
  projectRoot: string,
  pdfPath: string,
): Promise<{ filePath: string } | null> {
  let reqAbs: string;
  try {
    reqAbs = await ensureWithinProject(projectRoot, pdfPath);
  } catch {
    return null;
  }
  if (extname(reqAbs).toLowerCase() !== '.pdf') return null;

  let realPdf: string;
  let realRoot: string;
  try {
    realPdf = await realpath(reqAbs);
    realRoot = await realpath(projectRoot);
  } catch {
    return null; // 文件不存在 / 项目根异常 → 视为非法
  }
  // realpath 后仍须在项目内（symlink 指向项目外的 pdf 挡在此）
  const rrel = relative(realRoot, realPdf);
  if (rrel.startsWith('..') || isAbsolute(rrel)) return null;
  return { filePath: realPdf };
}

/**
 * 在 app.whenReady() 之后调用，注册 oru-doc-pdf:// 协议的请求 handler。
 * @param resolveProjectRoot 用 projectId 查项目根绝对路径（main 接 projects store 的 getProject）。
 */
export function registerDocPdfProtocol(
  resolveProjectRoot: (projectId: string) => Promise<string | null>,
): void {
  protocol.handle('oru-doc-pdf', async (request) => {
    const ref = parseDocPdfUrl(request.url);
    if (!ref) return new Response('Forbidden', { status: 403 });
    const projectRoot = await resolveProjectRoot(ref.projectId).catch(() => null);
    if (!projectRoot) return new Response('Forbidden', { status: 403 });
    const resolved = await resolveDocPdfRequest(projectRoot, ref.pdfPath);
    if (!resolved) return new Response('Forbidden', { status: 403 });
    try {
      const data = await readFile(resolved.filePath);
      return new Response(data, { headers: { 'Content-Type': 'application/pdf' } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
