/**
 * 标签栏宽度分配：由容器宽度算出「谁留在栏里、各多宽、谁进溢出菜单」。
 *
 * 从 CSS 手里接过这件事，是因为「放不下的收进菜单」这个决定必须知道容器有多宽——
 * flex-shrink 只会把标签一路压到不可读，压不下时再横向溢出，两者都不产出「还有几个」这个数。
 * 布局规则收在这个纯函数里，组件只管量宽和渲染（规则可单测、不必挂 DOM）。
 *
 * 所有标签等宽，活跃标签不占额外便宜：「当前在编辑哪个文件」由 ViewerToolbar 的路径面包屑
 * （标签栏正下方、宽度是整个右栏、位置恒定）回答，标签只需回答「是哪一个」——accent 竖标 +
 * elevated 底已经说清。豁免活跃标签换不来信息，只换来切标签时整栏横向位移。
 */

/** 不拥挤时的标签宽度。 */
export const TAB_FULL = 180;
/** 中间省略保留的尾部字符数——`-12.png` 这类「序号 + 扩展名」的唯一辨识位。 */
export const TAIL_CHARS = 7;
/**
 * 压缩下限，由「还能认出是哪个文件」倒推，不是拍的整数：
 * 标签固定开销 39px（左内边距 11 + 图标 13 + gap 6 + 右内边距 8 + 右边框 1，全局 box-sizing
 * 是 border-box，边框吃在宽度里；关闭 ✕ 是 hover 时绝对定位覆盖上去的，不占位）
 * 加上中间省略至少要留的 TAIL_CHARS + 省略号 + 两个头字符共 10 个字符 ≈ 72px
 * （text-sm 在本仓库是 12px，SF Mono 约 7.2px/字符，见 tailwind.config.ts 的 fontSize）。
 * 中文名单字 12px 更宽，尾段会被标签的 overflow-hidden 裁掉一点——那是极窄栏下的兜底，不是常态。
 * 动了标签内部结构（把 ✕ 改回占位、换字号）或 TAIL_CHARS，就要回来重算这个数。
 */
export const TAB_MIN = 112;
/**
 * 右端「» N」溢出按钮的预留宽度：图标 12 + gap 2 + 最多三位数 22 + 左右呼吸 8，取整到 44。
 * 这笔钱花在最紧张的档位上（够半个名字预算），所以按内容算而不是照搬 44px 触摸目标。
 */
export const OVERFLOW_BTN_WIDTH = 44;

export type TabLayout = {
  /** 留在栏里的标签下标，有序。 */
  visible: number[];
  /** 收进溢出菜单的标签下标，有序。 */
  overflow: number[];
  /** 可见标签的宽度（所有标签等宽）。 */
  width: number;
};

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** activeIndex 越界（如无活跃标签时的 -1）时只是没有标签需要提进可见区，其余照算。 */
export function layoutTabs(containerWidth: number, count: number, activeIndex: number): TabLayout {
  const total = Math.max(0, containerWidth);
  if (count <= 0) return { visible: [], overflow: [], width: TAB_FULL };

  // 独苗标签撑满可用宽：它既没有邻居可让位，也没有东西可溢出，不必给按钮留位。
  if (count === 1) return { visible: [0], overflow: [], width: Math.min(total, TAB_FULL) };

  // 档一：一个都不用让。
  if (count * TAB_FULL <= total) {
    return { visible: range(count), overflow: [], width: TAB_FULL };
  }

  // 档二：互相让位就都塞得下——全可见，均分。
  // 不必钳位：下界由本档进入条件保证，上界由档一已失败（count * TAB_FULL > total）保证。
  if (count * TAB_MIN <= total) {
    return { visible: range(count), overflow: [], width: Math.floor(total / count) };
  }

  // 档三：压到下限仍放不下，右端留出溢出按钮，能放几个放几个。
  const avail = total - OVERFLOW_BTN_WIDTH;
  const slots = Math.floor(avail / TAB_MIN);
  const visible = range(count).slice(0, Math.max(1, slots));
  // 活跃标签永远在栏里：落在溢出区就挤掉可见区末位换它进来（下标更大，队列仍有序）。
  if (activeIndex >= 0 && activeIndex < count && !visible.includes(activeIndex)) {
    visible[visible.length - 1] = activeIndex;
  }
  const inBar = new Set(visible);
  return {
    visible,
    overflow: range(count).filter((i) => !inBar.has(i)),
    // 连一格下限都放不下（右栏被拖到极窄）时，唯一那格剩多少占多少；
    // 上界会真触发（avail=400 时两格各分 200），钳住——没有比不拥挤还宽的道理。
    width: slots < 1 ? Math.max(avail, 0) : Math.min(TAB_FULL, Math.floor(avail / slots)),
  };
}
