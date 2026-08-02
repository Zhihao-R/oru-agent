/**
 * 随手评点（aside）点击的分发点——极薄的注册/分发模块。
 *
 * deck 翻译（PreviewPane）与主窗口解析（事件接管 hook）都打到这里，
 * 浮层（AsideOverlay）注册唯一 handler。刻意单 handler 而非事件总线：
 * 同屏只有一个浮层，多订阅是为假想未来加层。
 */
import type { AsideReferent } from '@shared/types';

export type AsideClick = {
  referent: AsideReferent;
  /**
   * 截图（已归一为逻辑像素的 PNG base64，不带 data: 前缀）+ 点击在截图坐标系内的位置
   * （浮层画标记点用）；截图失败/超时则缺省——无图降级，浮层照常。
   */
  screenshot?: { base64: string; x: number; y: number };
  /** 点击位置（主窗口视口坐标）——浮层定位用 */
  position: { x: number; y: number };
};

let handler: ((click: AsideClick) => void) | null = null;

/** 注册唯一 handler；传 null 注销（浮层卸载时） */
export function setAsideClickHandler(h: ((click: AsideClick) => void) | null): void {
  handler = h;
}

/** 分发一次 ⌥点；没注册 handler 时丢弃（浮层尚未实装的开发期） */
export function dispatchAsideClick(click: AsideClick): void {
  if (!handler) {
    console.debug('[aside] 点击被丢弃——浮层 handler 未注册：', click.referent.type);
    return;
  }
  handler(click);
}
