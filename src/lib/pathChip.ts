import { openableKind } from '@/lib/openProjectFile';

/**
 * 正文行内 code 的「文件路径候选」判定（纯函数）——路径 chip 化的第一道闸。
 *
 * 候选 = 无空白、非 URL、扩展名属可开类型（md/csv/html/图片）的相对路径；
 * 绝对路径在项目根内则折算成相对。是否真实存在由 pathExistsStore 异步判（第二道闸），
 * 两道都过才渲染成 chip——不存在的路径保持普通 code，避免点了没反应。
 */
export function candidateRelPath(text: string, projectRoot: string): string | null {
  if (text.length > 260 || /\s/.test(text) || text.includes('://')) return null;
  let rel: string;
  if (text.startsWith('/')) {
    if (!text.startsWith(`${projectRoot}/`)) return null;
    rel = text.slice(projectRoot.length + 1);
  } else {
    rel = text.startsWith('./') ? text.slice(2) : text;
  }
  if (rel.length === 0 || rel.split('/').includes('..')) return null;
  return openableKind(rel) ? rel : null;
}
