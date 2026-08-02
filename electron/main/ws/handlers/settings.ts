/**
 * settings.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 `settings.get/update` 两个 case 字节级一致——纯搬运。
 */
import type { RegistrySlice } from './types';
import { getSettings, updateSettings } from '../../projects/store';
import { debugLogger } from '../../debug/logger';

export const settingsHandlers = {
  'settings.get': async (req, { reply }) => {
    const settings = await getSettings();
    reply(req.reqId, { type: 'settings.state', settings });
  },
  'settings.update': async (req, { reply, broadcast }) => {
    const oldSettings = await getSettings();
    const settings = await updateSettings(req.settings);
    // debug：开关切换时同步生效
    if (oldSettings.developer?.debugLogging !== settings.developer?.debugLogging) {
      debugLogger.setEnabled(!!settings.developer?.debugLogging);
    }
    // 全局点睛：仅当本次 update 携带 desktopPresence 字段（即用户在改这个开关）时才动桌面层。
    // 用 req.settings（本次意图的 Partial）判定、用写入后的 settings 取值——不读跨 await 的
    // oldSettings 做判断（CLAUDE.md「await 后重检」；并发 update 交错时 oldSettings 会过期漏触发）。
    // setDesktopPresenceEnabled 幂等，setEnabled 顺序＝updateSettings 落盘顺序，最终状态必与盘一致。
    if (req.settings.desktopPresence !== undefined) {
      const { setDesktopPresenceEnabled } = await import('../../desktop');
      setDesktopPresenceEnabled(!!settings.desktopPresence?.enabled);
    }
    // 对话中阻止休眠：仅当本次 update 携带 keepAwake 字段时才调总开关。同 desktopPresence 判定口径——
    // 用 req.settings（本次意图）判定、用写入后的 settings 取值（避开跨 await 的过期判断）。
    if (req.settings.keepAwake !== undefined) {
      const { setEnabled: setKeepAwakeEnabled } = await import('../../keepAwake');
      setKeepAwakeEnabled(!!settings.keepAwake?.enabled);
    }
    // 预算改动即刻重评提醒信号（S15）：不然调低上限后要等下一次用量 flush 才升提醒。
    if (req.settings.budget !== undefined) {
      const { refreshBudgetSignals } = await import('../../budget/budget');
      void refreshBudgetSignals().catch(() => {});
    }
    reply(req.reqId, { type: 'settings.state', settings });
    broadcast({ type: 'settings.state', settings });
  },
} satisfies RegistrySlice;
