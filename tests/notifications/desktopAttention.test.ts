/**
 * S30·G51 找人阶梯第二级内核：应用不在前台时给新增待处理项弹系统通知、角标显示计数；前台则清角标不弹；
 * 边沿触发（存量不重弹）；点通知 focus 窗口 + 广播跳转。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopAttentionItem, ServerEventPayload } from '@shared/protocol';
import {
  setDesktopAttentionSink,
  setDesktopFocus,
  updateDesktopAttention,
  __resetDesktopAttentionForTest,
} from '../../electron/main/notifications/desktopAttention';

const item = (convId: string): DesktopAttentionItem => ({
  agentId: 'twin',
  convId,
  title: `对话 ${convId}`,
  body: '等你审批',
});

function harness() {
  const notified: Array<{ item: DesktopAttentionItem; onClick: () => void }> = [];
  const badges: number[] = [];
  const events: ServerEventPayload[] = [];
  setDesktopAttentionSink(
    {
      showNotification: (it, onClick) => notified.push({ item: it, onClick }),
      setBadge: (n) => badges.push(n),
    },
    (ev) => events.push(ev),
  );
  return { notified, badges, events };
}

beforeEach(() => __resetDesktopAttentionForTest());

describe('desktopAttention · 边沿触发弹通知 + 角标', () => {
  it('不在前台 + 新增项 → 逐条弹通知、角标=集合大小', () => {
    const h = harness();
    setDesktopFocus(false);
    updateDesktopAttention([item('a'), item('b')]);
    expect(h.notified.map((n) => n.item.convId)).toEqual(['a', 'b']);
    expect(h.badges.at(-1)).toBe(2);
  });

  it('存量不重弹：再来一次同集合只更角标、不再弹', () => {
    const h = harness();
    setDesktopFocus(false);
    updateDesktopAttention([item('a')]);
    updateDesktopAttention([item('a'), item('b')]); // a 是存量、b 新增
    expect(h.notified.map((n) => n.item.convId)).toEqual(['a', 'b']); // 只弹了 a 和后来的 b
    expect(h.badges.at(-1)).toBe(2);
  });

  it('在前台 → 角标清零、不弹（窗口内 L1 覆盖）', () => {
    const h = harness();
    setDesktopFocus(true);
    updateDesktopAttention([item('a'), item('b')]);
    expect(h.notified).toHaveLength(0);
    expect(h.badges.at(-1)).toBe(0);
  });

  it('转前台清角标、转后台显示当前计数（不补弹存量）', () => {
    const h = harness();
    setDesktopFocus(false);
    updateDesktopAttention([item('a'), item('b')]);
    setDesktopFocus(true);
    expect(h.badges.at(-1)).toBe(0);
    setDesktopFocus(false); // 转后台：显示存量计数，不补弹通知
    expect(h.badges.at(-1)).toBe(2);
    expect(h.notified).toHaveLength(2); // 仍是最初那两条，未因 blur 重弹
  });

  it('点通知 → 内核广播 desktop.openConversation（窗口 focus 归 index.ts 实现）', () => {
    const h = harness();
    setDesktopFocus(false);
    updateDesktopAttention([item('x')]);
    h.notified[0].onClick();
    expect(h.events).toContainEqual({ type: 'desktop.openConversation', agentId: 'twin', convId: 'x' });
  });

  it('集合清空 → 角标归零', () => {
    const h = harness();
    setDesktopFocus(false);
    updateDesktopAttention([item('a')]);
    updateDesktopAttention([]);
    expect(h.badges.at(-1)).toBe(0);
  });
});
