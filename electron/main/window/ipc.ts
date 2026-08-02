/**
 * 窗口控制 IPC handlers
 *
 * Deck 模块的"OS 全屏"态需要调 BrowserWindow.setFullScreen——renderer 通过
 * window.oruWindow.setFullScreen(bool) 调过来。退出全屏（用户按 Cmd+Ctrl+F 或 macOS
 * 顶部菜单 view → exit fullscreen）时通过 BrowserWindow 'leave-full-screen' 事件
 * 把状态反推回 renderer，避免 deckStore.chromeState 跟实际窗口状态漂移。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { buildBackupZip } from '../backup/exportBackup';
import { restoreBackup, InvalidBackupError } from '../backup/importBackup';

/** 导出/还原结果：ok 或（取消 / 出错） */
type BackupResult =
  | { ok: true; path: string }
  | { ok: false; canceled?: boolean; error?: string };

export function registerWindowIpc(): void {
  // 前置 removeHandler：开发模式 HMR 重 evaluate 模块时 ipcMain.handle 重复注册
  // 会抛 'Attempted to register a second handler'——一律先清后注
  ipcMain.removeHandler('window:setFullScreen');
  ipcMain.handle('window:setFullScreen', (event, value: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isFullScreen() === value) return;
    win.setFullScreen(value);
  });

  // 原生文件夹选择器：添加项目时取代手填绝对路径。取消或空选返回 null。
  ipcMain.removeHandler('dialog:pickDirectory');
  ipcMain.handle('dialog:pickDirectory', async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  // 整体导出（S07·G124）：选保存位置 → 打包写盘。includeKeys 由 UI 勾选（PM 拍板）。
  ipcMain.removeHandler('backup:export');
  ipcMain.handle('backup:export', async (event, includeKeys: boolean): Promise<BackupResult> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const stamp = new Date().toISOString().slice(0, 10);
    const options: Electron.SaveDialogOptions = {
      defaultPath: `oru-backup-${stamp}.zip`,
      filters: [{ name: 'Oru 备份包', extensions: ['zip'] }],
    };
    const picked = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    try {
      const buf = await buildBackupZip({ includeKeys: !!includeKeys });
      await fs.writeFile(picked.filePath, buf);
      return { ok: true, path: picked.filePath };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 换机还原（S07·G125）：选备份包 → 破坏性二次确认 → 还原（已自动兜底）→ 重启应用。
  ipcMain.removeHandler('backup:restore');
  ipcMain.handle('backup:restore', async (event): Promise<BackupResult> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Oru 备份包', extensions: ['zip'] }] })
      : await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Oru 备份包', extensions: ['zip'] }] });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };

    // 破坏性操作的原生二次确认——覆盖当前全部数据前必须让用户明确知情
    const confirmOpts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['取消', '还原并重启'],
      defaultId: 0,
      cancelId: 0,
      message: '还原将覆盖当前这台设备上的全部 Oru 数据',
      detail: '当前数据会先自动兜底备份一份（可找回）。还原完成后应用会重启。确定继续吗？',
    };
    const confirm = win
      ? await dialog.showMessageBox(win, confirmOpts)
      : await dialog.showMessageBox(confirmOpts);
    if (confirm.response !== 1) return { ok: false, canceled: true };

    try {
      const { safetyBackupPath } = await restoreBackup(picked.filePaths[0]);
      // 让 invoke 回执先返回，再重启（缓存按旧数据构建，必须整进程重来）
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 300);
      return { ok: true, path: safetyBackupPath };
    } catch (e) {
      const msg = e instanceof InvalidBackupError ? e.message : e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  });
}

/**
 * 给主窗口接 leave-full-screen 事件——OS 级退出全屏时通知 renderer 同步 deckStore。
 * 在 createMainWindow 之后调用。
 */
export function wireFullScreenSync(win: BrowserWindow): void {
  win.on('leave-full-screen', () => {
    win.webContents.send('window:fullScreenChanged', false);
  });
  win.on('enter-full-screen', () => {
    win.webContents.send('window:fullScreenChanged', true);
  });
  // renderer 重载（dev 热重载 / 崩溃恢复）只能收到之后的事件：每次加载完把当前值推一遍，
  // 否则全屏中重载的页面会拿默认 false（顶栏会错误地给红绿灯留位）。
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('window:fullScreenChanged', win.isFullScreen());
  });
}
