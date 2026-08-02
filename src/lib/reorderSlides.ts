/**
 * 计算 slide 重排后的新页顺序数组。
 *
 * 约定：返回数组 newOrder 满足 newOrder[newPos] = oldPageIndex。
 * 返回 null 表示"等同于不动"——拖回原位时跳过一次多余的 WS 调用。
 *
 * @param n      slide 总数
 * @param from   被拖动卡片的原页 index
 * @param target 落点卡片的页 index
 * @param pos    落在 target 的前面('before')还是后面('after')
 */
export function computeNewOrder(
  n: number,
  from: number,
  target: number,
  pos: 'before' | 'after',
): number[] | null {
  const arr = Array.from({ length: n }, (_, i) => i);
  const [moved] = arr.splice(from, 1);
  // splice 抽走 from 后，原 target 索引可能左移一格
  let insertAt = target;
  if (from < target) insertAt -= 1;
  if (pos === 'after') insertAt += 1;
  arr.splice(insertAt, 0, moved);
  // 判定是否真正变化：跟原 identity 数组相等就跳过
  let changed = false;
  for (let i = 0; i < n; i += 1) {
    if (arr[i] !== i) { changed = true; break; }
  }
  return changed ? arr : null;
}
