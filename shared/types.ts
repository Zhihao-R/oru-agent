/**
 * 跨进程共享类型 — 主进程和渲染进程都依赖
 * 严禁在 agent 阶段修改本文件，需要新字段必须先回到 plan 协商
 */
import type { Platform } from './platform/message';

export type Project = {
  id: string;
  /** 数据归属用户 id；MVP 阶段固定 'local-user'，未来多用户时实际填充 */
  ownerId: string;
  name: string;
  path: string;
  addedAt: number;
  lastOpenedAt: number;
  hasClaudeMd: boolean;
  /** 今日已就该非 git 项目提示过「难以一键回退」的有效期 unix ms（本地时区当日 23:59:59.999）；次日零点自然过期 */
  gitHintShownUntil?: number;
};

// 文件树节点是"浅"的：只描述自身一层。父子关系由懒加载侧的 childrenByDir(Map) 表达，节点不自带子树。
export type FileNode = {
  name: string;
  path: string; // 相对项目根的路径，POSIX 风格分隔符
  isDirectory: boolean;
};

export type ChatRole = 'user' | 'assistant' | 'system';

/** 消息附加渲染类型——空表示普通文本消息 */
export type ChatMessageKind =
  | undefined
  | 'proposal'
  | 'task-report'
  | 'memory-record'
  | 'context-compressed'
  /** abort 时落盘的中断标记。historyAdapter 仍会注入给 LLM，但 UI 跳过渲染——
   *  避免与同条 assistant message 末尾的"已中断"状态行重复展示。 */
  | 'turn-terminator'
  // ─── Skill 模块（v1）chip 类型 ───
  // 运行时：分身做了与 plugin / skill 相关的可见动作，落 chip 让用户看见
  | 'plugin-install'
  | 'plugin-update'
  | 'plugin-uninstall'
  | 'plugin-activate'
  | 'skill-call'
  | 'skill-create'
  | 'skill-patch'
  | 'skill-install'
  // ─── 对话期 Subagent（v2）chip 类型 ───
  // 主 agent 调 Task 工具派出一个 subagent；chip 承载摘要，完整对话存 sidecar
  | 'subagent'
  // ─── 随手评点（aside）───
  /** aside 指代卡——payload 在 ChatMessage.asideReferent；UI 渲染为紧凑指代卡而非用户气泡 */
  | 'aside-referent'
  // ─── 项目未版本管理提示 ───
  /** 当天首次要改某个非 git 项目时落的一条提示条（系统口吻，无按钮）——告知改动难以一键回退 */
  | 'git-hint'
  // ─── Loop 模式活动卡 ───
  /** /loop 的收敛活动卡：一条消息承载整份 checklist + 进度，运行中同 id 反复覆盖更新（payload 在 loopCard） */
  | 'loop-checklist'
  // ─── 定时任务触发 ───
  /** 定时任务到点触发：text 是喂给模型的结构化 block，UI 据 scheduledTrigger payload 渲染居中触发卡而非用户气泡 */
  | 'scheduled-trigger'
  // ─── 定时任务后台执行结果（S18）───
  /** 定时任务后台执行完毕：UI 据 scheduledRun payload 渲染居中「定时任务结果」卡（标题+成败），正文不进卡 */
  | 'scheduled-run'
  /** 执行体的最终文字产出原文（正常 Oru 气泡）；kind 只标来源供下一回合旁白扫描把它排除在「真回复」外 */
  | 'scheduled-run-output';

/** 当 kind='scheduled-trigger' 时，附带的元信息（触发卡只读 title，不读 raw text） */
export type ScheduledTriggerPayload = {
  /** 触发的定时任务 id */
  taskId: string;
  /** 任务名（触发卡展示用） */
  title: string;
};

/** 当 kind='scheduled-run' 时，附带的元信息（结果卡只呈现标题+成败，错误详情不进 payload——见任务页 lastRun.error） */
export type ScheduledRunPayload = {
  taskId: string;
  title: string;
  /** lastRun.status 的子集；新执行路径不产生 'aborted'（退出中止不结算，见 executor） */
  status: 'ok' | 'error';
  /**
   * 客户端临时态标记：开跑广播（scheduledRun.started）到落盘结果卡之间，前端合成一张「执行中」卡。
   * 后端从不设此字段——落盘的结果卡只有成败。应用重启执行体不存活、live 卡自然消失。
   */
  running?: boolean;
};

/**
 * 触发一个回合的来源类型——队列项的一等语义轴（S08 统一准入内核定死，S09/S10/S18 消费）。
 * - 'user'：用户消息（桌面输入或渠道转来——渠道只是传输，S10 消费）。**唯一**有轮次间隙插入
 *   资格的类型：忙时可在工具边界搭进当前回合。
 * - 'scheduled'：定时任务触发/结果（现有 deliver 入队路径本期迁入；S18 重写执行路径后承载结果）。
 * - 'task-completed'：后台任务完成（subagent / 后台命令，S09 接入）。
 * 机器触发（scheduled/task-completed）不进间隙——只等回合结束合并（G12）。
 */
export type TurnTriggerType = 'user' | 'scheduled' | 'task-completed';

/**
 * 渠道来源标（S10 填写；回发判定与交还分流消费）。与 trigger 正交：渠道消息的 trigger 仍是
 * 'user'（在队列语义轴上它就是用户的话），「来自哪个渠道」由本结构承载。
 */
export type TriggerOrigin = { platform: Platform; chatId: string; platformMessageId: string };

/**
 * 交还给用户发落的队列项投影（S08 · G14）——chat.abort 回执 / chat.queue.handback /
 * chat.steering.recovered 三处协议事件携带同一形状，前端按 handbackForm 分流为草稿或待处理项。
 * attachments 必带：pending-item 放行经前端回传重建时若丢引用则图片丢失（文件本身已落盘）。
 */
export type HandbackItem = {
  serverId: string;
  clientMsgId: string;
  text: string;
  trigger: TurnTriggerType;
  origin?: TriggerOrigin;
  kind?: ChatMessageKind;
  scheduledTrigger?: ScheduledTriggerPayload;
  attachments?: ChatAttachment[];
};

/** 当 kind='memory-record' 时，附带的元信息 */
export type MemoryRecordPayload = {
  /**
   * 相对 ~/.oru/memory/ 的**完整路径**（如 agents/twin/episodes/<date>-slug.md），不得传压缩形式。
   * 消费方都按完整路径工作：查看走 NoteDetailOverlay 精确匹配 episodes 列表、撤销走
   * memory.undo 直接 join(memoryRoot, relPath) 挪文件——产卡点若塞压缩路径，两者都会静默失灵。
   */
  relPath: string;
  /** 简要内容（UI 显示） */
  preview: string;
  scope: 'personal' | 'agent' | 'project';
  /**
   * 记忆种类（决定卡片标签）。新值：user-basic / user-trait / self / episode。
   * 历史已持久化的卡片可能仍是旧值（fact / preference / persona）——渲染端 TYPE_LABEL
   * 保留旧键兜底，不破存量。
   */
  type: 'user-basic' | 'user-trait' | 'self' | 'episode';
  /** 是否被撤销（撤销后由前端把卡片样式改成"已撤销"） */
  undone?: boolean;
  /**
   * 档案类记忆专有：本次写入后完整文件内容的 hash。
   *
   * 档案里没有「这条记忆」这个实体——AI 改的是一份连续文档中的一段，所以撤销不能像 episode 那样
   * 把文件挪进回收站（那是把整份画像清零）。带上它，撤回就能在 FileHistory 里定位这次写入产生的
   * 那一版、回滚到它前面一版；同时它是「这之后档案没再被动过」的判据——不成立时不能撤，
   * 否则会连带撤掉后来的修改。缺省＝episode 卡片（撤销＝整条移进回收站）或本次没真落盘。
   */
  revertHash?: string;
  /** 被替换掉的原文（edit_memory 有，供卡片显示「改了什么」；整篇覆盖给不出，故缺省） */
  replaced?: string;
  /** 整篇覆盖（write_memory）时改动了哪些小节——否则卡片只能说「整篇重写了」，等于什么都没说 */
  sections?: ProfileSectionDelta;
};

/** 档案整篇覆盖前后的小节增删改（小节＝档案里的 `## 标题`） */
export type ProfileSectionDelta = {
  added: string[];
  changed: string[];
  removed: string[];
};

/** 当 kind='context-compressed' 时，附带的元信息（v0.2 长对话压缩通知卡） */
export type ContextCompressedPayload = {
  /** 被压缩的原始消息 id 列表（按时间正序）；前端展开时按 id 反查原文 */
  compressedMessageIds: string[];
  /** 摘要全文（v0.2 主路径下，发给 LLM 的实际内容；fallback 时为空） */
  summaryText: string;
  /** 摘要由哪个 model 生成（debug 用） */
  summaryModelId?: string;
  /** 摘要 provider（debug 用） */
  summaryProviderId?: string;
  /** true = 摘要 backend 调失败，回退到 v0.1 硬丢；前端文案改"摘要生成失败" */
  fallback?: boolean;
};

/**
 * 对话期 Subagent chip 载荷（kind='subagent' 时挂在 ChatMessage.subagent）。
 * 只持摘要——subagent 内部完整对话存 sidecar jsonl，前端展开 chip 时按 taskId 懒加载。
 * 不在主对话 ChatMessage 里内嵌 innerMessages，避免 historyAdapter 把内部对话喂回主 agent。
 */
/**
 * subagent 干活时"当前在干什么"的实时信号——两条派工链路（后台 task / 对话期 subagent）
 * 共用，喂同一张运行态卡。tool 来源前端用淡色显示（PRD 决策四：人话优先、动作兜底）。
 */
export type SubagentActivity = {
  source: 'speech' | 'tool';
  /** speech：subagent 原话（已截短）；tool：工具名兜底，前端按 toolName/toolObject 翻成人话覆盖 */
  text: string;
  /** tool 来源：工具名 + 宾语，前端 toolActivityText 翻成"改 X / 搜 Y" */
  toolName?: string;
  toolObject?: string;
};

export type SubagentChipRef = {
  /** sub_xxx；与 sidecar 文件名一致 */
  taskId: string;
  /** chip 上显示的简短意图（Task 工具入参 description） */
  description: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'error';
  /** 运行中"当前在干什么"——实时态推送，completed 后由 finalText 接管 */
  activity?: SubagentActivity;
  /** 主 agent 派给 subagent 的完整 user message（chip 展开第一段直接显示） */
  prompt: string;
  /** status='completed' 时填——subagent 最终输出 */
  finalText?: string;
  errorMessage?: string;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
  };
  startedAt: number;
  completedAt?: number;
};

/**
 * 随手评点（aside）的指代对象——「⌥ 点击的那块内容」的结构化描述。
 * 单判别轴 union，每档自带来源信息；label 是各档统一的展示文案（浮层标题 / aside 对话标题）。
 * 既是运行时结构，也是指代卡的落盘 payload（ChatMessage.asideReferent）——重启 / 归档找回 /
 * 转正之后，"点的是哪条消息、哪一页"都从这里还原，不靠拍扁文本反猜。
 * 点击坐标 {x,y} 刻意不在此类型里：只服务运行时浮层定位与截图标记，不落盘。
 * region（二期 §4 场所感）：点击所在功能区；锚点缺失 / 脏值时缺席——随指代卡落盘，
 * 归档回看也知道当时点在哪。
 */
export type AsideReferent = { label: string; region?: import('./asideRegions').AsideRegionId } & (
  | { type: 'selection'; text: string; surround?: string } // 选中文字 + 所在消息/文件可得的外层文本
  | { type: 'message'; messageId: string; text: string; context: string } // 整条消息 + 前后各 2 条
  | { type: 'deck-page'; pageIndex: number; text: string; outline: string } // 该页 innerText + 各页标题
  | { type: 'control'; caption?: string } // 控件可见文案（如有）
  | { type: 'blank'; context?: string } // 对话区空白带附近消息；其余纯看画面
  | { type: 'screen'; app?: string } // 窗外整屏（唤起对话）：前台 app 名，app 缺席时退化纯画面
);

/**
 * deck 预览 webview 内 ⌥ 点击的上抛 payload（preload → host，'aside:clicked' 通道）。
 * 点击那一刻就地从 DOM 提取——流式生成中的 deck，磁盘文件和屏幕可能不同步，
 * DOM 才是用户看见的快照，所以不走主进程读盘。
 * 两侧共用这一个类型（preload 组装、PreviewPane 翻译），不像 frame:captured 那样两端各自 cast。
 */
export type AsideDeckClickPayload = {
  /** 命中 .slide 的序号（document 内 .slide 顺序）；未命中（页间留白/容器边缘）为 -1 */
  pageIndex: number;
  /** 命中页 innerText；未命中为空串 */
  pageText: string;
  /** deck 内文本选区（点击时 window.getSelection()）；无选区为空串 */
  selectionText: string;
  /** 各页标题（大纲）——口径见 preload 的 slideTitle：每页首个 h1-h6，抓不到用首行文本兜底 */
  outline: string[];
  /** 点击位置（webview 视口 CSS 像素 = webview 可视坐标，与 frame:captured 同口径） */
  x: number;
  y: number;
};

/**
 * 唤起对话（系统级）一次 ⌥ 点的 IPC 载荷——主进程截屏 + 分流后推给独立浮层渲染窗
 * （'overlay:click' 通道）。浮层窗据此组 `AsideClick{ referent:'screen' }` 喂现成 overlayMachine，
 * 与 deck 点击同构（自带截图 + 截图坐标，复用 markClickOnScreenshot 画聚光圈）。
 */
export type ScreenOverlayClick = {
  /** 下采样后整屏 PNG base64（不带 data: 前缀） */
  screenshot: string;
  /** 点击点在截图坐标系内的位置（聚光圈圆心） */
  shot: { x: number; y: number };
  /** 点击点在浮层窗本地坐标（= 全局点 − display.bounds.origin，DIP）——浮层面板定位 */
  position: { x: number; y: number };
  /** 该点所在应用名（active-win / hit-test 取；取不到则缺省 → 退化为纯画面） */
  app?: string;
};

/**
 * v0.3 图片附件——挂在 user 消息上的 1~N 张图。
 * 文件本身落盘在 ~/.oru/users/<ownerId>/conversations/<agentId>/<convId>-images/，
 * 这里只引用相对路径（避免 jsonl 膨胀到几十 MB）。
 */
export type ChatAttachment = {
  /** 附件类型；本期只接 'image' */
  kind: 'image';
  /** 相对 ~/.oru/users/<ownerId>/conversations/<agentId>/ 的路径，POSIX 风格 */
  relPath: string;
  /** 图片 MIME */
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** 字节数 */
  bytes: number;
  /** 用户原始文件名（无路径，仅占位文案用） */
  filename: string;
  /**
   * 图像的文字站位（hermes 风格的兜底）：历史拍成纯文本时替图站位的那句话。
   * 消费方是 historyAdapter 的无视觉降级分支（有值用它，没值用默认「当前模型不支持视觉」）。
   * 落盘数据不写入；claude-code 后端灌历史并入点睛种子图时瞬态改写为「已附上」
   * （backends/claudeCode.ts 的 renderSeedPrompt 浅拷贝改写，不落盘）。未来若接
   * 「切模型时调一次视觉模型给老图生成描述」功能，无需迁移老数据。
   */
  fallbackText?: string;
  /**
   * 渲染期可用的 src URL；不落盘。
   * - readHistory 时主进程根据 relPath 拼 `file://...` 填入
   * - 前端发送瞬间用 `URL.createObjectURL(file)` 填入（blob: 开头）
   * 前端 UI 渲染统一读这个字段，不关心 relPath 是否真实存在
   */
  displayUrl?: string;
};

/**
 * 引用 chip：从编辑器/文稿选段「加入对话」时落进 composer 的只读上下文片段。
 * 通用——对任意 md 生效，叙事文稿只是首个受益场景（决策 7）。发送时由
 * buildMessageWithRefs 渲染成上下文块拼进消息，不走 wire（纯前端 composer 概念）。
 */
export type ChatRef = {
  id: string;
  /** 选中的原文（kind='file' 时存文件名，供 RefChip 展示） */
  quote: string;
  /** 来源文件相对路径（POSIX） */
  sourcePath: string;
  /** 可选起始行号（1 起）；kind='file' 时无 */
  line?: number;
  /**
   * 判别引用形态（缺省 'quote'，兼容现有选段引用）：
   * - 'quote'：选段引用——quote 是原文，渲染成 blockquote + 来源行。
   * - 'file'：整文件引用——quote 是文件名，渲染成「引用文件: path」让 agent 自己去读。
   */
  kind?: 'quote' | 'file';
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatRole;
  text: string;
  toolCalls: ToolCall[];
  createdAt: number;
  done: boolean;
  kind?: ChatMessageKind;
  /**
   * v0.3：本条消息携带的图片附件（按发送顺序）。
   * 仅 user 消息会有；落盘前由主进程 saveAttachments 写文件并填充 relPath。
   */
  attachments?: ChatAttachment[];
  /** 仅当 kind='proposal'/'task-report' 时有值（指向对应 ActionProposal/Task） */
  refId?: string;
  /** 仅当 kind='memory-record' 时有值 */
  memoryRecord?: MemoryRecordPayload;
  /** 仅当 kind='context-compressed' 时有值（v0.2 压缩通知卡的元数据） */
  contextCompressed?: ContextCompressedPayload;
  /**
   * Skill 模块 v1：plugin-* 或 skill-* 七种 kind 时承载 chip 渲染所需信息。
   * 单字段统一（不分 plugin / skill 两个槽位）——payload 形状对称，调用方少一层 `??` 合并判断。
   */
  skillModuleAction?: SkillModuleActionPayload;
  /** 仅当 kind='subagent' 时有值（对话期 subagent chip 摘要；完整对话见 sidecar） */
  subagent?: SubagentChipRef;
  /** 仅当 kind='loop-checklist' 时有值（/loop 收敛活动卡的实时状态） */
  loopCard?: LoopCardPayload;
  /** 仅当 kind='aside-referent' 时有值（随手评点指代卡的结构化来源） */
  asideReferent?: AsideReferent;
  /** 仅当 kind='scheduled-trigger' 时有值（定时任务触发卡的任务引用） */
  scheduledTrigger?: ScheduledTriggerPayload;
  /** 仅当 kind='scheduled-run' 时有值（定时任务后台执行结果卡的标题+成败） */
  scheduledRun?: ScheduledRunPayload;
  /** 仅当 kind='proposal' 时有值（S24 · G130 审批决定存证；refId 同 proposalId）。 */
  proposalRecord?: ProposalRecord;
  /**
   * Steering：本条 user 消息若是「忙时入队、后于动作边界被读入」的「将生效」消息，记录其前端
   * 客户端 id。用途：切走/切回时服务端历史重放，前端据此把残留的乐观气泡与重放出的正式消息去重，
   * 不重不丢。普通即时发送的消息无此字段。
   */
  clientMsgId?: string;
  /**
   * 写入时打标的 backend 类型，给"切 backend 后历史回放"识别用。
   * 老数据无此字段时按 'claude-code' 推定（向后兼容）。
   */
  backendType?: BackendType;
  /**
   * 工具调用的协议形态——比 backendType 更细，决定跨 backend 切换时怎么折叠。
   * 老数据无此字段时按 'sdk-mcp' 推定。
   */
  toolProtocol?: ToolProtocol;
  /**
   * 写入时使用的 RegisteredModel.id；指向 Settings.models 里的注册项。
   * 用途：debug 溯源 / 撞墙错误归因 / v0.2 token 估算前置。
   * 老数据 / OAuth fallback 走 SDK 默认时无值。
   */
  modelId?: string;
  /**
   * 写入时使用的 BackendProvider.id；指向 Settings.providers 里的注册项。
   * 冗余字段：modelId 被删后仍能溯源到供应商。
   */
  providerId?: string;
  /**
   * 回合内锚点（S1）：标记本条卡属于哪条 assistant 消息（messageId = 该回合 assistant 消息 id）。
   * 渲染层据此把卡插到对应回合的助手回复之后，而不是按 createdAt 沉到流尾。
   * 老数据无此字段 → 回退到按 createdAt 排序（现状，不破坏）。
   * 仅 memory-record / skill-call / plugin-activate 使用；context-compressed 走独立插入语义、不设此字段。
   */
  anchorTo?: { messageId: string };
  /**
   * 中断恢复：本条 assistant 消息是「被打断、未正常收尾」的半截——含已成形的文字 + 已发起的工具调用
   * （其中"已发起未回结果"的调用其 result 缺失，即悬空）。缺省 = 正常完成。持久化字段。
   * 'aborted'=用户主动停；'upstream_error'=上游挂死 / 网络错；'crashed'=进程崩溃后重启从流式草稿补回
   * （见 agent/turnInflight.ts）。
   */
  interrupted?: 'aborted' | 'upstream_error' | 'crashed';
  // ─── 流式控制运行时字段（不持久化，仅 UI 状态机用） ───
  /**
   * Steering「将生效」前端态（仅渲染端、不持久化、服务端从不下发）：标记本条乐观 user 气泡是
   * 「忙时发出、还没被读入」的将生效消息。被读入（consumed）后清除此字段、气泡变普通消息；
   * 撤回成功（removed）则整条移除。serverId 由 chat.steering.added 回执填入，撤回/对账据它匹配。
   * 用 'queued'（对应服务端入队语义）而非 'pending'——后者与忙态 pendingByConv 撞词，刻意区隔。
   * - 'queued'：已发出、还在服务端队列未被读入（◌ + 可撤回）
   * - 'withdrawing'：用户点了撤回、等服务端回执（不可逆删前的中间态，绝不先删）
   */
  steering?: { state: 'queued' | 'withdrawing'; serverId?: string };
  /** 用户主动 Stop 后置 true，UI 显示"已中断"状态行 */
  abortedByUser?: boolean;
  /** 当前正在 transport 重试中（>0），UI 显示"🔁 上游错误，正在重试 (n/N)…" */
  retryAttempt?: number;
  /** 流式期间出错（含 4xx/5xx/idle timeout/网络错） */
  error?: { message: string; retryable: boolean };
  /**
   * 仅 conversation.kind === 'taskboard-comment' 时有值。
   * 数据层是数组（预留 v2 多 @）；MVP UI 限制最多 1 个，唯一可选 'oru'。
   * mentions 包含 'oru' = 触发 agent；不含或空 = 仅留言不触发。
   *
   * 仅在 taskboard.note.add / taskboard.comment.send 路径写入；
   * chat.send 不读 ChatSendReq 上的 mentions（类型上也没有）——构建 ChatMessage 时自然不带。
   */
  mentions?: BoardActorId[];
};

export type BackendType = 'claude-code' | 'anthropic' | 'openai-compatible';
export type ToolProtocol = 'sdk-mcp' | 'anthropic-native' | 'openai-fc';

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error';

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ToolCallStatus;
  result?: ToolResult;
  startedAt: number;
  finishedAt?: number;
  /**
   * 本次调用发生时，同条 assistant 消息已积累的文本字符数（后端 stream.ts 盖戳）。
   * 渲染层据此把 text 切开，让工具卡按真实时序插在文本中间（见 buildMessageSegments）。
   * 老数据无此字段——渲染回退到"工具置顶"。
   */
  textOffset?: number;
  /**
   * 图片类工具（image_search / download_image）的视觉展示数据（决策 8）。
   * 由工具 execute 落盘缩略图/落地图后写进 toolVisuals 桥，stream.ts 在 tool_result 时
   * 按 (conversationId, name, input) 取出挂到这里。轻引用（图走 oru-toolimg:// 协议），
   * 不内联 base64——避免对话历史膨胀。ToolCallCard 据此渲染候选网格 / 落地图。
   */
  visual?: ToolCallVisual;
  /**
   * 前台命令执行期间的实时输出（S19·G19）——**纯前端瞬态、只给人看**：chat.commandOutput 边跑边追加，
   * 工具卡在 status==='running' 时滚动显示，结果到达（tool_result）即由 result 接管。不落盘、不回后端、
   * 不喂模型；server 回放历史时不带此字段。
   */
  commandOutput?: string;
};

/** image_search 候选缩略图的轻引用（决策 8）；imgPath 经 oru-toolimg:// 协议加载 */
export type ToolCallVisualThumb = {
  /** 缩略图绝对路径（落在对话 tool-cache）；前端拼 oru-toolimg://local<path> 加载 */
  imgPath: string;
  sourceUrl?: string;
  contentUrl?: string;
  width?: number;
  height?: number;
};

/**
 * 图片工具的聊天卡视觉数据（决策 8）。
 * - image_search：模型看过的候选缩略图网格 + 用了哪家引擎。
 * - download_image：落地图 + 写进 <img src> 的相对路径 + 来源 host。
 */
export type ToolCallVisual =
  | {
      kind: 'image_search';
      query: string;
      engineUsed?: string;
      thumbnails: ToolCallVisualThumb[];
    }
  | {
      kind: 'download_image';
      /** 落地图绝对路径（deck/images 下）；前端拼 oru-toolimg://local<path> 加载 */
      imgPath: string;
      /** 写进 <img src> 的相对路径，如 images/hero-2.jpg */
      relPath: string;
      sourceHost?: string;
    };

/**
 * v0.4 工具结果源头落盘引用。
 * 当 detail 估算超阈值（2k token）时由 stream.ts 写盘并填此字段；
 * historyAdapter 看到此字段时把 preview 发给 LLM（detail 仍留在 JSONL 给 UI）。
 */
export type ToolResultPersistedRef = {
  /** 绝对路径，指向 .tool-cache/<callId>.<ext> */
  path: string;
  /** 全文字符数（让 LLM 判断是否要 read_file） */
  totalChars: number;
  /** 给 LLM 看的预览文本（前 1500 字 + 引用提示行） */
  preview: string;
};

export type ToolResult = {
  toolCallId: string;
  isError: boolean;
  /** 简短摘要，UI 直接显示 */
  summary: string;
  /** 完整内容，折叠后才显示 */
  detail?: string;
  /**
   * v0.4 源头落盘：detail 超阈值时由 stream.ts 写盘并填此字段。
   * historyAdapter 看到此字段时把 preview 发给 LLM；本地 JSONL 仍存 detail 全文。
   */
  persistedRef?: ToolResultPersistedRef;
  /**
   * 工具上抛的结构化元数据（如 web_search 的 engineUsed）。
   * 来自 AgentTool.execute 的 ToolResult.structured，经 ConversationEvent.tool_result 透传，
   * 由 stream.ts 落盘到这里。
   * 不发给 LLM——LLM 只看 detail / persistedRef.preview。
   */
  structured?: Record<string, unknown>;
};

/**
 * 「带选项提问」（ask_user_choice 工具）——Twin 在主对话里让用户在几个带说明的选项里挑。
 * 工具入参、WS 协议、前端卡片共用这一处定义（单一来源）。
 *
 * 「我自己说」自由文本与「跳过」**不进 schema**——由前端自动追加，模型不该控制这两个逃生口。
 */
export type AskUserChoiceOption = {
  label: string;
  description?: string;
};

export type AskUserChoiceQuestion = {
  question: string;
  /** 短标题，做顶部 tab */
  header: string;
  /** 默认单选 */
  multiSelect?: boolean;
  options: AskUserChoiceOption[];
};

/**
 * 单题回答。三态互斥（由前端保证）：
 * - 选了选项：selectedLabels 非空
 * - 我自己说：freeText 非空
 * - 跳过（没选直接翻过 / 没选就提交）：skipped=true
 */
export type AskUserChoiceAnswerItem = {
  questionIndex: number;
  selectedLabels?: string[];
  freeText?: string;
  skipped?: boolean;
};

export type AskUserChoiceAnswers = {
  answers: AskUserChoiceAnswerItem[];
};

export type ChatDelta = {
  /** 文本增量（流式拼接） */
  textChunk?: string;
};

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export type GitStatus = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: Array<{
    path: string;
    status: GitFileStatus;
  }>;
  isClean: boolean;
};

export type AuthMode = 'claude_cli' | 'env_api_key' | 'manual_api_key' | 'none';

/**
 * 主对话模型后端可用性——UI 门禁（输入禁用 / 顶栏徽章 / 提示横幅）只看这个，
 * 不再单看 Claude 鉴权：任一已配置后端可用即 ready（多 backend 时代，Claude 只是其中一路）。
 * 主进程内部探测 Claude 鉴权用 ClaudeAuthStatus（多带一个 mode）。
 */
export type AuthStatus = {
  ready: boolean;
  /** 给 UI 的引导文案 */
  hint: string;
};

/** Claude 鉴权探测结果（claudeCode 后端构造 / 老 key 迁移用）——mode 标记凭证来源。 */
export type ClaudeAuthStatus = AuthStatus & {
  mode: AuthMode;
};

export type ColorScheme =
  | 'terracotta'
  | 'klein'
  | 'ember'
  | 'mono'
  | 'iris'
  | 'peacock'
  | 'snowline';

export type Settings = {
  theme: 'light' | 'dark' | 'system';
  /** 配色主题；缺省 'terracotta' 与历史视觉一致 */
  colorScheme: ColorScheme;
  /**
   * 界面语言；缺省 'system'（按 OS 语言，非中文一律英文）。可选字段，老 settings 无此字段
   * 等同 'system'，对老用户安全无需 migration。机制完全对照 theme 双层架构（见 src/lib/language.ts）。
   */
  language?: 'zh' | 'en' | 'system';
  /**
   * @deprecated 多 backend 改造之后由 BackendProvider 取代；保留做向后兼容和启动迁移。
   * 一旦 migratedFromManualApiKey=true，本字段后续变化不再触发自动迁移。
   */
  manualApiKey: string | null;
  /** 用户配置的全部 LLM 供应商；空表示尚未配置 */
  providers: BackendProvider[];
  /** 用户从供应商挑出来要用的具体 model；空表示尚未配置 */
  models: RegisteredModel[];
  /** 各 LLM 用途分配到哪个 RegisteredModel.id；null 表示未分配 */
  modelAssignments: ModelAssignment;
  /**
   * 各 LLM 用途是否开启思考（Track B）。默认分档由 defaultModelThinking() 提供；
   * 老用户无此字段时读取处回落默认值，不能裸读直判。
   */
  modelThinking: ModelThinking;
  /**
   * @deprecated 思考开关统一收进 modelThinking['asideComment']（Track B）。本字段保留做读兼容：
   * 老用户落盘有此字段时，读 aside 思考按它判断；新实现一律走 modelThinking['asideComment']。
   */
  asideThinking?: boolean;
  /**
   * 启动期是否已完成"老 manualApiKey → BackendProvider"的迁移。
   * true 后即使用户把 manualApiKey 清空再粘新 key，也不再自动迁移；要去 Settings 编辑 provider。
   */
  migratedFromManualApiKey?: boolean;
  /**
   * 启动期是否已完成"GLM 模型 supportsPromptCache 回灌"的迁移。
   * true 后不再触发——用户日后手动改写 supportsPromptCache 不会被覆盖。
   * 详见 electron/main/agent/migrateZhipuPromptCacheFlag.ts
   */
  migratedZhipuPromptCacheFlag?: boolean;
  /**
   * 上一次 migrateZhipuPromptCacheFlag 改过的 model.id 清单。
   * 作用：未来若需把 supportsPromptCache 改回 false，按这份白名单批改——能区分
   * "migration 改的"（在 changedIds 里）与"用户主动勾的"（不在 changedIds 里）。
   * 不在 changedIds 的 model 永不被反向 migration 触碰。
   */
  migratedZhipuPromptCacheFlagChangedIds?: string[];
  /** 上网搜索配置；老数据缺省时由 store 启动迁移填默认值 */
  webSearch?: WebSearchSettings;
  /** 外部 MCP server 列表（v0.5）；老数据缺省时由 store 启动迁移填默认值 */
  mcpServers?: McpServerConfig[];
  /**
   * 开发者模式相关开关。整个字段可选——老 settings 文件没有这个字段时
   * 等同 undefined（一切关闭）。新增可选字段对老用户安全，无需 migration。
   */
  developer?: DeveloperSettings;
  /**
   * 三方平台接入（飞书 + Discord）——**仅非密配置**。App Secret / Bot Token 绝不在此
   * （它们在主进程独有的 credentialStore，红线 1：config.json 会推给渲染进程）。可选，老数据缺省等同未配置。
   */
  platforms?: PlatformSettings;
  /**
   * 自动归档（对话归档）：久不互动的对话自动收进「已归档」区。全局一份、所有分身共用。
   * 可选，老数据缺省由 store load 回落 { enabled:true, thresholdHours:168 }（默认开、7 天）。
   */
  autoArchive?: AutoArchiveSettings;
  /**
   * 手动归档前是否弹确认。缺省（undefined）= 弹；用户在确认弹窗勾「不再提醒」即置 false（直接归档）。
   * 全局一份、所有分身共用。裸 boolean 足够——只此一个开关，无并发字段需要伴随。
   */
  confirmBeforeArchive?: boolean;
  /**
   * 全局用量预算（S15 · G111）。可选，老数据缺省由 store load 回落 { enabled:false, … }（默认关）。
   * 全局一份、所有分身共用。
   */
  budget?: BudgetSettings;
  /**
   * 全局点睛（系统级唤起对话）：在任意 App 里 ⌥ 点都能凑过来说一句。开启会向系统申请
   * 「输入监控 + 屏幕录制」权限。可选，老数据缺省由 store load 回落 { enabled:true }（默认开，PRD §5）。
   */
  desktopPresence?: DesktopPresenceSettings;
  /**
   * 对话中阻止休眠：Oru 跑回合/后台任务期间用 `caffeinate -dims` 顶住 Mac 休眠与显示器息屏，
   * 干完即松手。默认关（不主动改系统休眠行为）。全局一份、所有分身共用。老数据缺省由 store load
   * 回落 { enabled:false }（关），无需 migration。可选字段，见 docs/tech/2026-08-02-keep-awake-tech-design.md。
   */
  keepAwake?: KeepAwakeSettings;
  /**
   * Loop 模式的轮数硬上限（S21·G120）——到此轮数即中止（不烧终局复看）。撤原写死常量，改用户可调。
   * 可选，老数据缺省由 store load 回落 5、并 clamp 到 [1, 20]。token 预算闸门另由 S15 叠加。
   */
  loopMaxRounds?: number;
};

/** 自动归档配置（对话归档）。thresholdHours：多少小时无新消息则归档（消费端 clamp 到 ≥1）。 */
export type AutoArchiveSettings = {
  enabled: boolean;
  thresholdHours: number;
};

/**
 * 全局用量预算的两级线（理想架构 S15 · G111）。默认关闭——预算是用户对自己钱包的决定权，
 * 系统不预设数字（太低误伤后台任务、太高形同虚设）。窗口为滚动 30 天（对齐用量账本的粗聚合，
 * 不与自然月账单强绑）；额度按 token 计（金额需一份会过期的价目表，与「影子不可信」相抵，只作展示估算）。
 */
export type BudgetSettings = {
  /** 是否启用两级线；false = 不设限（无人值守照跑、前台不告警）。 */
  enabled: boolean;
  /** 硬上限（滚动 30 天累计 token）：到此无人值守路径暂停进通知中心，前台对话仅告知不阻断。 */
  hardLimitTokens: number;
  /** 软警戒线占硬上限的比例（0–1）：到此发事前警戒进通知中心。缺省 0.8。 */
  softRatio: number;
};

/**
 * 全局点睛配置。当前只有总开关；触发修饰键（PRD §11）等留待将来扩这个对象，
 * 故用对象而非裸 boolean——加第二个字段对存量数据零破坏。
 */
export type DesktopPresenceSettings = {
  enabled: boolean;
};

/**
 * 「对话中阻止休眠」配置。当前只有总开关；用对象而非裸 boolean，与 desktopPresence
 * 同理由——将来或可扩唤醒方式（如仅阻止系统睡眠 vs 也阻止显示睡眠）。老数据缺省＝关。
 */
export type KeepAwakeSettings = {
  enabled: boolean;
};

/**
 * 白名单一条：稳定用户 ID + 绑定时抓到的展示信息。id 是唯一承重字段（成员判定只看它）；
 * 其余全可选，是为了让设置页「看得清谁是谁」——抓不到 / 旧数据一律留空，界面回落显示 id。
 */
export type WhitelistEntry = {
  /** 稳定用户 ID（优先飞书 union_id）——成员判定唯一键。 */
  id: string;
  /** 绑定来源平台（迁移来的旧裸字符串未知则留空）。 */
  platform?: Platform;
  /** 绑定时抓到的昵称；抓不到留空，界面回落显示 id。 */
  displayName?: string;
  /**
   * 该用户在此平台的聊天地址（私聊 chat_id）——「定时任务按人推送」据此定位发到哪个聊天。
   * 绑定时捕获；旧数据 / 手动新增（没聊天上下文）留空，之后该用户发任一消息时自动补录。
   */
  chatId?: string;
  /** 绑定时间（毫秒）；旧数据留空。 */
  boundAt?: number;
  /** 绑定方式：配对码绑定 / 设置里手动添加。 */
  source?: 'pairing' | 'manual';
};

/** 三方平台非密配置（渲染进程可见）。凭证不在此，见 electron/main/platform/credentialStore.ts。 */
export type PlatformSettings = {
  /** 远程默认 agent id；null = 未指定（平台消息无处路由，回提示去设置选） */
  remoteDefaultAgentId: string | null;
  /** 白名单：绑定用户条目，初始空——fail-closed（红线 3）。旧版存裸字符串，读时归一为条目。 */
  whitelist: WhitelistEntry[];
  /** 飞书长连接是否启用 */
  feishuEnabled?: boolean;
  /** Discord 长连接是否启用 */
  discordEnabled?: boolean;
};

export type DeveloperSettings = {
  /** 是否记录调试日志（NDJSON 落到 ~/.oru/users/<ownerId>/debug/）。默认 false */
  debugLogging: boolean;
};

// ─── 上网搜索配置 ─────────────────────────────────────────────

/** 已实现的搜索引擎类型 */
export type SearchEngineType = 'bocha' | 'tavily' | 'anysearch';

/** 单个搜索引擎的配置 */
export type SearchEngineConfig = {
  id: string;
  type: SearchEngineType;
  apiKey: string;
  /** 上次"测试连接"的状态，用于 Settings 徽标 */
  lastTestStatus?: 'ok' | 'failed' | 'unknown';
  /** 失败时的错误简述（hover 看） */
  lastTestError?: string;
  /** 上次测试时间戳（毫秒） */
  lastTestAt?: number;
};

// ─── 外部 MCP server 配置（v0.5）────────────────────────────────

/**
 * 外部 MCP server 的运行状态。
 * - 'idle': 未启用
 * - 'starting': 正在 spawn + handshake
 * - 'connected': MCP handshake OK，但未探活（probeTool 不存在或没跑过）
 * - 'probe_failed': handshake OK 但下游探活失败（如 chrome-devtools-mcp 的 CDP attach 没通）
 * - 'connected_ready': handshake + 探活都通过（真能用）
 * - 'failed': spawn / handshake 失败
 * - 'reconnecting': 手动重连进行中——UI 乐观态（用户点「重连」时即置），主进程从不持久产出它，
 *   RPC 落定后被真状态覆盖。与 'starting'（首次启动）区分，让「崩了在重连」读起来更诚实（§4.5）。
 */
export type McpServerStatus =
  | 'idle'
  | 'starting'
  | 'connected'
  | 'probe_failed'
  | 'connected_ready'
  | 'failed'
  | 'reconnecting';

export type McpServerConfig = {
  id: string;
  /** 用户可见名 */
  label: string;
  /** 用户自填的可选简介，列表上显示在标题下方一行；不是 server 自报的元数据 */
  description?: string;
  /** spawn 命令，例：'npx' */
  command: string;
  /** spawn 参数，例：['-y', 'chrome-devtools-mcp@latest', '--autoConnect'] */
  args: string[];
  /** 环境变量（敏感的 API key 等） */
  env?: Record<string, string>;
  /** 启用开关 */
  enabled: boolean;
  /** 探活用的工具名；缺省时只跑 handshake 不探活（停在 connected 不升级）*/
  probeTool?: string;
  /** 上次连接状态 */
  lastStatus?: McpServerStatus;
  /** 上次错误简述（hover 看详情）*/
  lastError?: string;
  /** 上次状态时间戳 */
  lastConnectedAt?: number;
};

// ─── 上网搜索配置（续） ─────────────────────────────────────────

/**
 * 磁盘上存在、但本版本不认识 type 的引擎条目（用户从新版本降级 / 该引擎类型已被删除）。
 * 反序列化容错把它从 engines 剔到 unsupportedEngines（设置页灰化展示 + 可删）；
 * 写盘时并回 engines（条目无损，顺序并到末尾）。type 放宽为 string——它就是「不在
 * SearchEngineType 里」的条目，收窄了反而表达不了。
 */
export type UnsupportedEngineConfig = Omit<SearchEngineConfig, 'type'> & { type: string };

export type WebSearchSettings = {
  /** 总开关；false 时工具不注册、prompt 段不注入 */
  enabled: boolean;
  /** 已配置的引擎；数组顺序就是优先级（顶部优先） */
  engines: SearchEngineConfig[];
  /** 长网页智能摘要开关；默认 true */
  longPageSummary: boolean;
  /** 运行时字段：反序列化容错剔除的未知引擎条目；不落盘（persist 时并回 engines） */
  unsupportedEngines?: UnsupportedEngineConfig[];
};

// ─── Backend Provider / Model 配置 ────────────────────────────────

/**
 * 供应商类型；'custom-openai' 用于用户自定义 OpenAI 兼容端点。
 * '*-coding' 三家是第三方 coding plan 订阅（走各厂商的 Anthropic 兼容端点，见 providerProtocol）。
 */
export type BackendProviderType =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'zhipu'
  | 'kimi'
  | 'custom-openai'
  | 'glm-coding'
  | 'kimi-coding'
  | 'minimax-coding';

export type BackendProvider = {
  id: string;
  type: BackendProviderType;
  /** 用户自定义显示名 */
  label: string;
  apiKey: string;
  /**
   * openrouter / custom-openai / openai 可选覆盖；三家 coding plan 预填默认端点、允许改（海外用户切端点）；
   * 其他类型用默认 endpoint。解析：openai-fc 走 resolveOpenAICompatibleBaseURL，
   * anthropic-native 走 resolveAnthropicCompatiblePreset。
   */
  baseUrl?: string;
};

/** 用户从某个供应商挑出来要用的某个具体 model */
export type RegisteredModel = {
  id: string;
  providerId: string;
  /** 直接喂给 API 的 model id，例如 'anthropic/claude-sonnet-4-6'、'openai/gpt-5' */
  modelId: string;
  /** 用户可见的显示名；默认等于 modelId */
  label: string;
  /**
   * 模型上下文窗口（token），v0.2 引入。用于"有效窗口" = window × 0.8 的派生值。
   * 新建时强制要求（router 校验 ≥ 1024）；老数据可能为空，UI 提示 ⚠ 让用户编辑补全。
   * 调用时仍按 200_000 兜底，不阻断对话。
   */
  contextWindow?: number;
  /**
   * 是否支持视觉（图片输入）。新建时必选；本期仅作为元数据 + UI 徽标，
   * 未来输入框图片附件功能落地时按此自动启停贴图按钮。老数据为空。
   */
  supportsVision?: boolean;
  /**
   * 单次回复的输出 token 上限。
   * 不填 = backend SDK 默认（Anthropic 8192、OpenAI 让模型自决）；
   * 填了由 backend 调用层透传给 max_tokens。
   */
  maxOutputTokens?: number;
  /**
   * 是否支持 prompt cache。
   * 不填或 false → backend 不在 system 段加 cache_control（误开会让不支持的模型报错）。
   * 本期仅 anthropic backend 走这个闸门；openai 后续接入。
   */
  supportsPromptCache?: boolean;
  /**
   * 是否支持思考模式（Claude extended thinking / OpenAI o-系列 reasoning）。
   * 本期仅记录元数据 + UI 徽标，未来"思考模式"开关 PRD 落地后联动。
   */
  supportsReasoning?: boolean;
  /**
   * 思考强度（仅 OpenRouter 路径生效；其他 provider 当前忽略此字段）。
   * 不填默认 'medium'。OpenRouter 把 effort 翻译成各上游原生字段：
   * OpenAI o 系列按 token 百分比、Anthropic extended thinking 按 budget_tokens、Gemini thinkingLevel。
   * 仅当 supportsReasoning=true 时，backend 才把 reasoning:{effort} 注入请求体。
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

/** LLM 调用的用途（v0.2 加了 conversationSummary，v0.7 加了 conversationTitle，v2 加了 twinSubagent） */
/** 所有 LLM 用途的单一运行时来源——类型从此派生，校验/遍历都复用，避免类型与运行时漂移 */
export const LLM_USAGES = [
  'twinMain',
  'twinBackground',
  'memoryDream',
  'subagentCoder',
  'conversationSummary',
  'conversationTitle',
  /** 对话期 subagent（主 agent 调 Task 工具派出的子 LLM 会话）；与 twinMain 同 backend / model */
  'twinSubagent',
  /** 随手评点（aside）one-shot 短评；未分配时回落 twinMain 的路由——短评必须是"这个 Oru"说的 */
  'asideComment',
  /**
   * Loop 模式的独立审查员（one-shot 逐项判 review 项）。与干活的 subagentCoder 分开，
   * 拿掉"干活的自己判达标"的偏心（红线 1）。默认就用轻量后端——独立不等于贵。
   * 注意迁移坑（同 twinSubagent）：老用户落盘的 modelAssignments 没这个 key，读出来是 undefined；
   * 取后端处必须按"缺省回落到默认后端"处理（realGetBackendFor 的 !assignedModelId 已兜住），
   * 不能裸 settings.modelAssignments['loopReviewer'] 直用判定。
   */
  'loopReviewer',
  /**
   * 记忆召回的廉价挑选器（one-shot：读候选简介 + 洗过的对话，只回选中 id）。每轮串联跑、要又便宜，
   * 该配一个轻量小模型。同迁移坑（同 loopReviewer / twinSubagent）：老用户落盘的 modelAssignments
   * 没这个 key，读出 undefined；取后端走 getBackendFor('memoryRecall')，realGetBackendFor 的
   * !assignedModelId 已回落默认后端，不能裸 settings.modelAssignments['memoryRecall'] 直用判定。
   */
  'memoryRecall',
  /**
   * 定时任务后台执行体（S18·到点即后台开跑）。与主对话回合同套工具（透明继承 twinMain，含 Task/bash），
   * 未分配时回落 twinMain 的路由——执行体必须是「这个 Oru」（同 asideComment 先例）。用量账本按此
   * usage 单列归账（S13）。同迁移坑（老用户 modelAssignments 无此 key，读出 undefined，取后端处
   * realGetBackendFor 的 !assignedModelId 回落默认后端已兜住）。
   */
  'scheduledRun',
  /**
   * Loop 拆解（把 /loop 目标拆成验收标准的受限回合，仅暴露 submit_checklist 一个工具）。
   * 未分配时回落 twinMain 的路由——拆解必须是「这个 Oru」（同 asideComment / scheduledRun 先例）。
   * 同迁移坑（老用户 modelAssignments 无此 key，读出 undefined，realGetBackendFor 的
   * !assignedModelId 回落已兜住，不能裸 settings.modelAssignments['loopCompile'] 直用判定）。
   */
  'loopCompile',
] as const;

export type LlmUsage = (typeof LLM_USAGES)[number];

/**
 * 新建子对话的默认标题。
 * - 创建时统一塞这个常量；UI 不再要求用户预先填名
 * - autoNameConversation 用「title === DEFAULT_NEW_CONV_TITLE」判定"还能自动命名"
 *   （用户改过名 → 不等于默认 → 不再覆盖；命名成功 → 不等于默认 → 不重复命名）
 */
export const DEFAULT_NEW_CONV_TITLE = '新对话';

/** 各用途分配到哪个 RegisteredModel.id；null 表示未分配 */
export type ModelAssignment = Record<LlmUsage, string | null>;

/**
 * 各用途是否开启思考（默认分档见 defaultModelThinking）。true=开思考，false=关。
 * 只对 supportsReasoning 的模型/后端生效；不支持思考的模型开关隐藏/置灰。
 * 老用户落盘没有此字段/此 key → 读取处一律 `settings.modelThinking[usage] ?? defaultModelThinking()[usage]`，
 * 不能裸读直判（迁移坑同 modelAssignments，见 :957 注释先例）。
 */
export type ModelThinking = Record<LlmUsage, boolean>;

/**
 * 思考开关默认分档（Track B 拍板）：
 * - 干活/对话类默认开：twinMain、twinSubagent、subagentCoder、scheduledRun、twinBackground
 * - 简单/廉价判断类默认关：conversationTitle、memoryRecall、loopReviewer、conversationSummary、
 *   memoryDream、loopCompile、asideComment（这些用途代码里本就刻意关思考省钱，默认关保住"要快"不变量）
 */
export function defaultModelThinking(): ModelThinking {
  return {
    twinMain: true,
    twinBackground: true,
    memoryDream: false,
    subagentCoder: true,
    conversationSummary: false,
    conversationTitle: false,
    twinSubagent: true,
    asideComment: false,
    loopReviewer: false,
    memoryRecall: false,
    scheduledRun: true,
    loopCompile: false,
  };
}

// ─── Loop 模式：检查清单 ───────────────────────────────────
//
// 通用收敛 loop 的"标准"载体。AI 把目标拆成一份可溯源 checklist，每轮干完活由独立审查员逐项判。
// 跨进程类型（活动卡要呈现），故落在 shared；内核 deps / Evidence / Outcome 是主进程契约，留 runLoop.ts。
// 通用层技术设计：docs/tech/2026-06-19-loop-mode-tech-design.md（决策 4/5）。

/**
 * Loop 验收标准单项状态（v3 可见循环）——只有达标没达标两态。v2 的第三态 held（挂起状态机）
 * 随逐项锁定 / 交棒机制整体退场（见 docs/tech/2026-07-24-loop-v3-可见循环重构实施方案.md §1）。
 */
export type ChecklistItemStatus = 'pending' | 'satisfied';

/**
 * Loop 验收标准单项（v3）——AI 把目标拆出的「算达标的样子」，审查员读对话记录逐项盲判。
 * v2 的 source/quote 出处字段、hard/review 分流、deps 拓扑、held 状态机全部退场（§1/§3.4）：
 * 现在每项只剩「算达标的样子 + 达标没达标 + 打回理由」，全走审查员判。
 */
export type ChecklistItem = {
  id: string;
  /** 人话的"算达标的样子"。 */
  statement: string;
  status: ChecklistItemStatus;
  /** 审查员这一项的打回理由（pending 时供下一轮 nudge 回喂与卡面呈现；satisfied 可留通过说明）。 */
  verdict?: { reason: string };
};

/**
 * 中途改标准（v3 保留「改标准·下一轮生效」）——用户在伴随卡上对运行中的清单发起的一次编辑意图。
 * 入队、下一轮边界生效（不打断当前轮，避免半轮清单跳变）。三形：加一项 / 划掉一项 / 改一项措辞。
 */
export type ChecklistEdit =
  | { op: 'add'; item: { statement: string } }
  | { op: 'remove'; id: string }
  | { op: 'revise'; id: string; statement: string };

/**
 * Loop 收工原因（v3 三去向的三个终态，「继续」不入枚举）。
 * - 'all-satisfied' 收敛：全部达标
 * - 'max-rounds'    到轮数上限中止
 * - 'user-stopped'  用户叫停（当前轮收尾、不起下一轮）
 * - 'clarify'       拆解阶段反问收场：目标拆不出可核验判据，Oru 在对话里向用户提了问题，
 *                   loop 没开跑（安静终态，非失败——2026-07-28 loop 去特殊化 T1）
 */
export type LoopStopReason = 'all-satisfied' | 'max-rounds' | 'user-stopped' | 'clarify';

/**
 * Loop 伴随卡阶段——驱动卡片状态呈现。
 * 'compiling'：编译验收标准中；'running'：循环进行中（干活在主对话流可见，卡只呈现逐项 verdict）；
 * 'done'：终态（收敛/中止/用户停，据 stopReason 分呈现）；'failed'：真报错翻红；
 * 'interrupted'：跨重启认出半截 loop 的纯陈列终态（停在第几轮、达标到哪）——想继续再发一条带
 *   Loop 标记的「继续」（2026-07-28 T3 起无续/弃决策交互）。
 */
export type LoopPhase = 'compiling' | 'running' | 'done' | 'failed' | 'interrupted';

/**
 * /loop 伴随卡的实时状态（ChatMessage.loopCard）。一条 kind='loop-checklist' 消息承载整份验收标准
 * + 阶段；运行中同 id 反复覆盖更新，终态定格落盘。干活过程本身在主对话流里可见，卡不承载 activity。
 */
export type LoopCardPayload = {
  loopId: string;
  goal: string;
  phase: LoopPhase;
  /** 当前轮（0=编译/首轮前）。 */
  round: number;
  /** 轮数上限（护栏，不上屏——常驻条只显示「第 X 轮」，2026-07-28 拍板去分母）。 */
  maxRounds: number;
  checklist: ChecklistItem[];
  /** 终态才有：收工原因。 */
  stopReason?: LoopStopReason;
  /** 失败时的错误。 */
  error?: string;
  /**
   * 终态时刻（终态卡携带并落盘）。常驻条「终态陈列到下一条消息为止」靠它客观派生——
   * 比这个时刻新的消息一出现即退场，跨切会话/重启语义一致。老数据无此字段 → 视为早已退场。
   */
  endedAt?: number;
};

/**
 * Loop 运行态快照（跨重启轻量恢复）——每轮边界落盘、重启后认出「有个循环跑到一半」交用户续/弃。
 * 与后台任务登记表 / scheduledTasks 的 reconcileOnBoot 同思想。v3 砍掉派工账本与通病标准，
 * 快照只留重建编排状态所需的最小集。终态（收敛/中止/停止/失败）删快照。
 */
export type LoopRunState = {
  /** 快照格式版本——boot 读时版本不符即弃（半截运行态不值得迁移，弃了只丢一次续跑机会、不损坏数据）。 */
  version: number;
  loopId: string;
  conversationId: string;
  agentId: string;
  goal: string;
  round: number;
  checklist: ChecklistItem[];
  updatedAt: number;
};

// ─── Memory: dream 复盘一次的结局 ───────────────────────────────────

/**
 * dream "一次尝试" 的结局——同时覆盖 runDream（LLM/磁盘）和 scheduler（并发保护）两层。
 * 三态严格分离（kind 判别），消除 "ok=true 但 counters 全 0" 这类 patchwork 形状。
 *
 * - 'ok'：真的跑了 LLM 并应用了输出（counters 可全 0，意思是 LLM 真没产出）
 * - 'skipped'：没真跑 LLM，原因如下：
 *    - 'no-new-conversations'：自上次复盘以来没新对话（runDream 早返回）
 *    - 'concurrent-run'：scheduler 检测到 inFlight，本次让位
 *    - 'stopped'：去抖等待期间 scheduler 被 stop()（退出），本次取消
 *    - 'debounce-pending'：已有去抖 timer 在等，本次让位（pending 那次必跑）
 *    - 'window-not-missed'：启动/daily 追跑判据——最近一个 03:00 窗口没错过，无需补跑
 *    - 'no-new-episodes'：错过了窗口但自上次复盘以来没有新 episode，无需补跑
 * - 'failed'：runDream 内部把所有抛错兜成这个；scheduler 据此决定不推进游标
 *
 * 单一定义；electron / shared/protocol / UI 都 import 这里——加 variant 一处即可。
 */
export type DreamRunOutcome =
  | {
      kind: 'ok';
      /** 合并 episode 的条数（包括 mergeFrom 中的被合并条目） */
      episodesMerged: number;
      /** user-profile 事实段增/改/删的总次数 */
      userFactsChanged: number;
      /** project-profile 三段（基本/约定/进度）变动总次数 */
      projectFieldsChanged: number;
      /** 写过的 long-form 文件相对路径列表 */
      profileWrites: string[];
    }
  | {
      kind: 'skipped';
      reason:
        | 'no-new-conversations'
        | 'concurrent-run'
        | 'stopped'
        | 'debounce-pending'
        | 'window-not-missed'
        | 'no-new-episodes';
    }
  | { kind: 'failed'; error: string };

// ─── Memory v2 类型 ────────────────────────────────────────
// EpisodeFrontmatter / IndexLine 的 shared 副本已退役（生产权威版本在 electron/main/memory/store.ts，
// shared 副本早已漂移且零引用，2026-07-13 清理审计）；下面两个枚举仍是跨层单一事实源。

/** Episode 五类——参考 Claude auto-memory 四类 + Oru 特有 agent */
export type EpisodeType = 'user' | 'feedback' | 'project' | 'reference' | 'agent';

/**
 * Episode 四态：active 活跃 / superseded 被合并取代 / archived 超期归档 /
 * retired 被 dream 按守则出清（可逆标记，不进活跃召回）
 */
export type EpisodeStatus = 'active' | 'superseded' | 'archived' | 'retired';

// MemoryUserProfile（user/profile.md 两段式 {facts, portrait}）已退役——用户档案改用自由分章
// 文档模型（shared/memory/profileDoc.ts 的 ProfileDoc + parseProfileDoc）。
// MemoryProjectProfile 暂留（HomePage 经 memory.projectProfile.read 仍消费），待其迁移到文档模型后一并退役。

/** Memory v2: projects/<id>/profile.md 解析形态（三段） */
export type MemoryProjectProfile = {
  basic: string[];
  conventions: string[];
  progress: string;
};

/** Memory v2: 项目列表条目（list-entry.md + profile.md frontmatter 聚合） */
export type ProjectListEntry = {
  projectId: string;
  intro: string;          // list-entry.md 全文（可多行）
  introSnippet: string;   // 收起态用：首行首句号 / 60 字截断
  lastUpdated: string;    // ISO date 字符串，从 profile.md frontmatter 读；缺省 ''
};

/** Memory v2: episode 携带正文的轻量形态（演化反查给前端用） */
export type EpisodeWithBody = {
  relPath: string;
  title: string;
  date: string;     // YYYY-MM-DD（取自 frontmatter.created）
  body: string;
};

// ─── Agent / Conversation / Task ────────────────────────────────────

export type Agent = {
  id: string;
  /** 数据归属用户 id；MVP 阶段固定 'local-user'，未来多用户时实际填充 */
  ownerId: string;
  name: string;
  /** 分身的家目录，绝对路径；SDK cwd 始终指向此处 */
  homePath: string;
  /** 追加到 systemPrompt 末尾的人格补丁；通常 null（让家里 CLAUDE.md 自动通过 settingSources 加载） */
  systemPromptAppend: string | null;
  /** 审批挡位：readonly=只读硬约束（写类直接拒）/ work=破坏性才问 / danger=全放（仅火灰断路器与首次授权拦） */
  approvalMode: ApprovalMode;
  createdAt: number;
  /** 头像图片绝对路径；null 表示用默认头像（暖米圆 + 衬线 "T"） */
  avatarPath: string | null;
};

/**
 * 审批挡位（审批模式 PRD + 只读重构）——三态硬约束。
 * readonly=只读硬约束（写文件 / 写类命令 / 装 MCP 插件 / 写技能一律直接拒，不弹卡；只读命令放行）；
 * work=破坏性才问（开箱默认）；danger=全放（仅火灰断路器/首次授权拦）。
 * 旧 'strict'（什么都问）退场，存量映射到 work（store/agents.ts rehydrate）。
 */
export type ApprovalMode = 'readonly' | 'work' | 'danger';

// 'main'（永久置顶不可删的主对话）已取消（对话栏整理 2026-06-19）——延续由记忆接管，
// 列表是时间日志。存量 main 由 store.loadIndex 迁移成 sub（保历史），运行时不再有 main。
export type ConversationKind = 'sub' | 'taskboard-comment' | 'aside';

export type Conversation = {
  id: string;
  /** 数据归属用户 id；MVP 阶段固定 'local-user'，未来多用户时实际填充 */
  ownerId: string;
  agentId: string;
  kind: ConversationKind;
  title: string;
  /** SDK 给出的 session_id；首次为 null，之后续传用 */
  sdkSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 仅当 kind === 'taskboard-comment' 时有值；指向 BoardTask.id */
  boardTaskId?: string;
  /**
   * 三方平台来源（三方平台接入 §4.2）——平台会话带 {platform,chatId}，桌面会话恒空。
   * 「认得出哪条来自飞书 / Discord」的唯一依据；也是 getOrCreateConversation 的查找键。
   */
  source?: { platform: 'feishu' | 'discord'; chatId: string };
  /**
   * 归档时刻（毫秒时间戳）。无值=活跃（参与今天/本周/更早时间分桶）；有值=已归档
   * （退出时间分桶、收进独立「已归档」区）。自动归档写入、发消息/清空时清除。仅 kind:'sub' 用。
   */
  archivedAt?: number;
  /**
   * 已读水位（毫秒时间戳）——打开对话即写（通知中心 / 对话列表两路都算验收）。
   * `updatedAt > lastSeenAt`（或缺省）即未读：通知中心"已完成(待验收)"段与列表 unread 标记
   * 共读这一对 (state==='done', seen)，是"两视图一处判定"的已读轴（见 conversationStatus.ts）。
   * 与 archivedAt 正交——已完成 ≠ 已归档。
   */
  lastSeenAt?: number;
  /**
   * 折叠水印（S16 G63）——「此消息之前的工具回执按折叠规则呈现」。纯视图参数（不进 UI 回放、
   * 不是一条消息），只在上下文整理时刻由 computeFoldWatermark 前移。回合装配按此水印折叠，
   * 两次整理之间不动、折叠前缀逐字节稳定，不每轮碎 prompt cache。缺省=无折叠。
   * 语义见 applyTier1Folding.ts 与实施方案 §3.4/§5。
   */
  foldedBeforeMessageId?: string;
};

export type ProposalRisk = 'low' | 'medium' | 'high';

/**
 * Proposal 生命周期状态（v0.6 引入）—— pending = 待审批；executing = 已批准、工具执行中
 * （仅同步审批 kind：bash / file.write）；executed/failed/rejected = 已落定。
 * 合法流转由 proposals/lifecycle.ts 状态机收口。
 */
export type ProposalStatus = 'pending' | 'executing' | 'executed' | 'failed' | 'rejected';

/** 所有 proposal 共享的基础字段 */
type ProposalBase = {
  id: string;
  /** 数据归属用户 id；MVP 阶段固定 'local-user'，未来多用户时实际填充 */
  ownerId: string;
  conversationId: string;
  title: string;
  /** 自然语言；用户能看懂的描述 */
  description: string;
  createdAt: number;
  status: ProposalStatus;
  /** status 非 pending 时落定的时间 */
  completedAt?: number;
  /** status === 'failed' 时的错因 */
  failureMessage?: string;
  /**
   * 对话期 subagent 触发的 proposal（subagent 调 propose_action 等写类工具时）。
   * 主 agent 自己触发的 proposal 该字段 undefined。
   * 前端按此字段在审批卡文案上追加一行 "subagent: <description>" 让用户知道是谁触发的。
   */
  triggeredBySubagent?: {
    taskId: string;
    description: string;
  };
  /**
   * 定时任务后台执行体触发的 proposal（S18）：执行体撞到要审批的命令时，审批卡回流承载对话，
   * 前端据此在卡上标注「来自定时任务〈标题〉」。主 agent / subagent 触发时该字段 undefined。
   */
  triggeredByScheduledTask?: {
    taskId: string;
    title: string;
  };
  /**
   * 通用字段（决策 6.4b）：标记"即使无审批也强制确认"。router 的自动执行判据统一为
   * `!requireApproval && !forceApproval`。bash 破坏性命令/未授权时置 true；非 bash 专属，
   * 未来任何工具要"强制确认"零成本复用。
   */
  forceApproval?: boolean;
  /**
   * 对外投递目标（S04 投递档）：存在即「向环境之外的人或服务送出内容」的提案——
   * 只读挡拒、工作挡弹卡（emit 端置 forceApproval）、全放挡放行（2026-07-10 P1 拍板）。
   * 约定：置此字段必为非空数组（构造方保证）。S24 按 deliveryGrantKey（渠道+收件人）做
   * 「始终允许」持久授权，S26 送达收口按此字段识别批准后须经送达内核的外发。
   */
  delivery?: DeliveryTarget[];
  /**
   * 可「始终允许」持久授权的后果 scope（S24 · G30）。构造方按 kind 声明本提案哪些后果可整类/按
   * 收件人免卡（破坏性命令→destructive、未知命令→unknown、覆盖→overwrite、装卸/定时/删除/访问
   * 网站→category、外发→每目标一个 delivery）。emit 端据它查 grants store：**全部 scope 已授权
   * 才免卡**（合取）；灾难级（catastrophic）不声明、永不免卡。
   * 空/undefined = 无可授权后果（本提案只能「仅此一次」）。一条提案挂多个 scope 仍是一张卡，
   * 「始终允许」一次性写入全部（见 S24 实施方案 §4.1）。
   */
  grantable?: GrantScope[];
  /**
   * 留痕卡：这张卡不承载审批，只记录「装了什么」（来源仓库、commit、env 等供用户过目那一屏）。
   * 装卸类在全放挡下不弹审批卡，界面痕迹会归零——它补上那一屏，故**恒以终态广播**、不进
   * proposals 注册表、不参与任何决定。前端据此不给按钮、终态行也不说「已批准」（从没有人批准过它）。
   */
  trace?: true;
};

/**
 * 可「始终允许」持久授权的后果类别（S24 · G30）——与挡位正交的「后果 × 授权状态」轴
 * （approval.html:141）。单例整类（destructive/unknown/overwrite 各一个稳定键）、category
 * 参数化整类（决策 7 的六个新类别收进一个分支，「加第 N 类」只加一个 id）、delivery 是
 * 开放集合（按收件人＋渠道无限扩），故用带判别式的记录而非布尔——让「已授权清单」能逐条
 * 列出、逐条撤销。稳定键由 shared/proposals/grantKey.ts 的 grantKey() 单源生成（工具侧与
 * 设置页共用）。
 *
 * 2026-07-30 行为分类拍板（决策 5/6/7）：{command} 命令能力门取消、scope 退役（旧授权
 * 由 grants store 加载时清理）；「看不透」从 {destructive} 拆出为 {unknown}（未知命令）；
 * category 承载装卸/定时/删除/访问网站六个整类。2026-07-31 加 sendExternal 外发总开关（第七类）。
 */
export type GrantScope =
  | { kind: 'destructive' } // 破坏性命令（整类）
  | { kind: 'unknown' } // 未知命令：看不透、无法静态分析的命令（整类）
  | { kind: 'overwrite' } // 覆盖用户文件（整类，含编码转换）
  | { kind: 'category'; id: GrantCategoryId } // 行为整类（装卸/定时/删除/访问网站/外发总开关）
  | { kind: 'delivery'; channel: string; recipient: string }; // 外发（收件人＋渠道），键取自 deliveryGrantKey

/** category scope 的类别 id（决策 7 开放的整类授权）——数组是唯一事实源：
 *  类型 union 与 grants store 的运行时校验（isValidScope）都从它派生，加第 N 类只改这里。 */
export const GRANT_CATEGORY_IDS = [
  'mcp', // 装卸 MCP server
  'plugin', // 装卸 / 升级插件
  'skillInstall', // 安装 Skill
  'scheduledTask', // 定时任务新建 / 修改 / 删除·暂停·启用
  'fileDelete', // 删除文件（回收站可恢复）
  'webAccess', // 访问网站（模型自拟地址的抓取 / 打开）
  'sendExternal', // 外发总开关（2026-07-31 PM 拍板）：所有外发免卡，默认关；按收件人授权维持为默认
] as const;
export type GrantCategoryId = (typeof GRANT_CATEGORY_IDS)[number];

/** 一条已授权记录（落 grants.json，设置页可见可撤销）。 */
export type Grant = {
  scope: GrantScope;
  grantedAt: number;
  /** 已授权清单展示用：授权时那类操作的人话标签（"破坏性命令" / "向 飞书:研发群 外发"）。 */
  label: string;
};

/**
 * 审批决定的落盘存证（S24 · G130）——kind:'proposal' 消息承载**决定终态**、不承载执行。
 * 一条提案落一条，immutable（决定即终态，不再改写）。重启后内存 Map 空，历史里这条照样自洽。
 */
export type ProposalRecord = {
  proposalId: string;
  decision: 'approved' | 'rejected';
  /** 谁准的：本人桌面 / 某渠道身份（跨渠道送达时是平台侧点击者）。 */
  by: { source: 'desktop' } | { source: 'channel'; platform: Platform; userId: string };
  /** 落盘那一刻的卡片摘要（命令段 / 文件路径 / 投递目标），脱离内存 Map 也能读懂这条决定。 */
  summary: string;
  decidedAt: number;
  /**
   * 「始终允许」写盘失败（decision==='approved' 时才有意义）——本次已执行、但持久授权未能保存，
   * 存证卡据此提示「始终允许未能保存，下次仍会询问」，不假装持久成功（S24 §4.2）。
   */
  grantPersistFailed?: boolean;
};

/**
 * 对外投递目标（S04）——网络请求 channel='web'（recipient=host），渠道 CLI 写命令
 * channel=渠道名（recipient=收件人 id）；静态提不出收件人时 recipient=null（不可持久授权）。
 */
export type DeliveryTarget = {
  channel: 'web' | 'feishu' | (string & {});
  recipient: string | null;
  /** 审批卡展示：完整 URL / 命令段摘要 */
  label: string;
};

/** 代码改动 proposal（既有）—— 接受后派子 agent 改代码 */
export type CodeActionProposal = ProposalBase & {
  kind: 'code';
  /** 目标项目；null 表示在分身家目录内的操作 */
  targetProjectId: string | null;
  risk: ProposalRisk;
  rollbackable: boolean;
  /** 给执行子 agent 的实际 prompt */
  rawPlan: string;
  /** 派工到哪个 ExecutorProfile，缺省 'project-coder' */
  profileId?: string;
  /**
   * Deck 编辑 / 生成上下文（Deck 模块 v1）。
   * subagentRunner 拼 system prompt 时若此字段存在 → 注入 deck 编辑规则段
   * （含"保留 data-edit-id"约定 + final text 末尾输出 markerIdMap fenced JSON）。
   * 不进 deck 编辑流程的 code proposal 此字段为 undefined。
   */
  deckContext?: {
    artifactId: string;
    deckPath: string;
    /** 生成场景必填；编辑场景可省 */
    deckSkillId?: string;
  };
};

/** 安装一个新 MCP server（v0.6）*/
export type McpInstallProposal = ProposalBase & {
  kind: 'mcp.install';
  config: McpServerCreateInput;
};

/** 修改现有 MCP server 配置（v0.6）—— 含启停（patch.enabled） */
export type McpUpdateProposal = ProposalBase & {
  kind: 'mcp.update';
  serverId: string;
  patch: McpServerPatch;
  /** propose 时刻的配置快照——卡片渲染 before/after diff */
  before: McpServerConfig;
};

/** 删除 MCP server（v0.6）*/
export type McpDeleteProposal = ProposalBase & {
  kind: 'mcp.delete';
  serverId: string;
  /** 删除时刻 server 的精简快照——卡片展示用，不含 env value */
  target: Pick<McpServerConfig, 'label' | 'description'> & {
    runtimeStatus?: McpServerStatus;
    toolCount?: number;
  };
};

/** Plugin 安装（Skill 模块 v1）—— git clone GitHub repo 装一个 plugin */
export type PluginInstallProposal = ProposalBase & {
  kind: 'plugin.install';
  /** plugin.json manifest（来自上游 repo） */
  pluginManifest: { name: string; description: string; version?: string };
  /** GitHub 源 + 锁定 commit hash */
  source: { type: 'github'; url: string; commit: string };
  /** plugin 内含 skill 的轻量元数据（审批卡展示） */
  containedSkills: Array<{ name: string; description: string }>;
  /** plugin 内含 MCP server 的轻量元数据（审批卡展示） */
  containedMcpServers: Array<{ name: string; command: string; args?: string[] }>;
  /** 是否含 scripts/ 目录（审批卡提示"含可执行脚本"） */
  containsExecutableScripts: boolean;
  /** 装的时候 UI 明示忽略的段落（commands/agents/hooks/bin） */
  ignoredSections: string[];
  /** 同名 MCP 冲突；用户在审批卡上对每条选三选项（覆盖 / 跳过 / 并存） */
  mcpConflicts?: Array<{
    existing: McpServerConfig;
    incoming: { name: string; command: string; args?: string[] };
  }>;
};

/** Plugin 升级（Skill 模块 v1） */
export type PluginUpdateProposal = ProposalBase & {
  kind: 'plugin.update';
  pluginId: string;
  fromCommit: string;
  toCommit: string;
  /** 升级 diff 摘要（key 文件给 patch，其余只数文件数） */
  diffSummary: {
    keyFiles: Array<{ path: string; patch: string }>;
    otherFilesCount: number;
    /** 中间 commit message 列表（折叠区） */
    commitMessages?: string[];
  };
};

/** Plugin 卸载（Skill 模块 v1） */
export type PluginUninstallProposal = ProposalBase & {
  kind: 'plugin.uninstall';
  pluginId: string;
  /** 副作用检查结果（UI 卡上提示） */
  sideEffects: {
    /** 这个 plugin 在当前 conversation 激活过 */
    activatedInConversation: boolean;
    /** 即将卸载的 plugin 内 MCP 被某个 skill 引用 */
    dependentSkills: string[];
    /** 阻止卸载：plugin 内 MCP 被其他 plugin / 独立 skill 引用——必须先卸依赖方 */
    blockingDependents: string[];
  };
};

/** 分身把工作流存为新 skill（Skill 模块 v1 加分项） */
export type SkillCreateProposal = ProposalBase & {
  kind: 'skill.create';
  skillName: string;
  /** 从 SKILL.md frontmatter 抽出的 description，用户可在审批卡上改 */
  skillDescription: string;
  /** SKILL.md 全文 */
  skillMd: string;
  /** 可选 scripts/ 目录内容（路径相对 scripts/） */
  scripts?: Array<{ relPath: string; content: string }>;
};

/** 分身对已有 skill 做 find-and-replace 小修（Skill 模块 v1 加分项） */
export type SkillPatchProposal = ProposalBase & {
  kind: 'skill.patch';
  /** patch 的目标：'skill' 改 ~/.oru/skills/<name>/SKILL.md；'plugin-manifest' 改 .oru-plugin.json 的 activationDescription */
  target: 'skill' | 'plugin-manifest';
  /** target='skill' 时 = skillName；target='plugin-manifest' 时 = pluginId */
  name: string;
  oldString: string;
  newString: string;
  /** 渲染审批卡 before/after 的预览（最多前后各 200 字符） */
  diffPreview: string;
  /**
   * patch 完成后目标对象的 description 文本（SKILL.md frontmatter.description /
   * plugin .activationDescription）。审批卡始终展示并允许用户改写——
   * 落定时若用户改了，asyncExec 会以此覆盖目标文件的 description 字段。
   * 注意：跟 ProposalBase.description（卡片标题下的自然语言）不同——后者描述"这次 proposal 干啥"。
   */
  targetDescription: string;
};

/**
 * 从外部源（GitHub repo）装一个独立 skill —— 装进 ~/.oru/skills/<skillId>/，扫为 standalone。
 * 通用能力（不为 deck skill 单开后门）：deck 引导安装、未来任意三方 skill 都经它装。
 * 与 plugin.install 的区别：不要求 .claude-plugin/plugin.json，只认 SKILL.md。
 */
/** skill 安装来源：GitHub 仓库（clone）或本地文件夹（直接 copy） */
export type SkillInstallSource =
  | { type: 'github'; url: string; commit: string }
  | { type: 'local'; path: string };

export type SkillInstallProposal = ProposalBase & {
  kind: 'skill.install';
  /** 装进 ~/.oru/skills/<skillId>/ 的裸文件夹名 = 注册表 id（read_skill 按此解析） */
  skillId: string;
  /** SKILL.md frontmatter 元数据（审批卡展示） */
  skillManifest: { name: string; description: string };
  /** 来源：GitHub（clone 后装）或本地文件夹（直接 copy 装，path 已指到 SKILL.md 所在目录） */
  source: SkillInstallSource;
  /** SKILL.md 在 repo 内的相对目录（'' = repo 根；如 'skills/foo'）——装时复制该目录为 skill 根 */
  skillSubdir: string;
  /** 协议（清单候选带；自由仓库可空） */
  license?: string;
};

/**
 * Deck 创建提案（Deck 模块 v1）—— 用户审批后 asyncExec 转换成 CodeActionProposal
 * 派 subagent 跑 deck skill 生成 HTML。详见 docs/tech/2026-05-26-html-deck-tech-design.md §9.3。
 */
export type DeckCreateProposal = ProposalBase & {
  kind: 'deck.create';
  /** 用户层显示名；目录名 = sanitizeDeckName(deckName) + 重名后缀 */
  deckName: string;
  /** 目标项目；null 用 active 项目 */
  targetProjectId: string | null;
  /** 缺省走 DEFAULT_DECK_SKILL_ID（见 deckSkillCatalog）；模型可显式指定其它已装 deck skill */
  deckSkillId: string;
  /** 一段话讲清要做什么 deck——风格 / 受众 / 页数 / 主题 / 是否含图。propose 卡 description 用，subagent 种子 prompt 也用 */
  brief: string;
  /** 页数 + 图数预估，如"≈ 12 页 · 8 张图"——propose 卡显示 */
  sizeHint: string;
  /** 预估时长，如"5 分钟"——propose 卡显示 */
  etaHint?: string;
  /**
   * 主对话模型起草的叙事文稿全文（markdown）——"要讲什么 / 怎么递进 / 每段核心"。
   * 随提案带上，executeDeckCreate 写进 deck 的 .narrative.md 作为生成依据。
   */
  narrative: string;
  /**
   * 是否起草后直接生成。
   * - true：建壳 + 派 subagent 生成（信任模式 / 用户有"直接生成"偏好）。
   * - false：只建壳停下，文稿可见可改，等用户过目后再 generate_deck。
   */
  autoGenerate: boolean;
};

/**
 * 本地文件写操作提案（本地操作工具）—— write_file / edit_file / manage_files(delete) 共用。
 * 与 CodeActionProposal 不同：不走 git / 不派 subagent，落盘内核直接由 executeFileWriteProposal 执行。
 * 防盲覆盖守卫（fileState）独立于审批——执行器落盘前还会复检一次。
 */
export type FileWriteProposal = ProposalBase & {
  kind: 'file.write';
  path: string;
  /**
   * append 不是 overwrite 的特例，是独立的一种写（S02 记账口径）：它只往末尾加、动不了已有内容，
   * 所以既不强制审批（同 edit），也**不建立整篇所有权、不记成模型已读**——模型只供了尾巴那一段，
   * 没见过整篇。混进 overwrite 会让「追加一行」附带解锁「整篇覆盖免审」，并让随后的 read_file
   * 命中去重 stub 拿不到内容。
   */
  mode: 'create' | 'overwrite' | 'edit' | 'append' | 'delete' | 'move' | 'rename';
  /** move（S32·G49）：目标目录绝对路径（须与源同项目内）。执行走项目相对的 mutate 内核，含 .md+.assets 联动 + 历史迁移。 */
  destDir?: string;
  /** rename（S32·G49）：新文件名（仅名、不含路径分隔符）。 */
  newName?: string;
  /** create/overwrite 时的完整新内容 */
  content?: string;
  /** edit 时的原片段（已经 findActualString 截出的原样片段） */
  oldString?: string;
  /** edit 时的新片段（已 preserveQuoteStyle 处理） */
  newString?: string;
  /** edit 是否全替 */
  replaceAll?: boolean;
  /** append 要追加的那一段（拼接在锁内做，故存原始尾巴而非拼好的整篇——审批窗口期别人也追加时两笔都不丢） */
  appendText?: string;
  /** 审批卡视觉用的旧→新 unified diff（overwrite/edit） */
  diff?: string;
  /**
   * 卡面警示：这次写入带不可逆的副作用，用户点确认前必须知情（决策 7：随覆盖同口径弹卡、
   * 并入 {overwrite} 整类授权，警示一行保留）。
   * 枚举而非自由文本——文案归渲染层 i18n（与卡上其余字一个语言域），main 侧只交代是哪一类。
   */
  caution?: FileWriteCaution;
};

/** 目前只有编码转换一种：GBK/BOM → UTF-8 会重写全文件字节，原编码回不来。 */
export type FileWriteCaution = 'encoding-conversion';

/**
 * bash 命令执行提案（本地操作工具，决策 6）—— 在用户电脑跑命令。
 * 破坏性 / 未知命令 / 覆盖 / 对外投递时 emit 端置 forceApproval=true，
 * 让 router 即使无审批也停下等确认（命令能力门 2026-07-30 拍板取消，决策 6）。
 */
export type BashProposal = ProposalBase & {
  kind: 'bash';
  command: string;
  /** 人话描述（卡片展示） */
  description?: string;
  isDestructive: boolean;
  /** 只读判定（白名单 fail-closed）：true=纯查询命令（ls/cat/git log…），只读挡下放行；
   *  false=写类或看不透，只读挡下直接拒。emit 端由 isReadOnlyCommand 填充（只读重构 PRD）。 */
  isReadOnly: boolean;
  /** 拆分后的段，供卡片在命令框内染红危险段；opaque=整条「看不透」（未知命令，卡片据此归类） */
  segments: Array<{ text: string; destructive: boolean; reason?: string; opaque?: boolean }>;
  timeout?: number;
  runInBackground?: boolean;
  /** 执行 cwd（emit 时定，= active 项目根 ?? agent 沙盒）——与路径硬防线解析相对路径用的 cwd 一致 */
  cwd?: string;
  /** 命令引用的脚本声明的输出文件中**已存在**的（emit 时判）——卡片升级覆盖确认态（红框提示将覆盖） */
  overwriteTargets?: string[];
  /** 火灰断路器命中（删根/家、抹盘、格式化）——危险模式也硬拦；emit 端由 isCatastrophic 置（审批模式 PRD） */
  catastrophic?: boolean;
};

/**
 * 网页抓取提案（S04 投递档）：web_fetch 抓模型自拟地址时走同步审批（proposeOrExecute），
 * 与 bash/file.write 同一条流水线、不进 asyncExec。地址逐字来自用户消息的抓取不构造提案。
 */
export type WebFetchProposal = ProposalBase & {
  kind: 'web.fetch';
  url: string;
};

/**
 * 浏览器打开网页提案（S33 浏览器操控）：browser_navigate 要进模型自拟的站点时走同步审批，
 * 判定口径与 web.fetch 完全同族（对外投递、按域名可持久授权）；页面内交互（click/type 等）
 * 不构造提案——审批锚在「进站」（PM 2026-07-12 拍板）。
 */
export type BrowserNavigateProposal = ProposalBase & {
  kind: 'browser.navigate';
  url: string;
};

/**
 * 定时任务写操作提案（Oru 在对话中建/改/删定时任务时）。走与 bash/file.write 同一条
 * 同步审批流水线（proposeOrExecute + 工具 execute 闭包），不派 subagent、不进 asyncExec。
 * draft 是已过 validateSpec 的任务草稿；delete/pause/resume 只需 taskId。
 */
export type ScheduledTaskProposal = ProposalBase & {
  kind: 'scheduled-task';
  action: 'create' | 'update' | 'delete' | 'pause' | 'resume';
  taskId: string;
  draft?: ScheduledTask;
  /** 多触发规则时逐条列出（create/update）——提案卡按它逐条展示频率；单规则/删停可缺省走 draft。 */
  rules?: { spec: ScheduleSpec; stopAfterRuns?: number; nextRunAt: number | null }[];
};

/**
 * 飞书文档写操作提案（S2 lark-cli 工具化）：feishu_doc 的 create/update 走 proposeOrExecute
 * 统一流水线。对齐其他写工具（write_file）：不置 forceApproval——工作/全放挡直执行、
 * 只读挡拒；不挂行为行（behaviorForProposal 默认分支）。卡片因此永不 emit，
 * 走这条流水线的意义是「只读拒」切面与口径统一，不是弹卡。
 */
export type FeishuDocProposal = ProposalBase & {
  kind: 'feishu.doc';
  op: 'create' | 'update';
  /** 写作用的身份：user=文档归本人（默认）；bot=归应用（CLI 会尝试自动授权本人） */
  identity: 'user' | 'bot';
  /** 目标文档 URL/token（update） */
  doc?: string;
  /** 文档标题（create，展示用） */
  title?: string;
};

export type ActionProposal =
  | CodeActionProposal
  | ScheduledTaskProposal
  | McpInstallProposal
  | McpUpdateProposal
  | McpDeleteProposal
  | PluginInstallProposal
  | PluginUpdateProposal
  | PluginUninstallProposal
  | SkillCreateProposal
  | SkillPatchProposal
  | SkillInstallProposal
  | DeckCreateProposal
  | FileWriteProposal
  | BashProposal
  | WebFetchProposal
  | BrowserNavigateProposal
  | FeishuDocProposal;

/** mcp.create RPC 和 McpInstallProposal 共用的"创建 server 的入参"——避免协议层重复定义 */
export type McpServerCreateInput = Omit<
  McpServerConfig,
  'id' | 'lastStatus' | 'lastError' | 'lastConnectedAt'
>;

/** mcp.update RPC 和 McpUpdateProposal 共用的"可改字段"——避免协议层重复定义 */
export type McpServerPatch = Partial<
  Pick<McpServerConfig, 'label' | 'description' | 'command' | 'args' | 'env' | 'probeTool' | 'enabled'>
>;

// ─── Skill 模块（v1）──────────────────────────────────────────────
//
// 三个对外概念：Plugin / Skill / MCP（MCP 复用既有 McpServerConfig）。
// 详细说明见 docs/prd/2026-05-24-skill-module-prd.md + docs/tech/2026-05-24-skill-module-tech-design.md。

/** 单条 skill 的注册表记录——独立装 / plugin 内 / 内置三种来源 */
export type SkillRecord = {
  /** standalone / builtin 用 folder name；plugin 内用 `${pluginId}:${skillName}` */
  id: string;
  /** SKILL.md frontmatter 的 name */
  name: string;
  /** SKILL.md frontmatter 的 description */
  description: string;
  /** 绝对路径，指向 skill 文件夹（含 SKILL.md） */
  path: string;
  source: 'standalone' | 'plugin' | 'builtin';
  /** source='plugin' 时指向父 plugin id */
  parentPluginId?: string;
  /**
   * 回声防护：skill 写入 / patch 完成时设为 Date.now()。
   * resolveSkill 在 conversation 内拉取时校验：availableFromTimestamp <= conversation.createdAt 才可见。
   * 避免分身刚自创 skill 立即被自己写的 skill 影响判断。
   */
  availableFromTimestamp: number;
  /**
   * 用户在设置页关掉了这个 skill → 不进 stable system prompt，分身看不到。
   * 仅 standalone / builtin 可自由切换；plugin 内 skill 永远等于其父 plugin 的 enabled，
   * 单独 set 会被 router 拒掉（避免 plugin 升级后状态错位）。
   * 缺省视同 true（首次扫盘 / 老数据兼容）。
   */
  enabled: boolean;
};

/** 单个 plugin 的注册表记录 */
export type PluginRecord = {
  id: string;
  /** plugin.json manifest（上游 repo 自带） */
  manifest: { name: string; description: string; version?: string };
  /** Oru 扩展段——本地装入时由 installer 写入 .oru-plugin.json */
  oruExtension: {
    /** 运行时给 LLM 判断的激活描述；缺省 fallback manifest.description */
    activationDescription?: string;
    source: { type: 'github'; url: string; commit: string };
    installedAt: number;
  };
  skills: SkillRecord[];
  mcpServers: McpServerConfig[];
  /** 装的时候 UI 明示忽略的段落（commands/agents/hooks/bin） */
  ignoredSections: string[];
  /** 用户在拓展页关掉了这个 plugin → stable system prompt 不列出，分身看不到激活机会 */
  enabled: boolean;
};

/**
 * Skill 模块 v1：plugin-* / skill-* 七种 chip 共享的载荷。
 *
 * `id` 是泛指——plugin chip 时是 pluginId，skill chip 时是 skillId。
 * 单一形状让 chip 渲染和 chat 流处理少一层"取哪个字段"分支。
 */
export type SkillModuleActionPayload = {
  /** plugin chip 是 pluginId，skill chip 是 skillId */
  id: string;
  /** 用户可见名 */
  name: string;
  /** 失败时填错因；成功时缺省 */
  errorMessage?: string;
};

/** Plugin 升级检查的轻量结果（UI 红点用） */
export type PluginUpdateInfo = {
  pluginId: string;
  currentCommit: string;
  latestCommit: string;
  /** 检查失败时填错因，UI 标"检查失败" */
  errorMessage?: string;
};

/** Plugin diff 摘要——getUpdateDiff 返回 */
export type PluginDiffSummary = {
  fromCommit: string;
  toCommit: string;
  /** key 文件（SKILL.md / .mcp.json / plugin.json / scripts/*）的逐文件 patch */
  keyFiles: Array<{ path: string; patch: string }>;
  /** 其余文件只数文件数 */
  otherFilesCount: number;
  /** 中间所有 commit 的 message 列表 */
  commitMessages: string[];
};

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_twin'
  | 'awaiting_user'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'rolled_back'
  | 'interrupted';

export type SubagentTask = {
  id: string;
  /** 数据归属用户 id；MVP 阶段固定 'local-user'，未来多用户时实际填充 */
  ownerId: string;
  agentId: string;
  conversationId: string;
  proposalId: string;
  proposalTitle: string;
  targetProjectId: string | null;
  status: TaskStatus;
  baselineCommit: string | null;
  summary: string | null;
  errorMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** ExecutorProfile id；老数据缺省 'project-coder' */
  profileId: string;
  /** 子 agent 完成时打的 git tag oru/end-<taskId>；中途结束的可能为 null */
  endTag: string | null;
  /** 子 agent 修改过的文件路径（git diff baselineTag..HEAD --name-only） */
  affectedPaths: string[];
  /** 通过 commit_changes 工具创建的 commit hash 列表 */
  commitsCreated: string[];
  /** Twin 已经在主对话播报过这个任务完成，时间戳 */
  announcedAt: number | null;
  /** 派工时切到的 feature 分支名（PRD F4） */
  featureBranch: string | null;
  /** deck 生成类任务对应的 artifactId（proposal.deckContext 派生）——UI 按它反查「该 deck 是否有生成任务在跑/排队」 */
  deckArtifactId?: string;
};

// ─── 定时任务（到点自动替用户跑一段 prompt）──────────────────────────
//
// 触发节奏（cron/每日/间隔/一次性）只是计算的输入，落盘统一归一成一个绝对时间戳
// nextRunAt——调度器只比对它，节奏种类不进热路径。详见 docs/tech/2026-06-23-scheduled-tasks-tech-design.md

/** 触发节奏。各 kind 的时间口径都按本地时区（minutesOfDay = 本地零点起的分钟数）。 */
export type ScheduleSpec =
  | { kind: 'once'; at: number } // 一次：绝对时刻（含「N 分钟后」= now+delta 算出的时刻）
  | { kind: 'daily'; minutesOfDay: number } // 每天
  | { kind: 'weekly'; weekdays: number[]; minutesOfDay: number } // weekdays: 0(周日)..6(周六)
  | { kind: 'interval'; every: number; unit: 'minute' | 'hour' }; // 间隔重复：从 createdAt 起每 every 个单位触发一次

/** 运行位置：触发时这段 prompt 在哪条对话里跑。 */
export type ScheduledRunLocation =
  | { kind: 'newConversation' } // 每次触发新建一条独立对话
  | { kind: 'conversation'; id: string } // 在指定对话中运行（承接其上下文）
  // 渠道落点（G42）：按「平台＋聊天」找到绑定对话（无则新建）承载产出，产出再推送到该渠道聊天，
  // 用户在飞书等平台也收得到。挂载的是地址而非内部对话（同渠道寻址「从不解档」口径）。
  | { kind: 'channel'; platform: 'feishu' | 'discord'; chatId: string };

/**
 * 一次执行的运行记录（G45 可回溯）：时间 + 结果态 + 产出落盘的承载对话。
 * 历次产出此前分散在各触发对话里、任务页只留最近一次；有了它，任务清单能回答「历次结果在哪里」、
 * 一路跳去看。渠道落点也有承载对话，故 conversationId 对三种落点都有值。
 */
export type ScheduledRunRecord = {
  at: number;
  status: 'ok' | 'error' | 'aborted';
  /** 产出落盘的承载对话 id；点它跳去看那次产出。承载对话已删则跳转无效（UI 兜底）。 */
  conversationId?: string;
  late?: boolean;
};

export type ScheduledTask = {
  id: string;
  /** 数据归属用户 id；对齐 SubagentTask.ownerId */
  ownerId: string;
  /** 触发时落点的分身 id */
  agentId: string;
  /** 用户起或 Oru 起的一句话名字 */
  title: string;
  /** 触发时以「用户口吻」发起的指令 */
  prompt: string;
  runLocation: ScheduledRunLocation;
  spec: ScheduleSpec;

  /**
   * 所属「用户任务」的组 id（聚合层 S·多触发规则）：一个用户可见任务 = 多条共享 groupId 的底层 task。
   * 单条任务 groupId = 自己 id（自成一组）。调度内核不看它、逐条单游标调度；聚合读只在 groupTasks()。
   */
  groupId: string;

  /** 暂停 = false */
  enabled: boolean;
  /** 决定列表里是否打「Oru 建」标记 */
  createdBy: 'user' | 'agent';

  // 自动停止（防自循环，可选；仅周期任务用——「一次」由 kind:'once' 自然终结）
  stopAfterRuns?: number; // 重复 N 次后自动停；不设 = 一直（直到用户停用）

  /**
   * 调度游标：持久化的「下一次该触发的绝对时刻」。不是纯派生——重启后据它判漏跑
   * （依赖「上次实际停在哪个触发点」这个历史事实）。null = 已无下次（一次性已执行 / 到停止条件）。
   */
  nextRunAt: number | null;
  /**
   * 错过标记：停机/休眠期间错过的最近一次触发的原定时刻。非空 = 进「错过待处理」区。
   * 不自动补跑，由用户手动「执行」或「忽略」。每任务只留最近一次，不堆叠。
   */
  missedAt?: number;
  /**
   * 已结束的一次性任务「从未触发」的原因细分：true = 用户对错过的提醒主动点了「忽略」。
   * 只在 dismissMissed 对已结束 once 落（见 scheduler）。缺省（含「时间已过没赶上」）= 设定时间已过。
   * 用于「未能触发」组的文案区分（dismissed:你已忽略 / 否则:设定时间已过）；本质布尔，不建半成品 reason 枚举。
   */
  dismissed?: true;
  runCount: number;
  /**
   * 上次执行的结果。三个互斥态用一个枚举、不用两个布尔：
   * - 'ok'：回合正常跑完（含忙时入队，入队即投递成功）。
   * - 'error'：回合真失败（上游挂 / 投递崩），会进「需你处理」的通知；error 带诊断文案。
   * - 'aborted'：用户主动按停了这一轮（非成功也非失败）——2026-07 起「按停不算错误」，
   *   定时触发的回合被按停记这个态，不能误记成功（漏掉「用户没让它跑完」）或失败（会误报进通知中心）。
   * 结果态不驱动任何补救/重试：missedAt 补救是「应用离线错过」触发、与本结果无关；
   * stopAfterRuns 是计数制、与成败无关。它只影响「上次执行」的展示。
   */
  lastRun?: { at: number; status: 'ok' | 'error' | 'aborted'; error?: string; late: boolean };

  /**
   * 历次执行记录（G45 可回溯）：新→旧，上限 MAX_RUN_HISTORY 条（远端截断）。结算单点追加一笔。
   * lastRun 是它的头一条的投影（保留是因为 lastRun 带 error 文案、且是既有承重字段）；缺省/老数据为空。
   */
  runHistory?: ScheduledRunRecord[];

  /**
   * IANA 时区锚（S18·G100），创建时按进程当前时区记录。tick 在 due 判定前核对：与进程当前时区不符时，
   * daily/weekly 重算 nextRunAt（挂钟相对任务），once（绝对时刻）/interval（等差网格）不重算，三种都更新锚。
   * hydrate 给老数据补当前时区。
   */
  tz: string;
  /**
   * 投递账（S18·G41）：已投递未结算的到点拍——到点时与 nextRunAt 推进同一次原子写落一笔，
   * 执行体结算时整批销掉。正常时至多一个执行体在消化它们；开机对账见非空即「已投递未结算」收编为错过。
   * 手动执行不记账（不是到点的拍）。缺省/老数据为空。
   */
  pendingFires?: PendingFire[];

  createdAt: number;
  updatedAt: number;
};

/** 投递账的一笔（S18·G41）：dueAt=原定触发时刻，firedAt=实际落账时刻。 */
export type PendingFire = { dueAt: number; firedAt: number };

/**
 * 聚合视图（多触发规则）：一个「用户可见任务」= 多条共享 groupId 的底层 ScheduledTask。
 * 只在主进程 groupTasks() 里构造，前端从 RPC 拿；调度内核不认它、逐条单游标调度。
 */
export type TaskGroupRule = {
  /** 底层 task id——组写 diff 按它对齐（绝不按下标） */
  taskId: string;
  spec: ScheduleSpec;
  stopAfterRuns?: number;
  nextRunAt: number | null;
  /** 该规则是否还活着（跑满 stopAfterRuns / once 已执行会自 false） */
  enabled: boolean;
  missedAt?: number;
};

export type TaskGroup = {
  groupId: string;
  title: string;
  prompt: string;
  runLocation: ScheduledRunLocation;
  createdBy: 'user' | 'agent';
  /** 组级：组内任一规则 enabled=true 即视为活跃 */
  enabled: boolean;
  /** 至少一条 */
  rules: TaskGroupRule[];
  /** 组内所有活跃规则里最近的一个（null=全终结） */
  nextRunAt: number | null;
  /** 组内任一非空（取最近） */
  missedAt?: number;
  /** 组内任一规则被用户忽略过（endedKind 判「已忽略 / 设定时间已过」用；组级取 some） */
  dismissed?: true;
  /** 组内最近一次执行 */
  lastRun?: ScheduledTask['lastRun'];
  /** 组内合并、按 at 降序、截 MAX_RUN_HISTORY（组级合并，不区分来自哪条规则） */
  runHistory: ScheduledRunRecord[];
  /** 组内最早 */
  createdAt: number;
};

/**
 * 建/改一个「用户任务」的入参（UI 与 RPC 与 AI 工具共用）。
 * rules 每条带可选 taskId：已有规则回填时带上（diff 按它对齐）、新增规则留空。
 */
export type TaskGroupInput = {
  title: string;
  prompt: string;
  runLocation: ScheduledRunLocation;
  /** 至少一条 */
  rules: { taskId?: string; spec: ScheduleSpec; stopAfterRuns?: number }[];
};

/** 清单筛选档：未结束 / 错过待处理 / 已结束 / 全部。 */
export type ScheduledTaskScope = 'active' | 'missed' | 'ended' | 'all';

/** 子 agent 中途反问 Twin（或转给用户）的一次问答 */
export type TaskQuestion = {
  id: string;
  taskId: string;
  question: string;
  /** 子 agent 给出的"应该看的文件路径"列表，给 Twin 当 hint */
  contextPaths: string[];
  askedAt: number;
  /** 用户原话（仅 escalate 到用户后有值） */
  answer: string | null;
  /** Twin 加工后真正发给子 agent 的指令 */
  twinProcessedAnswer: string | null;
  answeredBy: 'twin' | 'user' | null;
  answeredAt: number | null;
};

export type TaskProgress = {
  taskId: string;
  /** 简短描述当前在做什么 */
  text: string;
  toolName?: string;
  /** 工具宾语（file basename / pattern / host / 命令首词），前端翻译用 */
  toolObject?: string;
  /** 进度来源；'tool' 前端翻译成人话并淡色，缺省按 speech（兼容旧 text） */
  source?: 'speech' | 'tool';
};

// ─── 任务（独立于 SubagentTask）─────────────────────────────────

/** Actor 引用——MVP 仅 'you' / 'oru'；v2 加 'human:<id>' / 'agent:<id>' */
export type BoardActorId = string;

/**
 * BoardActor schema 预留位——本期仅 BoardActorId 在用（assignee / deletedBy / mentions），
 * BoardActor 完整结构 v2 引入 actor 集合时（真人同事 / 其他 agent）才消费。
 * 留在这里保证后续加 actor 表时 schema 不需要破坏性改动。
 */
export type BoardActor = {
  id: BoardActorId;
  kind: 'user' | 'agent' | 'human-coworker' | 'external-agent';
  displayName: string;
  avatarUrl?: string;
};

// ─── User Profile ──────────────────────────────────────────────────
//
// 用户对自己的表达（名字 + 头像）。跟 Agent（系统配置 / Twin 那一边）严格分开 ——
// 写入权限、来源、可改性不同；不应共享一个写入入口。

export type UserProfile = {
  /** 数据归属 owner；MVP 阶段固定 LOCAL_USER_ID */
  ownerId: string;
  /** 用户希望被 Twin 称呼的名字。trim 后 1-20 字（20 是工程上限，给两个汉字名 + 修饰词留余量；非产品语义） */
  name: string;
  /** 头像图片绝对路径；null 表示用默认头像（首字母 + user 主题色） */
  avatarPath: string | null;
};

export type BoardTaskStatus = '待办' | '进行中' | '待验收' | '已完成';

export type BoardTask = {
  id: string;
  ownerId: string;
  title: string;
  description?: string;
  status: BoardTaskStatus;
  assignee: BoardActorId;
  /** 自由文本；不存在独立 tag 实体 */
  projectTag?: string;
  createdAt: number;
  updatedAt: number;
  /** 状态切到 '已完成' 时打；切离时清空。
   *  PRD"已完成默认只显示当天完成的"由这个字段判断（不能用 updatedAt——改描述也会刷它） */
  completedAt?: number;
  /** 软删除时打：进入回收站；恢复时清空。回收站永久保留，不自动清理 */
  deletedAt?: number;
  deletedBy?: BoardActorId;
  /** 删除前的状态——回收站行展示原状态用 */
  preDeleteStatus?: BoardTaskStatus;
  /** 关联评论 conversation id（懒创建——P0.5 才建，本 PR 永远 undefined） */
  commentConversationId?: string;
  /** 反规范化：评论数；本 PR 永远 0（评论功能在 P0.5）；
   *  P0.5 起由 conversations/store.ts:appendMessage 检测到 taskboard-comment kind 时自动 +1 */
  commentCount: number;
  /** 描述下方的图片附件；落盘在 taskboard/<taskId>-images/，displayUrl 出口处 hydrate 成 oru-board-img:// */
  attachments?: ChatAttachment[];
};

/** 列表渲染用的轻量索引；不含 description / attachments（只在详情面板展示，不进列表行） */
export type BoardTaskMeta = Omit<BoardTask, 'description' | 'attachments'>;

export type BoardTaskFilters = {
  /** 状态枚举数组——例 ["待办","进行中","待验收"] = 未完成集合 */
  status?: BoardTaskStatus[];
  projectTag?: string;
  assignee?: BoardActorId;
  /** 默认 false——不返回回收站项 */
  includeDeleted?: boolean;
  /** 标题 + 描述 关键词模糊匹配（小写包含） */
  q?: string;
};

/** 错误码常量 */
export const ErrorCodes = {
  PROFILE_INVALID: 'PROFILE_INVALID',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_PATH_INVALID: 'PROJECT_PATH_INVALID',
  PROJECT_DUPLICATE: 'PROJECT_DUPLICATE',
  FS_READ_FAILED: 'FS_READ_FAILED',
  FS_WRITE_FAILED: 'FS_WRITE_FAILED',
  FS_NOT_MARKDOWN: 'FS_NOT_MARKDOWN',
  GIT_NO_REPO: 'GIT_NO_REPO',
  GIT_PROTECTED_BRANCH: 'GIT_PROTECTED_BRANCH',
  GIT_FAILED: 'GIT_FAILED',
  AGENT_NO_AUTH: 'AGENT_NO_AUTH',
  AGENT_FAILED: 'AGENT_FAILED',
  AGENT_BUSY: 'AGENT_BUSY',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  /** 回合「成功」但正文与工具调用双零（reasoning-only / 空回复）——按出错呈现，可重试 */
  EMPTY_COMPLETION: 'EMPTY_COMPLETION',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_INVALID: 'MODEL_INVALID',
  ATTACHMENT_TOO_LARGE: 'ATTACHMENT_TOO_LARGE',
  ATTACHMENT_TOO_MANY: 'ATTACHMENT_TOO_MANY',
  ATTACHMENT_BAD_FORMAT: 'ATTACHMENT_BAD_FORMAT',
  ATTACHMENT_DECODE_FAIL: 'ATTACHMENT_DECODE_FAIL',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  PROPOSAL_NOT_FOUND: 'PROPOSAL_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_BUSY: 'TASK_BUSY',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',
  /** 档案记忆「撤回这次修改」不可行（之后又被改过 / 那一版已过保留期 / 本就是第一版） */
  MEMORY_REVERT_UNAVAILABLE: 'MEMORY_REVERT_UNAVAILABLE',
  /** 上游 LLM 返回非 2xx（含 4xx / 5xx），retry 用尽后归到这个码 */
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  /** 流式期间空闲超过 idleTimeoutMs（半死连接被主动断流） */
  UPSTREAM_IDLE_TIMEOUT: 'UPSTREAM_IDLE_TIMEOUT',
  /** v0.4 压缩 + 硬丢全跑完仍撞窗口——给前端展示中文文案而不是英文 raw message */
  CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
  // ─── 定时任务 ───
  SCHEDULE_INVALID: 'SCHEDULE_INVALID',
  // ─── taskboard ───
  BOARD_TASK_NOT_FOUND: 'BOARD_TASK_NOT_FOUND',
  BOARD_TASK_DELETED: 'BOARD_TASK_DELETED',
  BOARD_COMMENT_BUSY: 'BOARD_COMMENT_BUSY',
  BOARD_COMMENT_CONV_PROTECTED: 'BOARD_COMMENT_CONV_PROTECTED',
  // ─── deck（v1）───
  DECK_NOT_FOUND: 'DECK_NOT_FOUND',
  DECK_NAME_INVALID: 'DECK_NAME_INVALID',
  DECK_HISTORY_VERSION_NOT_FOUND: 'DECK_HISTORY_VERSION_NOT_FOUND',
  DECK_HISTORY_CHECKOUT_MISSING_IMAGES: 'DECK_HISTORY_CHECKOUT_MISSING_IMAGES',
  DECK_ANNOTATION_NOT_FOUND: 'DECK_ANNOTATION_NOT_FOUND',
  /** 行内编辑定位降级（文本找不到 / 多处歧义 / marker 失配）——前端据此回滚 DOM 并提示"用框选交给 AI 改" */
  DECK_INLINE_EDIT_DEGRADED: 'DECK_INLINE_EDIT_DEGRADED',
  /** 文件级文字写回定位降级（oldText 找不到 / 多处歧义）——前端据此回滚并提示改用 AI 改写 */
  FS_TEXT_EDIT_DEGRADED: 'FS_TEXT_EDIT_DEGRADED',
  /** 文件级文字写回基线失配（expectedMtimeMs 与磁盘不符，文件已被外部改过）——前端据此提示先重载 */
  FS_TEXT_EDIT_CONFLICT: 'FS_TEXT_EDIT_CONFLICT',
  /** v1 协议已定义但实现待后续阶段——区别于 UNKNOWN 让前端 toast 文案能给"该功能还没接通"而不是"未知错误" */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ─── Deck 模块（v1）数据类型 ─────────────────────────────────────
//
// 详细设计：docs/tech/2026-05-26-html-deck-tech-design.md
// 标识约定（§2）：artifactId 跨进程；deckPath 仅 main 内文件操作；deckName 仅 UI / 目录名

/** 单个 deck 的注册表记录 —— ArtifactRecord.path 是 sanitize + 重名处理后的绝对路径 */
export type ArtifactRecord = {
  id: string;          // artifactId, dck_<nanoid>
  projectId: string;
  name: string;        // 用户输入的显示名
  path: string;        // 绝对路径 <project.path>/<sanitized name>
  createdAt: number;
  updatedAt: number;
  /** 创建时选用的 deck skill id——事后生成（generate_deck）复用它，无需重选 */
  deckSkillId?: string;
  // 注意：currentVersion 不冗余存于 ArtifactRecord——前端要时调 deck.listHistory 拿 manifest
};

/**
 * 一条框选 region 注释（v2）——用户在预览上框出一块区域 + 写评论。
 *
 * 框选可在一处多条独立存在（不再像 v1 那样按 pageIndex 唯一覆盖）。
 * `cropPath/htmlSnippet/text` 是**捕获快照**（提交时喂 AI，是缓存非锚点）；
 * `locator` 是**尽力而为定位**（仅服务跳转 + 排序，可失效，不承载正确性）。
 */
export type Annotation = {
  id: string;                       // ann_<nanoid>
  /** 用户自由文本评论 */
  comment: string;
  // —— 捕获快照 ——
  /** `.annotations/crops/<id>.png` 相对路径；未截图时为空串 */
  cropPath: string;
  /** 命中元素 outerHTML（≤8KB）；跨域/失败时 '' */
  htmlSnippet: string;
  /** 命中元素 innerText */
  text: string;
  // —— 尽力而为定位 ——
  locator: {
    scrollY: number;
    rect: { x: number; y: number; w: number; h: number };
    /** 仅 deck profile */
    pageIndex?: number;
    /** 宽松 nth-of-type 路径，可空 */
    selector?: string;
  };
  // —— 状态机 ——
  /** pending = 待提交；submitted = 已入提交组修改中；failed = AI 改失败保留 */
  status: 'pending' | 'submitted' | 'failed';
  /** submitted/failed 时所属提交组 */
  groupId?: string;
  /** status='failed' 时的错因 */
  failureMessage?: string;
  createdAt: number;
  updatedAt: number;
};

/** Artifact 目录 `.annotations.json` 落盘格式（v2 框选 region） */
export type AnnotationsFile = {
  version: 2;
  artifactId: string;
  annotations: Annotation[];
};

/** 单个版本元数据 */
export type HistoryVersion = {
  /** 'v001' 递增 */
  id: string;
  /**
   * 该版本字节在 fileHistory 中央仓的 snapshot id（项目B 第一期：deck 字节退 .history、进中央仓）。
   * deck 版本 id（vNNN，语义层）与 snapshot id（sNNN，字节层）解耦：deck 始终为每次 commit 新建一条
   * 版本条目（保 summary/kind/零回退），而内容逐字节相同的两版共享同一 snapshot（中央仓去重）。
   * 迁移前的旧 manifest 无此字段——读路径据 sentinel 判：未迁移走旧 vNNN.html，已迁移读 snapshotId。
   */
  snapshotId?: string;
  createdAt: number;
  /**
   * commit 来源类型。'batch' 含 ⌘+Enter 单条即时改；'reorder' 拖拽重排页面。
   * 触发表见 docs/tech/2026-05-26-html-deck-tech-design.md §7.3
   */
  kind: 'batch' | 'inline' | 'ai' | 'protective' | 'reorder' | 'initial';
  /** 派生简述（PRD §4 第 155 行规则） */
  summary: string;
  /** 跟前一版本比，第几页变了（0 起） */
  changedPages: number[];
};

/**
 * 通用 todo（计划清单，S32·G49）——干活方自己列的工作计划（查资料 → 写草稿 → 改第三节）。
 * 按对话落盘、每轮贴回眼前，了结后自动清掉；状态的元数据（符号 / 是否终结 / 该不该写原因）
 * 在 shared/todo.ts 一处定义。
 *
 * stuck / removed 是给「说真话」留的位置：做了一半、报错没解决标 stuck，计划变了标 removed，
 * 不必再在「撒谎标完成」和「整项删掉」之间二选一。
 */
export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'stuck' | 'removed';
export type TodoItem = {
  content: string;
  status: TodoStatus;
  /** stuck / removed 该带：卡在哪、为什么不做了。缺了不拦，但回执会点名、卡片会显示「未说明原因」 */
  note?: string;
};

/**
 * FileHistory（md/csv 通用快照层）的快照类型与元数据——main 的 fileHistory.ts 与渲染端历史窗口共用。
 * deck 的 HistoryVersion 是另一套（带指针/changedPages 语义），不复用这个。
 */
export type FileSnapshotKind =
  | 'periodic' // 活跃时定期取样
  | 'manual' // ⌘S 手动留底
  | 'ai' // AI 改完留底
  | 'overwrite-guard' // 覆盖前把磁盘当前版兜进历史（不丢的承重机制）
  | 'pre-restore' // restore 旧版前先把当前版留底
  | 'initial' // 首次纳管的底版
  | 'handoff' // S28：换笔覆盖前留底——覆盖者与被覆盖版作者不同（AI 覆盖你 / 你覆盖 AI），对用户可见可点回
  | 'discarded' // S27：撞同段弃写、又无编辑器接住时，把在途内容降级留进历史（可找回）；S29 触发写入
  // ── S29（G90）冲突卡收口：开卡即把双方版本入历史（防「收起时才入库」留数小时窗口丢字）。
  | 'conflict-version' // 开卡时双方版本各存一份；手动拼合收起也维持此标（两版都可能要找回，无全胜方）
  | 'conflict-losing' // 二选一收起时给落选那份补的标（拍板后由 conflict-version re-tag 而来）
  // ── deck 并入统一历史后（项目B）：deck HistoryVersion.kind 的超集，deck 把自己的 kind
  //    直接透传 commitSnapshot，零映射表（裁定 A）。'ai'/'initial' 与上面共用。
  | 'protective' // deck 提交标注/重排前的"改前"暂存——承重，必进 PROTECTED_KINDS
  | 'batch' // deck 批量应用标注
  | 'inline' // deck 行内/即时改字
  | 'reorder'; // deck 页面重排

/** 单个快照的元数据（内容在 snapshots/<id> 文件里，不进 manifest） */
export type FileSnapshotRef = {
  id: string; // 's001' 递增
  createdAt: number;
  kind: FileSnapshotKind;
  hash: string; // 内容 sha256
  size: number; // 内容字符数
  /**
   * S28（G92）：里程碑版本（PROTECTED_KINDS）超过保留期后被「到期归档」而非静默删——标记后仍在时间轴上
   * 可找回，只是标注「已归档」并发过一次系统信号。周期取样等匿名锚点不走此路（直接稀释/淘汰），故缺省。
   */
  archived?: boolean;
};

/** Deck 目录 `.history/manifest.json` 落盘格式 */
export type HistoryManifest = {
  version: 1;
  artifactId: string;
  /** 当前 index.html 对应的版本 id，如 'v003' */
  currentVersion: string;
  /** 时间序，递增 */
  versions: HistoryVersion[];
};

// ─── Prompt 工作台 ──────────────────────────────────────────────────
// 静态 prompt 的元数据/全文形态。真相在 electron/main/prompts/registry.ts 登记，
// 类型放 shared 让 WS 协议层无需反向依赖 electron/main。

export type PromptCategory = 'persona' | 'memory' | 'agent' | 'tasks' | 'taskboard';

export interface PromptMeta {
  /** 稳定身份标识，跨改名/搬家不变；面板与 url 用它定位 */
  id: string;
  /** 人看的标题 */
  title: string;
  category: PromptCategory;
  /** 一句话说明这段管什么（可选） */
  summary?: string;
}

export interface PromptEntry extends PromptMeta {
  body: string;
}

/** category → 中文名的单一真相；前后端共用（渲染层分组、主进程登记）。漏一类编译期即红。 */
export const CATEGORY_LABELS: Record<PromptCategory, string> = {
  persona: '人格',
  memory: '记忆',
  agent: 'Agent',
  tasks: '任务',
  taskboard: '任务面板',
};
