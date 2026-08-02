/**
 * 随手评点的场所感（二期 §4）——区域 id 闭集 + 软件自述 + 锚点契约，同文件维护：
 * UI 大改时这三样一起更新，散开必漂移。
 *
 * 两层缺一不可：
 * - 通识层 ORU_SOFTWARE_MAP（软件功能区地图）：拼进短评与短聊的 system prompt——
 *   Oru 看得见内容，却得认识自己的软件，才不会把自己的记忆笔记当用户的笔记来评；
 * - 定位层 data-aside-region 锚点：resolver 读 closest 得到区域 id，随指代卡落盘，
 *   prompt 组装时翻译成一句场所句（「用户点击的位置在【你的记忆笔记页】」）。
 *
 * ## 锚点契约（回归测试逐项验证：tests/aside/regions.test.ts）
 * 一期内容锚点：
 * - data-message-id  —— ChatMessage 各根节点（消息档解析的锚）
 * - data-chat-area   —— ChatArea 根节点（空白档「附近的对话」的锚）
 * 二期区域锚点（data-aside-region，值 = AsideRegionId）：
 * - chat         → src/components/chat/ChatArea.tsx
 * - memory       → src/components/home/HomeLanding.tsx
 * - settings     → src/pages/SettingsPage.tsx
 * - file-tree    → src/components/FileTree.tsx
 * - editor       → src/components/editor/EditorPane.tsx
 * - deck-preview → 不走 DOM 锚点：webview 内点主窗口收不到，host 翻译层
 *   （src/aside/deckClick.ts）直接注入
 */

/** 区域锚点属性名——各区根组件挂 `data-aside-region={id}` */
export const ASIDE_REGION_ATTR = 'data-aside-region';

/** 区域 id 有限闭集；加区域 = 加 id + 挂锚点 + 补人话短语，契约测试会逼齐 */
export const ASIDE_REGION_IDS = [
  'memory',
  'file-tree',
  'settings',
  'chat',
  'deck-preview',
  'editor',
] as const;

export type AsideRegionId = (typeof ASIDE_REGION_IDS)[number];

/** 区域 id → 场所句里的人话（「用户点击的位置在【…】」） */
export const ASIDE_REGION_PHRASES: Record<AsideRegionId, string> = {
  // 左右直绑是布局不变量（src/index.css .oru-pair：位置永不互换，hover 只换前后缩放）——
  // 评点是关思考的 one-shot，方位直说比让模型拿名字对身份稳
  memory: '手账——这里的记忆是你自己写下的，不是用户的',
  'file-tree': '左侧文件树',
  settings: '设置页',
  chat: '对话区',
  'deck-preview': '文稿（deck）预览',
  editor: '编辑器',
};

/** 校验任意字符串是否在区域闭集内——锚点脏值不进指代卡（宁缺毋错） */
export function isAsideRegionId(v: string | null | undefined): v is AsideRegionId {
  return !!v && (ASIDE_REGION_IDS as readonly string[]).includes(v);
}

/**
 * 软件自述（通识层）——Oru 的功能区地图。拼进短评 systemContext 与短聊的
 * ASIDE_CHAT_RULES（两条路径一个口径，见 electron/main/ws/aside/comment.ts）。
 * UI 大改时随上面的锚点契约一起更新。
 */
export const ORU_SOFTWARE_MAP = `你和用户共同看着 Oru（你所在的这个软件）的界面，它的功能区：
- 对话区：你与用户聊天的现场
- 左侧边栏：项目文件树与对话列表
- 文稿（deck）预览：你生成的演示文稿页面
- 手账（在对话着陆面下方，你写下的记忆——出自你手，不是用户的笔记）
- 编辑器：用户正在查看或编辑的文件
- 设置页：模型、供应商、扩展等配置
点到哪就身在哪；认不准场所时按画面所见说话，不要张冠李戴。`;
