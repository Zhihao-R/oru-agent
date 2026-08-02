/**
 * 设置页"行级 hover 工具栏"统一样式。
 *
 * 默认 opacity-0（保留布局不跳）；行 hover 或子元素聚焦（键盘可达）时 100；
 * persistent=true 让按钮在中间态（editing / testing 中等）常驻显示，
 * 避免 spinner 跟按钮一起淡出造成"没反馈"错觉。
 *
 * 调用方必须给容纳行 `group` class。
 */
import { cn } from '@/lib/cn';

export function hoverToolsCls(persistent: boolean): string {
  return cn(
    'transition-opacity',
    persistent
      ? 'opacity-100'
      : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
  );
}
