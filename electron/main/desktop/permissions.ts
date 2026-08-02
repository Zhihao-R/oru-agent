/**
 * 唤起对话的两道系统权限（技术设计 §9 / PRD §5）——纯能力工具：状态查询 + 跳系统设置面板。
 * 纯能力（查状态 + 跳系统设置面板）；UI 引导在 设置→偏好→界面 经 ws desktopPresence.* 复用它。
 *
 * macOS 两道权限，都要手动去系统设置勾、常需重启 App：
 * - 屏幕录制（让它看屏）：有 `getMediaAccessStatus('screen')` 可查；不能程序内申请（只能引导去设置）。
 * - 输入监控（让它知道你何时按 ⌥）：uiohook 的全局监听需要它。Electron 无对应状态 API——
 *   只能引导去设置面板，无法可靠回读是否已授（已授后须重启 App 才生效，§12 必带的坑）。
 */
import { shell, systemPreferences } from 'electron';

/** 屏幕录制权限状态（仅 macOS 有意义；其它平台一律按 'granted' 放行不挡） */
export function screenRecordingStatus(): ReturnType<typeof systemPreferences.getMediaAccessStatus> {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
}

export function hasScreenRecording(): boolean {
  return screenRecordingStatus() === 'granted';
}

/** 跳「屏幕录制」设置面板——引导用户手动勾选（程序内无法申请屏幕录制） */
export function openScreenRecordingSettings(): void {
  void shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  );
}

/** 跳「输入监控」设置面板——uiohook 全局监听所需；授权后须重启 App 才生效（§12 的坑） */
export function openInputMonitoringSettings(): void {
  void shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  );
}
