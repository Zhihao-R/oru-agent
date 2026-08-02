/**
 * settings handler keepAwake 分支（技术设计 §4.3 / §8）：update 携带 keepAwake 时才调 setEnabled 总开关，
 * 用写入后的 settings 取值（不读跨 await 的过期 oldSettings 判断）。
 *
 * 仿 desktopPresence 既有判定口径。锁的目标问题：用户拨开关 → 主进程 keepAwake 总开关同步换向。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { settingsHandlers } from '../../electron/main/ws/handlers/settings';

// mock store：getSettings 返回当前 settings、updateSettings 合并并回写（跟真实 store 同口径）
const keepAwake = vi.hoisted(() => ({ setEnabled: vi.fn() }));
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../../electron/main/debug/logger', () => ({ debugLogger: { setEnabled: vi.fn() } }));
vi.mock('../../electron/main/keepAwake', () => ({
  setEnabled: keepAwake.setEnabled,
}));
vi.mock('../../electron/main/desktop', () => ({ setDesktopPresenceEnabled: vi.fn() }));
vi.mock('../../electron/main/budget/budget', () => ({ refreshBudgetSignals: vi.fn() }));

import { getSettings, updateSettings } from '../../electron/main/projects/store';
import { vi as _vi } from 'vitest';

let settings: { keepAwake?: { enabled: boolean } };

beforeEach(() => {
  keepAwake.setEnabled.mockClear();
  _vi.mocked(getSettings).mockImplementation(async () => settings as never);
  _vi.mocked(updateSettings).mockImplementation(async (patch: Partial<typeof settings>) => {
    settings = { ...(patch as typeof settings) };
    return settings as never;
  });
});

function makeReply() {
  return { reply: vi.fn(), broadcast: vi.fn() };
}

describe('settings.update keepAwake 分支', () => {
  it('update 携带 keepAwake → 调 setEnabled（用写入后的值）', async () => {
    const ctx = makeReply();
    // 老数据无 keepAwake 字段，本次意图改成开
    settings = { colorScheme: 'sage' } as never;
    const req = { reqId: 'r1', settings: { keepAwake: { enabled: true } } };
    await settingsHandlers['settings.update'](req as never, ctx as never);
    expect(keepAwake.setEnabled).toHaveBeenCalledTimes(1);
    expect(keepAwake.setEnabled).toHaveBeenCalledWith(true);
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('update 未携带 keepAwake → 不调 setEnabled（只在用户在改这个开关时才动）', async () => {
    settings = { keepAwake: { enabled: true } } as never;
    const req = { reqId: 'r2', settings: { theme: 'dark' } };
    await settingsHandlers['settings.update'](req as never, makeReply() as never);
    expect(keepAwake.setEnabled).not.toHaveBeenCalled();
  });
});
