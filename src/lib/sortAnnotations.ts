import type { Annotation } from '@shared/types';

/**
 * 标注排序（纯函数、不可变、稳定）
 *
 * 按 createdAt 升序——新标注追加到末尾，列表不因页码/翻页重排。
 * createdAt 相同（同毫秒落多条）时用原数组下标兜底，保持插入顺序稳定。
 * 不就地改入参——先 copy 再 sort。
 * （卡片上的 #N 是各列表内的局部显示号，见 AnnotPane；组与开放卡各自从 1 起。）
 */
export function sortAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations
    .map((a, i) => ({ a, i }))
    .sort((l, r) => l.a.createdAt - r.a.createdAt || l.i - r.i)
    .map((x) => x.a);
}
