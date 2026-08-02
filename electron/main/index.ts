import { app, BrowserWindow, Notification, dialog, shell, protocol } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startWsServer, stopWsServer, broadcast, clientCount } from './ws/server';
import { setRendererQueryDeps } from './agent/rendererQuery';
import { ensureDefaultAgent } from './agent/store/agents';
import { getProject, listProjects } from './projects/store';
import { setActiveProjectId } from './agent/activeProject';
import { setTasksGateway } from './agent/tasksGateway';
import { stopSkillsWatch } from './skills/watcher';
import {
  listTasksForConversation as tasksListForConv,
  markAnnounced as tasksMarkAnnounced,
  getLastProgress as tasksGetLastProgress,
  getQuestions as tasksGetQuestions,
} from './tasks/store';
import { wireTaskboardBroadcast } from './taskboard/wireBroadcast';
import { migrateLegacySessions, migrateToUserScopedLayout } from './migrate';
import { start as startTaskAnnouncer, stop as stopTaskAnnouncer } from './tasks/taskAnnouncer';
import { start as startAutoArchiver, stop as stopAutoArchiver } from './conversations/autoArchiver';
import { enqueueTaskCompletionAnnounce } from './ws/router';
import { registerAvatarProtocol } from './avatars/protocol';
import { registerCropProtocol } from './deck/cropProtocol';
import { registerToolImageProtocol } from './agent/agentTools/toolImageProtocol';
import { registerConvImageProtocol, resolveConvImageRequest } from './conversations/imageProtocol';
import { registerDocImageProtocol } from './fs/docImageProtocol';
import { registerDocPdfProtocol } from './fs/docPdfProtocol';
import { registerBoardImageProtocol } from './taskboard/boardImageProtocol';
import { registerStaticAgentTools } from './agent/agentTools';
import { closeAllBrowserSessions } from './browser/session';
import { registerBuiltinCapabilities } from './agent/capabilities';
import { registerDeckValidator } from './deck/deckValidator';
import { migrateLegacyApiKey } from './agent/migrateLegacyApiKey';
import { migrateZhipuPromptCacheFlag } from './agent/migrateZhipuPromptCacheFlag';
import { flushAll as flushAccessLog } from './memory/accessLog';
import { flushAsideStats } from './ws/aside/stats';
import { flushUsageLedger } from './usage/ledger';
import { stopSchedulerWatchdog } from './notifications/feeds';
import { start as startDream, stop as stopDream, maybeCatchUp } from './memory/dreamScheduler';
import { start as startTrashCleaner, stop as stopTrashCleaner } from './memory/trashCleaner';
import {
  startScheduledTasks,
  stopScheduledTasks,
} from './scheduledTasks/scheduler';
import { abortAllScheduledRuns } from './scheduledTasks/executor';
import { getSettings } from './projects/store';
import { debugLogger } from './debug/logger';
import { createBeforeQuitHandler } from './runtime/beforeQuit';
import { registerDebugIpc } from './debug/ipc';
import { registerWindowIpc, wireFullScreenSync } from './window/ipc';
import { setMainWindow, getMainWindow } from './window/mainWindowRef';
import { setDesktopFocus } from './notifications/desktopAttention';
import { shouldExternalize } from './window/navigationGuard';
import { createUncaughtGuard } from './runtime/uncaughtGuard';
// PoC 探针（一次性，验完即删）：native 全局监听多闸验证，仅在 ORU_POC_GLOBALHOOK=1 时启动。
import { startGlobalHookProbe, stopGlobalHookProbe } from './desktop/__poc_globalhook__';
// PoC 探针（一次性，验完即删）：透明承载窗（风险 3 键盘焦点 / 风险 6 全屏 Space），仅在 ORU_POC_OVERLAY=1 时启动。
import { startOverlayProbe, stopOverlayProbe } from './desktop/__poc_overlay__';
// 唤起对话（系统级在场）桌面常驻层：全局 ⌥ 触发 → 分流 → 整屏截图 → 独立浮层承载窗。
import { configureDesktopPresence, setDesktopPresenceEnabled, disposeDesktopPresence } from './desktop';
import { disposeKeepAwake } from './keepAwake';

// EPIPE（对端已关闭的管道写入）不弹错误框——为什么这样兜见 uncaughtGuard.ts 头注释。
// 进程终身监听，与主进程同生命周期，无对应清理。
process.on(
  'uncaughtException',
  createUncaughtGuard({
    warn: (message, err) => console.warn(message, err),
    showErrorBox: (title, content) => dialog.showErrorBox(title, content),
  }),
);

// 应用级单实例强制（S11 · G85 / channels.html#Lock）：一台机器只跑一份 Oru。抢锁失败＝已有实例
// 在跑——立即退出，不再连平台 / 建窗（防同凭证被拆到两条连接、防双开）。每平台的文件锁（心跳/PID
// 双判）保「每平台一条连接」，这里补上应用级的「只跑一份」硬保证。抢到锁的那份收到 second-instance
// （用户又点了图标 / 命令行再启一次）时把已有窗口前置，等价于「唤起已在运行的这份」。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// oru-avatar:// / oru-crop:// scheme 注册必须在 app.whenReady() 之前（module top level）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'oru-avatar',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: 'oru-crop',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: 'oru-toolimg',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: 'oru-conv-img',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: 'oru-doc-img',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: 'oru-board-img',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: 'oru-doc-pdf',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let wsPort = 0;

async function createMainWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#FAF9F7',
    show: false,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // webviewTag 让 renderer 内的 <webview> 元素可用（Deck 预览面板用）
      webviewTag: true,
      // 只关屏（灭屏，非整机休眠）后唤醒：若保持默认节流，renderer 的 timer/rAF 被降频，
      // 流式 delta 虽经 WS 事件不受节流影响，但唤醒对账等前台机制与画面刷新会迟滞。
      // 与隐藏浏览器窗口同款先例（session.ts:122）。代价见 sleep-wake-chat-recovery-plan 方案 A。
      backgroundThrottling: false,
      additionalArguments: [
        `--oru-ws-port=${wsPort}`,
        `--oru-deck-preview-preload=${join(__dirname, '../preload/deckPreview.cjs')}`,
        // HTML 文件预览 webview 复用同一份 deckPreview.cjs：它已自适应 plain 模式
        // （无 .slide 时跳过定尺/翻页），无需为只读看一眼维护第二份 preload
        `--oru-html-preview-preload=${join(__dirname, '../preload/deckPreview.cjs')}`,
      ],
    },
  });

  // 登记到 mainWindowRef，供 ws 层（aside 截图等）取用；closed 时成对清除
  setMainWindow(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    setMainWindow(null);
  });
  wireFullScreenSync(mainWindow);
  // 找人阶梯第二级（S30·G51）：主窗前台态是「弹不弹系统通知 / 角标设多少」的单一事实源。
  mainWindow.on('focus', () => setDesktopFocus(true));
  mainWindow.on('blur', () => setDesktopFocus(false));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 附件缩略图的「点击放大」走 window.open(oru-conv-img://…)：还原绝对路径交系统看图器，
    // 沙箱校验与协议 handler 同一份；没过校验的本 scheme URL 直接吞掉（openExternal 它
    // 只会弹「没有应用可打开」的系统框）。其余 URL 照旧外开浏览器。
    if (url.startsWith('oru-conv-img://')) {
      const convImg = resolveConvImageRequest(url);
      if (convImg) void shell.openPath(convImg.path);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 导航的唯一收口：任何漏加 target="_blank" 的外链点击会触发主文档整页 will-navigate，
  // 把 App 替换成外站——结构性兜底拦下、交系统浏览器，不依赖各渲染组件自觉补 target。
  const devOrigin = process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).origin
    : undefined;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (shouldExternalize(url, devOrigin)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  // 单实例兜底（G85）：抢锁失败时上面已 app.quit()；ready 仍可能在 quit 落定前触发，早退避免
  // 这一份继续 bootstrap（连平台 / 建窗）。承重保证在 requestSingleInstanceLock，这里只是二保险。
  if (!gotSingleInstanceLock) return;
  // 0. 注册 oru-avatar:// / oru-crop:// / oru-toolimg:// 协议 handler（必须在 ready 之后）
  registerAvatarProtocol();
  registerToolImageProtocol();
  registerCropProtocol();
  registerConvImageProtocol();
  // docImageProtocol 用 projectId 查项目根（URL 自带文档身份，去全局 activeDoc，§4.1）
  registerDocImageProtocol(async (projectId) => (await getProject(projectId)).path);
  // docPdfProtocol：PDF 查看器（自绘）的字节通路，同用 projectId 查项目根（PDF tech design §二）
  registerDocPdfProtocol(async (projectId) => (await getProject(projectId)).path);
  registerBoardImageProtocol();
  // 0a. 一次性归档老 sessions（按 projectId 分桶的旧数据）
  try {
    await migrateLegacySessions();
  } catch (e) {
    console.warn('[oru.migrate] failed:', e);
  }
  // 0b. 迁移到 user-scoped 布局（~/.oru/users/local-user/...）
  try {
    await migrateToUserScopedLayout();
  } catch (e) {
    console.warn('[oru.migrate userScoped] failed:', e);
  }
  // 0c. 老 manualApiKey → BackendProvider 迁移（多后端改造）
  // 必须在 WS server 启动之前完成，避免渲染端首次拉 settings 时看到未迁移状态
  try {
    await migrateLegacyApiKey();
  } catch (e) {
    console.warn('[oru.migrate apiKey] failed:', e);
  }
  // 0d. GLM 模型 supportsPromptCache 回灌（智谱 prompt cache 接入）
  // 同上时序约束——必须在 WS server 启动之前
  try {
    await migrateZhipuPromptCacheFlag();
  } catch (e) {
    console.warn('[oru.migrate zhipuPromptCacheFlag] failed:', e);
  }
  // 1. 初始化默认分身（首启时建家目录 + CLAUDE.md）
  // 主对话已取消：启动不再建/选任何对话，前端落到草稿态新对话界面（发首条消息才入库）。
  await ensureDefaultAgent();
  // 1a0. 家目录 CLAUDE.md 已换过的模板句存量迁移——对所有 agent 各跑一次（安全性见 store/home.ts）
  try {
    const { listAgents } = await import('./agent/store/agents');
    const { migratePersonaTemplateLines } = await import('./agent/store/home');
    for (const a of (await listAgents()).agents) {
      await migratePersonaTemplateLines(a.homePath);
    }
  } catch (e) {
    console.warn('[oru.migrate personaTemplateLines] failed:', e);
  }
  // 1aa. 初始化用户 profile（首启时从 OS 用户名兜底）
  try {
    const { ensureProfileExists } = await import('./identity/profile');
    const { getCurrentOwnerId } = await import('./identity/getCurrentOwnerId');
    await ensureProfileExists(getCurrentOwnerId());
  } catch (e) {
    console.warn('[oru.profile] bootstrap failed:', e);
  }
  // 1ab. 记忆库格式版本哨（S06·G128）：建立/校验 memory/format.json——备份还原按版本迁移的依据
  try {
    const { ensureMemoryFormatVersion } = await import('./memory/formatVersion');
    const { getCurrentOwnerId } = await import('./identity/getCurrentOwnerId');
    await ensureMemoryFormatVersion(getCurrentOwnerId());
  } catch (e) {
    console.warn('[oru.memory] format version bootstrap failed:', e);
  }
  // 1a. 注册全部静态 AgentTool 到 backend factory
  // factory 会在 getBackendFor(usage) 时按 usages 白名单过滤注入工具
  registerStaticAgentTools();
  // 1a-cap. 声明式能力供给：登记内置能力 + 注册能力带的 AgentTool（联网首个落地）。
  // 与 registerStaticAgentTools 平行——能力声明一次即覆盖受众里的所有 agent。
  registerBuiltinCapabilities();
  // 1a-deck. 把 deck 校验器 stub 换成真实现（任务 7）——一上线，deck 收尾回路从"零额外轮次"
  // 变为"真会回喂客观硬伤"。与上面两个 register 平行，启动期一次性接入。
  registerDeckValidator();
  // 1a-self. 自我认知知识库（子系统 A）：启动期一次性把 resources/self-knowledge 读进内存。
  // 只读、不解包、毫秒级。坏条目不该 brick 启动——失败则 warn 并降级（B 的锚点取不到领域线索时返回空段）。
  try {
    const { initSelfKnowledge } = await import('./selfKnowledge/registry');
    initSelfKnowledge();
  } catch (e) {
    console.warn('[oru.selfKnowledge] init failed:', e);
  }
  // 1a-bis. v0.5：启动 enabled 的外部 MCP server，把它们暴露的工具反射进同一 factory
  // 不阻塞启动——单个 MCP server 启动慢/失败不影响 Oru 主路径
  void (async () => {
    try {
      const { initMcpRegistry } = await import('./mcp/registry');
      const r = await initMcpRegistry();
      console.log(`[oru.mcp] external servers: ${r.started} started, ${r.failed} failed`);
    } catch (e) {
      console.warn('[oru.mcp] init failed:', e);
    }
  })();
  // 1a-ter. Skill 模块（v1）：初始化 plugin / skill 注册表。
  // 纯本地扫盘，毫秒级——可 await；坏 manifest 单条跳过不阻塞整体启动。
  // 顺序：先 ensureBuiltinSkills 解包内置 → 再 init plugins / skills
  try {
    const { ensureBuiltinSkills } = await import('./skills/ensureBuiltin');
    const r = await ensureBuiltinSkills();
    if (r.copied > 0) console.log(`[oru.builtinSkills] copied ${r.copied} skills (${r.skipped} skipped)`);
  } catch (e) {
    console.warn('[oru.builtinSkills] failed:', e);
  }
  try {
    const { initPluginRegistry } = await import('./plugins/registry');
    const p = await initPluginRegistry();
    console.log(`[oru.plugins] loaded ${p.loaded} plugins (${p.failed} failed)`);
  } catch (e) {
    console.warn('[oru.plugins] init failed:', e);
  }
  try {
    const { initSkillRegistry } = await import('./skills/registry');
    const s = await initSkillRegistry();
    console.log(`[oru.skills] loaded ${s.loaded} skills (${s.failed} failed)`);
    // 启动扫盘后布 watcher：外部拖入/删除 skill 文件夹即时热注册（stop 接在 before-quit）
    const { startSkillsWatch } = await import('./skills/watcher');
    startSkillsWatch(broadcast);
  } catch (e) {
    console.warn('[oru.skills] init failed:', e);
  }
  // 1b. debug 模块：根据持久化设置初始化开关；注册 IPC handlers
  try {
    const initialSettings = await getSettings();
    debugLogger.setEnabled(!!initialSettings.developer?.debugLogging);
  } catch (e) {
    console.warn('[oru.debug] init setEnabled failed:', e);
  }
  // 调试日志只保留最近 7 天：启动扫一次；应用长开时由 beginRound 换日再扫（logger.ts）
  {
    const { sweepExpiredDebugDays } = await import('./debug/retention');
    const { debugDir } = await import('./runtime/paths');
    const { getCurrentOwnerId } = await import('./identity/getCurrentOwnerId');
    void sweepExpiredDebugDays(debugDir(getCurrentOwnerId()));
  }
  registerDebugIpc();
  registerWindowIpc();
  // 2. 同步当前 active project 到 hooks 闭包（启动期 hint 注入用）
  const { activeId } = await listProjects();
  setActiveProjectId(activeId);
  // 2b. 注入 agent/* 访问 tasks/store 的单一闸门（解 agent ↔ tasks 循环依赖）——
  // hooks 的运行时上下文与 checkTasks 现查工具都从这里取，一次注入覆盖全部消费方。
  setTasksGateway({
    listTasksForConversation: tasksListForConv,
    markAnnounced: tasksMarkAnnounced,
    getLastProgress: tasksGetLastProgress,
    getQuestions: tasksGetQuestions,
  });
  // 2c. taskboard store 事件接到 broadcast / abortConversation
  wireTaskboardBroadcast();
  // 2d. AI 出口闸门的依赖注入（rendererQuery 信箱）
  setRendererQueryDeps({ broadcast, hasClients: () => clientCount() > 0 });
  // 2e. 系统信号（S14 · G106/G127）：注入全局广播器 + 把写盘失败接进信号源。
  // 渠道/凭据在平台接线处接、损坏在 noteCorruption 接、调度停摆看门狗随调度器起。
  {
    const { setSystemSignalBroadcaster } = await import('./notifications/systemSignals');
    const { setWriteFailureReporter } = await import('./fs/safeWrite');
    const { feedWriteFailure, feedMilestoneArchived, feedConflictRecoverable } = await import('./notifications/feeds');
    setSystemSignalBroadcaster(broadcast);
    setWriteFailureReporter(feedWriteFailure);
    // 文件历史里程碑到期归档（S28 · G92）：不静默删，发系统信号提示可找回。
    const { setArchivalListener } = await import('./fs/fileHistory');
    setArchivalListener((_fileKey, archived) => feedMilestoneArchived(archived.length));
    // 预算两级线（S15）：账本每次 flush 后重评软/硬线，把 budget-* 信号同步进通知中心（事前警戒）。
    const { setLedgerFlushObserver } = await import('./usage/ledger');
    const { refreshBudgetSignals } = await import('./budget/budget');
    setLedgerFlushObserver((ownerId) => void refreshBudgetSignals(ownerId).catch(() => {}));
    // 启动时扫一次记忆回收站：旧撤销缺陷（2026-07-27 前档案卡撤销＝删整份档案）误删的档案
    // 若还在就升信号提示找回（PRD 决策一）；找回 / 30 天到期清理后扫不到即不再提示。
    const { scanTrashedProfiles } = await import('./memory/trash');
    const { feedTrashedProfiles } = await import('./notifications/feeds');
    const { getCurrentOwnerId } = await import('./identity/getCurrentOwnerId');
    void scanTrashedProfiles(getCurrentOwnerId()).then(feedTrashedProfiles).catch(() => {});
    // 找人阶梯第二级（S30·G51）：注入系统通知 / 程序坞角标 / 窗口 focus 的真 Electron 出口。
    const { setDesktopAttentionSink } = await import('./notifications/desktopAttention');
    setDesktopAttentionSink(
      {
        showNotification: (item, onClick) => {
          if (!Notification.isSupported()) return;
          const n = new Notification({ title: item.title, body: item.body });
          n.on('click', () => {
            const w = getMainWindow(); // 点通知先把主窗带到前台，再交内核路由到对应对话
            if (w) {
              if (w.isMinimized()) w.restore();
              w.show();
              w.focus();
            }
            onClick();
          });
          n.show();
        },
        setBadge: (count) => app.setBadgeCount(count),
      },
      broadcast,
    );
    // 冲突卡未决期崩溃重启（S29·G90④）：扫上次残留的未决冲突文件，发一次「可找回」信号（双方版本已在历史里，
    // 与弃写降级同款）。冲突中间态随渲染端已丢、不重建卡；扫完即清持久档（早于 ws 起来，不会误判本进程新登记）。
    try {
      const { scanOpenConflictsOnBoot } = await import('./fs/conflictRegistry');
      const residual = await scanOpenConflictsOnBoot();
      if (residual.length > 0) feedConflictRecoverable(residual.length);
    } catch (e) {
      console.warn('[oru.conflict] 未决冲突崩溃扫描失败（本次不提示可找回）:', e);
    }
  }
  // 2f. Steering 崩溃盘记恢复：扫上次进程残留的未消费「将生效」进待交还区（对话打开时预填草稿交还）。
  // 必须在 ws server 起来之前扫完——扫描只认「进程启动时已存在」的盘记，晚扫会把本进程新入队的误当残留。
  try {
    const { scanSteeringBackupsOnBoot } = await import('./agent/steeringBackup');
    await scanSteeringBackupsOnBoot();
  } catch (e) {
    // 兜底极端意外（scan 内部已 per-conv 容错，正常不会抛到这）。注意「下次启动再试」不成立：
    // 未进待交还区的 pending 残留会被本进程同 conv 下次忙时入队的全量镜像 save 整文件覆盖——
    // 整体扫描失败意味着残留可能静默丢失，只能如实告警。
    console.warn('[oru.steering] 崩溃盘记扫描整体失败（残留本次不交还，且可能被后续入队覆盖）:', e);
  }
  // 2f-2. 流式实时落盘崩溃恢复（S03 / G22）：扫上次进程残留的流式草稿，合成 crashed 半截补进历史。
  // 同样必须在 ws server 起来之前扫完——晚扫会把本进程新回合正在写的活草稿误当崩溃残留。
  try {
    const { scanTurnInflightOnBoot } = await import('./agent/turnInflight');
    await scanTurnInflightOnBoot();
  } catch (e) {
    // scan 内部已 per-conv 容错；整体失败只告警，残留草稿保留待下次启动再补。
    console.warn('[oru.turnInflight] 流式草稿扫描整体失败（本次不补回，草稿保留）:', e);
  }
  // 3. 启 WS server
  wsPort = await startWsServer();
  console.log(`[oru] ws server listening on 127.0.0.1:${wsPort}`);
  // 3a. 整机睡眠唤醒恢复（sleep-wake-chat-recovery）：主进程监听 powerMonitor 'wake'，唤醒时
  // 主动把在途对话推给渲染层对账。需在 ws server 就绪后注册（broadcast 已可用）。
  await import('./ws/wakeRecovery').then(({ startWakeRecovery }) =>
    startWakeRecovery(broadcast),
  );
  // 4. 启后台完成播报（S09·G69）：task 终态去抖后走统一队列——空闲起播报轮、忙时排队回合末合并搭车。
  startTaskAnnouncer((agentId, conversationId) =>
    enqueueTaskCompletionAnnounce(agentId, conversationId, broadcast),
  );
  // 4a. 后台命令完成触发（S19·G15）：后台 bash 退出/停滞时把「已结束」作为 task-completed 触发送进统一队列。
  {
    const { setBackgroundCompletionNotifier } = await import('./proposals/executeBashProposal');
    const { enqueueBackgroundCompletionAnnounce } = await import(
      './ws/handlers/backgroundCompletionAnnounce'
    );
    setBackgroundCompletionNotifier((rec) => {
      void enqueueBackgroundCompletionAnnounce(rec, broadcast);
    });
  }
  // 4b. 崩溃恢复·启动扫描（S19·G18）：认出上次崩溃遗留的悬空 subagent 任务与后台命令，判为
  // 「因崩溃中断」（不自动重跑）。必须在 ws server + 完成触发器就绪后执行。
  //
  // 【委派工具收敛 2026-08-02 崩溃语义变更】异步 subagent 任务**不再在此主动合成『因崩溃中断』触发**：
  // Oru 整体崩溃重启后主 agent 与 subagent 一起死，崩溃对主 agent 是无信息量事件——不该包装成一条
  // 「需要它决断的新消息」，也避免诱导重启后自作主张重跑。recovered task 落 `interrupted` 终态、
  // 保持未播报，之后由 `buildUnannouncedTaskHint` 在用户回到崩溃对话继续说话时随上下文注入（§7）。
  // scanDanglingTasksOnBoot 仍要跑：它负责把遗留任务落 `interrupted` 终态（不 auto retry 铁律）。
  // 后台命令（cmds）走独立语义，不属本 PRD 范围，维持原「主动合成触发」。
  {
    const { scanDanglingTasksOnBoot } = await import('./tasks/bootScan');
    const { scanBackgroundOnBoot } = await import('./proposals/backgroundCommandStore');
    const { getCurrentOwnerId } = await import('./identity/getCurrentOwnerId');
    const { enqueueBackgroundCompletionAnnounce: announceBg } = await import(
      './ws/handlers/backgroundCompletionAnnounce'
    );
    try {
      await scanDanglingTasksOnBoot();
      const cmds = await scanBackgroundOnBoot(getCurrentOwnerId());
      for (const c of cmds) void announceBg(c, broadcast);
    } catch (e) {
      console.warn('[oru.tasks] 崩溃恢复启动扫描失败（悬空任务本次不合成触发）:', e);
    }
    // Loop 跨重启（S22·G61）：扫描残留运行态快照，每个半截循环落一张 interrupted 卡交用户续跑/作罢。
    try {
      const { reconcileLoopRunsOnBoot } = await import('./loop/bootReconcile');
      await reconcileLoopRunsOnBoot(broadcast);
    } catch (e) {
      console.warn('[oru.loop] Loop 运行态启动对账失败（半截循环本次不呈现）:', e);
    }
  }
  // 5. 启 dream 复盘 scheduler（每天 03:00 + 20 条 episode 阈值），并补跑半夜睡/关机错过的窗口
  startDream();
  void maybeCatchUp('launch').catch(() => undefined);
  // 5''. 启回收站清除 · 独立每日定时（S35·G36）：脱离 dream，开机补扫 + 每天 04:00 清满 30 天的回收站条目
  startTrashCleaner();
  // 5a. 启自动归档（对话归档）：定时把久不互动的对话收进「已归档」，命中后广播 conv.state 刷新桌面列表
  {
    const { pushConvState } = await import('./ws/handlers/convState');
    startAutoArchiver((agentId) => void pushConvState(agentId, null, null, broadcast));
  }
  // 5a'. 启定时任务调度器（S18 后台执行路径）：tick 轮询 nextRunAt，到点一次落盘「推进游标 ＋ 记投递账」
  // 后 fire-and-forget 交后台执行体（executor.spawnScheduledRun）；结算/结果落盘单点在执行体，调度段不占回合。
  {
    const schedStore = await import('./scheduledTasks/store');
    const { configureExecutor, makeScheduledExecutorDeps, spawnScheduledRun } = await import(
      './scheduledTasks/executor'
    );
    const { setScheduledTaskBroadcaster, emitScheduledTaskState } = await import(
      './scheduledTasks/notify'
    );
    // 广播走 rpc 单一 helper（带 groups·M1）；notify 只管「构造→广播」不碰聚合层。
    const { buildScheduledStatePayload } = await import('./scheduledTasks/rpc');
    setScheduledTaskBroadcaster((payload) => broadcast(payload));
    // 执行体 deps：store 原语 + 承载对话解析 + 真 runConversation 适配器（onStateChanged 广播全端状态）
    const execDeps = makeScheduledExecutorDeps(broadcast);
    execDeps.onStateChanged = () => emitScheduledTaskState(() => buildScheduledStatePayload());
    configureExecutor(execDeps);
    startScheduledTasks({
      now: () => Date.now(),
      list: schedStore.listScheduledTasks,
      get: schedStore.getScheduledTask,
      patch: schedStore.patchScheduledTask,
      recordFire: schedStore.recordFire,
      reconcileFires: schedStore.reconcileFires,
      spawn: spawnScheduledRun,
      onStateChanged: () => emitScheduledTaskState(() => buildScheduledStatePayload()),
    });
    // 调度停摆看门狗（S14 · G106）：轮询心跳，timer 死掉 / tick 卡死时升系统信号
    const { getSchedulerHealth } = await import('./scheduledTasks/scheduler');
    const { startSchedulerWatchdog } = await import('./notifications/feeds');
    startSchedulerWatchdog(getSchedulerHealth);
  }
  // 5a''. 后台命令登记/终态变化 → 增量广播（对话内后台命令行的活状态；S19 登记表只读投影）
  {
    const { setBackgroundCommandChangeListener } = await import('./proposals/backgroundCommandStore');
    const { toBgCommandView } = await import('./ws/handlers/bgCommands');
    setBackgroundCommandChangeListener((rec) =>
      broadcast({ type: 'bgCommand.changed', command: toBgCommandView(rec) }),
    );
  }
  // 5b. 三方平台接入：据设置把启用且已配置的平台连上长连接（单实例锁；状态推渲染进程）
  try {
    const { platformManager } = await import('./platform/platformManager');
    const { pushConvState } = await import('./ws/handlers/convState');
    const { feedPlatformStatus } = await import('./notifications/feeds');
    platformManager.onStatus((s) => {
      broadcast({ type: 'platform.status', status: s });
      feedPlatformStatus(s); // 渠道掉线 / 凭据过期 → 系统信号（S14 · G106）
    });
    // 平台会话变更（§4.5）：对称 onStatus，把「某 agent 会话变了」广播成 conv.state，桌面列表实时同步
    // 复用 pushConvState（无 reply 语境 → reply/reqId 传 null），不另起冗余广播函数
    platformManager.onConvChanged((agentId) => void pushConvState(agentId, null, null, broadcast));
    // 飞书用户授权状态机（S5 · device flow）：pending/authorized/denied/expired 迁移实时推设置页
    const { userAuthFlow } = await import('./platform/feishuUserAuth');
    userAuthFlow.subscribe((state) => broadcast({ type: 'platform.feishuUserAuth', state }));
    // 平台 turn 的 chat.*（入站 user 消息 / chat.started / 流式 / done）经此推达桌面，
    // 让「同一对话被飞书驱动时桌面也实时长出来」——修复「桌面插话后飞书新消息在桌面消失」。
    platformManager.setBroadcaster(broadcast);
    await platformManager.reconcile();
  } catch (e) {
    console.warn('[oru.platform] reconcile failed:', e);
  }
  await createMainWindow();

  // PoC：native 全局监听探针（仅 ORU_POC_GLOBALHOOK=1）。stop 接在 before-quit 的 stops 里，注册/注销成对。
  if (process.env.ORU_POC_GLOBALHOOK === '1') {
    try {
      startGlobalHookProbe();
    } catch (e) {
      console.warn('[poc.hook] start failed:', e);
    }
  }
  if (process.env.ORU_POC_OVERLAY === '1') {
    try {
      startOverlayProbe();
    } catch (e) {
      console.warn('[poc.overlay] start failed:', e);
    }
  }

  // 全局点睛（系统级唤起对话）：配置一次 preload/wsPort，再按设置项「全局点睛」决定是否拉起。
  // 默认开（PRD §5）——首启即申请系统权限；用户可在设置关闭（settings.update 时实时 init/dispose）。
  try {
    configureDesktopPresence({
      preloadPath: join(__dirname, '../preload/index.cjs'),
      wsPort,
    });
    const settings = await getSettings();
    setDesktopPresenceEnabled(settings.desktopPresence?.enabled ?? true);
    const { setEnabled: setKeepAwakeEnabled } = await import('./keepAwake');
    setKeepAwakeEnabled(!!settings.keepAwake?.enabled);
  } catch (e) {
    console.warn('[desktop] presence 启动失败:', e);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopTaskAnnouncer();
    stopScheduledTasks();
    abortAllScheduledRuns(); // 退出中止后台执行体（不结算，账留给开机对账收编）
    stopAutoArchiver();
    stopDream();
    stopWsServer();
    app.quit();
  }
});

app.on(
  'before-quit',
  createBeforeQuitHandler({
    stops: [
      stopTaskAnnouncer,
      stopScheduledTasks,
      abortAllScheduledRuns,
      stopSchedulerWatchdog,
      stopAutoArchiver,
      stopDream,
      stopTrashCleaner,
      stopWsServer,
      stopSkillsWatch,
      stopGlobalHookProbe,
      stopOverlayProbe,
      disposeDesktopPresence,
      disposeKeepAwake,
      closeAllBrowserSessions,
      () => void import('./ws/wakeRecovery').then((m) => m.disposeWakeRecovery()),
    ],
    flush: async () => {
      // 三方平台：断所有长连接、释放单实例锁、清心跳（成对清理）
      try {
        const { platformManager } = await import('./platform/platformManager');
        await platformManager.stop();
      } catch {
        /* ignore */
      }
      // deck 行内编辑 30s 防抖窗口内的版本——退出前强制落，否则丢编辑
      try {
        const { flushAllPending } = await import('./deck/commitScheduler');
        await flushAllPending();
      } catch {
        /* ignore */
      }
      // flush 记忆访问日志，避免最近的 last-referenced 丢失
      await flushAccessLog().catch(() => {});
      // flush 随手评点计数（与 accessLog 同口径的批量窗口）
      await flushAsideStats().catch(() => {});
      // flush 用量账本（同批量窗口口径；未落的最近增量退出前强制落）
      await flushUsageLedger().catch(() => {});
      // 关闭所有外部 MCP server 子进程，避免孤儿化
      try {
        const { shutdownMcpRegistry } = await import('./mcp/registry');
        await shutdownMcpRegistry();
      } catch {
        /* ignore */
      }
      // 等 debug writer drain 完，避免丢最后几条 record
      await debugLogger.flushForTest().catch(() => {});
    },
    quit: () => app.quit(),
  }),
);
