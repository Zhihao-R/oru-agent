/**
 * Slide diff 工具：比对前后两版 deck，算出哪些页变了（history.ts 落版本时记 changedPages 用）。
 *
 * 切页本身的单一来源是 `deckModel.segmentSlides`（放宽到任意标签 + class=slide）——本模块只在它之上
 * 做版本 diff，不自己认页。
 */
import { segmentSlides } from './deckModel';

/**
 * 比对前后两版 HTML，返回页号（0 起）的变化列表。
 * 直接字符串相等比对——HTML 文本量小（< 200KB / deck），sha256 hash 是过度。
 */
export function diffChangedPages(prev: string, next: string): number[] {
  const prevSlides = segmentSlides(prev);
  const nextSlides = segmentSlides(next);
  const maxLen = Math.max(prevSlides.length, nextSlides.length);
  const changed: number[] = [];
  for (let i = 0; i < maxLen; i += 1) {
    if ((prevSlides[i] ?? '') !== (nextSlides[i] ?? '')) changed.push(i);
  }
  return changed;
}
