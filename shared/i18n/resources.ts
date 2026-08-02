/**
 * i18n 翻译资源聚合——主、渲染进程共用这一份。
 *
 * 资源 JSON 放在顶层 `locales/<lang>/<namespace>.json`（与 `shared/` 同层级），故主、渲染
 * 两端都能 import：渲染层经 react-i18next、主进程（第 4 期）经 getFixedT 复用。
 *
 * 新增 namespace：在 `locales/zh|en/` 各加一个同名 .json，再在下面 import + 登记 ns/resources。
 * 第 1 期只有 common（空），界面文案在第 2 期逐 namespace 抽入。
 */
import zhCommon from '../../locales/zh/common.json';
import enCommon from '../../locales/en/common.json';
import zhScheduledTask from '../../locales/zh/scheduledTask.json';
import enScheduledTask from '../../locales/en/scheduledTask.json';
import zhSettings from '../../locales/zh/settings.json';
import enSettings from '../../locales/en/settings.json';
import zhChat from '../../locales/zh/chat.json';
import enChat from '../../locales/en/chat.json';
import zhTaskboard from '../../locales/zh/taskboard.json';
import enTaskboard from '../../locales/en/taskboard.json';
import zhTable from '../../locales/zh/table.json';
import enTable from '../../locales/en/table.json';
import zhPages from '../../locales/zh/pages.json';
import enPages from '../../locales/en/pages.json';
import zhMemory from '../../locales/zh/memory.json';
import enMemory from '../../locales/en/memory.json';
import zhDeck from '../../locales/zh/deck.json';
import enDeck from '../../locales/en/deck.json';
import zhProposal from '../../locales/zh/proposal.json';
import enProposal from '../../locales/en/proposal.json';
import zhFiles from '../../locales/zh/files.json';
import enFiles from '../../locales/en/files.json';
import zhTask from '../../locales/zh/task.json';
import enTask from '../../locales/en/task.json';
import zhNotification from '../../locales/zh/notification.json';
import enNotification from '../../locales/en/notification.json';
import zhApp from '../../locales/zh/app.json';
import enApp from '../../locales/en/app.json';
import zhConversation from '../../locales/zh/conversation.json';
import enConversation from '../../locales/en/conversation.json';
import zhEditor from '../../locales/zh/editor.json';
import enEditor from '../../locales/en/editor.json';
import zhProfile from '../../locales/zh/profile.json';
import enProfile from '../../locales/en/profile.json';
import zhAnnot from '../../locales/zh/annot.json';
import enAnnot from '../../locales/en/annot.json';
import zhAside from '../../locales/zh/aside.json';
import enAside from '../../locales/en/aside.json';
import zhDebug from '../../locales/zh/debug.json';
import enDebug from '../../locales/en/debug.json';
import zhMain from '../../locales/zh/main.json';
import enMain from '../../locales/en/main.json';
import zhHome from '../../locales/zh/home.json';
import enHome from '../../locales/en/home.json';
import zhPdf from '../../locales/zh/pdf.json';
import enPdf from '../../locales/en/pdf.json';

export const ns = ['common', 'scheduledTask', 'settings', 'chat', 'taskboard', 'table', 'pages', 'memory', 'deck', 'proposal', 'files', 'task', 'notification', 'app', 'conversation', 'editor', 'profile', 'annot', 'aside', 'debug', 'main', 'home', 'pdf'] as const;
export const defaultNS = 'common';
/** 缺词回落中文——开发期护栏；发布门槛由"英文覆盖达标才开放 English"在产品侧把关（PRD）。 */
export const fallbackLng = 'zh';

/** 中英同构。 */
export const resources = {
  zh: { common: zhCommon, scheduledTask: zhScheduledTask, settings: zhSettings, chat: zhChat, taskboard: zhTaskboard, table: zhTable, pages: zhPages, memory: zhMemory, deck: zhDeck, proposal: zhProposal, files: zhFiles, task: zhTask, notification: zhNotification, app: zhApp, conversation: zhConversation, editor: zhEditor, profile: zhProfile, annot: zhAnnot, aside: zhAside, debug: zhDebug, main: zhMain, home: zhHome, pdf: zhPdf },
  en: { common: enCommon, scheduledTask: enScheduledTask, settings: enSettings, chat: enChat, taskboard: enTaskboard, table: enTable, pages: enPages, memory: enMemory, deck: enDeck, proposal: enProposal, files: enFiles, task: enTask, notification: enNotification, app: enApp, conversation: enConversation, editor: enEditor, profile: enProfile, annot: enAnnot, aside: enAside, debug: enDebug, main: enMain, home: enHome, pdf: enPdf },
};
