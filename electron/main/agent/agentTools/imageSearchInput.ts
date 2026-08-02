/**
 * image_search 的纯函数：入参校验 + 候选清单文案拼装（不依赖 Electron / 网络，单测覆盖）。
 *
 * 文字清单只留挑图/下载真正要用的：序号、尺寸、源、contentUrl——**不放 description**
 * （图自己会说话；描述同样来自会撒谎的引擎文本，与"睁眼挑、不信文字"相左、还占 token）。
 * 清单序号与 images 数组严格同序——模型"看到第 i 张缩略图"就能在清单第 i 条找到 contentUrl。
 */
import type { ImageResultItem } from '../../search/types';

export type ParsedImageSearchInput = { query: string } | { error: string };

export function parseImageSearchInput(input: unknown): ParsedImageSearchInput {
  const { query } = (input ?? {}) as { query?: unknown };
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { error: 'image_search: query 不能为空' };
  }
  return { query: query.trim() };
}

export function hostOf(url: string | undefined): string {
  if (!url) return '?';
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

/** 一条候选的展示用最小信息——与 images 数组同序 */
export type CandidateLine = Pick<ImageResultItem, 'contentUrl' | 'sourceUrl' | 'width' | 'height'>;

/**
 * 候选清单文案。survived 已是"存活的缩略图"对应的候选（坏链/解码失败已剔除），
 * 故文字条数 == images 张数 == survived.length，天然同序。
 */
export function formatCandidatesText(
  query: string,
  engineUsed: string,
  candidates: CandidateLine[],
): string {
  const head = `通过 ${engineUsed} 搜图：${query}\n看到 ${candidates.length} 张候选缩略图（下面序号对应你视野里的图）。挑一张用 download_image 下载（url 填该条 contentUrl）。\n`;
  const body = candidates
    .map((c, i) => {
      const size = c.width && c.height ? `${c.width}×${c.height}` : '尺寸未知';
      return `[${i + 1}] ${size} · 源 ${hostOf(c.sourceUrl)} · contentUrl=${c.contentUrl}`;
    })
    .join('\n');
  return head + '\n' + body;
}
