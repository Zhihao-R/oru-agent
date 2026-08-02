/**
 * 窗口内/全屏分流裁决（技术设计 §8「必须钉死」/ §12 风险 10）——纯函数逐项验证。
 * 承重：命中 Oru 自己的窗才走窗内老路，命中别 app / 桌面空白都走全屏，绝不靠 bounds 矩形。
 */
import { describe, expect, it } from 'vitest';
import { classifyClick } from '../../electron/main/desktop/trigger';

const ORU_PIDS = new Set([4242]);

describe('classifyClick', () => {
  it('命中 Oru 自己的窗（owner.pid ∈ oruPids）→ 窗内老路', () => {
    expect(classifyClick({ pid: 4242, app: 'Oru' }, ORU_PIDS)).toBe('in-window');
  });

  it('命中别 app（owner.pid ∉ oruPids）→ 全屏', () => {
    expect(classifyClick({ pid: 9001, app: 'Figma' }, ORU_PIDS)).toBe('screen');
  });

  it('点在桌面空白 / 无窗（owner=null）→ 全屏（桌面也要有反应，PRD 六）', () => {
    expect(classifyClick(null, ORU_PIDS)).toBe('screen');
  });

  it('Oru 被别 app 遮挡：点落在遮挡的别 app 窗 → 全屏（不因坐标在主窗框内误判窗内）', () => {
    // 主窗 pid=4242 在 oruPids，但该点最上层窗是 Figma(9001)——hit-test 已给出真归属，分流照判全屏
    expect(classifyClick({ pid: 9001, app: 'Figma' }, ORU_PIDS)).toBe('screen');
  });
});
