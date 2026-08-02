/**
 * Markdown 导出 —— 自包含 HTML 单文件出口（技术方案 §四）。
 *
 * 渲染端传入的已是完整 HTML（正文 + base/主题 CSS，math/代码已预渲染）。主进程是纯执行器：
 *   1. 注入内联了字体的 katex <style>（vendored 资源，读 node_modules，见 katexAssets）；
 *   2. 把正文里的 oru-doc-img:// 图引用转 data URI——复用 inlineAssets 的正则替换内核，但 resolve 为
 *      md 新写：deck 版 resolve 是 `join(deckPath, ref)`，对协议 URL 会拼出垃圾路径；这里用
 *      parseDocImageUrl + 两道沙箱校验（resolveDocImageRequest）读盘，与渲染端 docImageUrl 往返一致。
 *   3. 原子落盘到源文档同目录、同名换后缀、撞名加序号。
 * 产物：单文件、零外部依赖、零 JS。导出全程只读源 md。
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { inlineAssets } from '../deck/exportHtml';
import { firstFreePath, writeExportAtomic } from '../deck/exportCommon';
import { injectKatexInto } from './katexAssets';
import { parseDocImageUrl, resolveDocImageRequest } from '../fs/docImageProtocol';

export async function exportDocToHtml(
  docAbsPath: string,
  html: string,
  resolveProjectRoot: (projectId: string) => Promise<string | null>,
): Promise<{ path: string; html: string; missing: string[] }> {
  const withKatex = await injectKatexInto(html);

  // oru-doc-img:// 图引用 → 文件内容。其余本地引用（不该有）返回 null 进 missing。
  const { html: inlined, missing } = await inlineAssets(withKatex, async (ref) => {
    if (!ref.startsWith('oru-doc-img://')) return null;
    const parsed = parseDocImageUrl(ref);
    if (!parsed) return null;
    const root = await resolveProjectRoot(parsed.projectId).catch(() => null);
    if (!root) return null;
    const resolved = await resolveDocImageRequest(root, parsed.docPath, parsed.imageRef);
    if (!resolved) return null;
    return readFile(resolved.filePath).catch(() => null);
  });

  const dir = dirname(docAbsPath);
  const base = basename(docAbsPath, extname(docAbsPath));
  const out = await firstFreePath(dir, base, 'html');
  await writeExportAtomic(out, inlined);
  return { path: out, html: inlined, missing };
}
