/**
 * 候选缩略图：拉字节 → 归一化成 ≤512px PNG，喂进模型视野（image_search 用，决策 2/3）。
 *
 * N 路并发拉取、单张短超时、坏链/解码失败跳过不阻断（决策 2 的"部分失败"）：
 * 缩略图比原图更容易因 CDN/防盗链挂掉，绝不让一两条坏链拖垮整次搜图——返回存活的那几张，
 * 由调用方据存活数决定成功/失败（≥1 张即成功，全挂才报错）。
 */
import { safeImageFetch } from './safeFetch';
import { decodeThumbnails } from '../render/imageDecoder';
import type { ImageResultItem } from './types';

const THUMB_MAX_BYTES = 4 * 1024 * 1024; // 单张缩略图拉取上限（足够装下未降采样的全尺寸图）
const THUMB_TIMEOUT_MS = 8000;
const THUMB_MAX_WIDTH = 512;

export type SurvivedThumb = {
  item: ImageResultItem;
  pngBase64: string;
  width: number;
  height: number;
};

/** 拉单张缩略图字节（SSRF 逐跳 + 体积上限 + 超时）；失败/非图片返回 null（不抛，整批不被一条坏链中断）。 */
async function fetchOneThumbBytes(
  url: string,
  outerSignal: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const { bytes, mime } = await safeImageFetch(url, {
      maxBytes: THUMB_MAX_BYTES,
      timeoutMs: THUMB_TIMEOUT_MS,
      signal: outerSignal,
    });
    // 只接 image/*；HTML/错误页直接弃（防盗链常返回 200 + HTML）。缺 content-type 时交给 canvas 解码判定。
    if (mime && !mime.startsWith('image/')) return null;
    return { bytes, mime: mime || 'image/png' };
  } catch {
    return null;
  }
}

/**
 * 并发拉缩略图字节 + canvas 归一化成 PNG，返回前 count 张**存活**的（保持原候选顺序——
 * 文字清单与 images 据此严格同序）。
 *
 * items 即补位池——调用方按"约 25% contentUrl 会防盗链/坏链"多请求候选（见 imageSearch），
 * 这里并发拉全部、坏的跳过、按序取前 count 张存活的：既不因前排挂掉就少给模型看，又控在
 * 调用方请求的候选数内、不无界拉取（决策 2 的 N 路部分失败）。
 */
export async function fetchThumbnails(
  items: ImageResultItem[],
  opts: { count: number; signal: AbortSignal },
): Promise<SurvivedThumb[]> {
  const fetched = await Promise.all(
    items.map((it) => fetchOneThumbBytes(it.thumbnailUrl, opts.signal)),
  );
  const toDecode: { item: ImageResultItem; bytes: Uint8Array; mime: string }[] = [];
  fetched.forEach((f, i) => {
    if (f) toDecode.push({ item: items[i], bytes: f.bytes, mime: f.mime });
  });
  if (toDecode.length === 0) return [];
  const decoded = await decodeThumbnails(
    toDecode.map((d) => ({ bytes: d.bytes, mime: d.mime })),
    THUMB_MAX_WIDTH,
  );
  const survived: SurvivedThumb[] = [];
  decoded.forEach((d, i) => {
    if (d && survived.length < opts.count) {
      survived.push({
        item: toDecode[i].item,
        pngBase64: d.pngBase64,
        width: d.width,
        height: d.height,
      });
    }
  });
  return survived;
}
