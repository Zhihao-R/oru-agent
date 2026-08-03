/**
 * WebSocket 双向协议契约
 * 严禁在 agent 阶段修改本文件，需要新字段必须先回到 plan 协商
 *
 * 客户端→服务端 用 ClientRequest，每条带 reqId
 * 服务端→客户端 用 ServerEvent；如果是对某条 request 的响应，带相同 reqId
 *
 * 主→渲染会主动推送（不带 reqId）的事件：projects.state / agents.state / conv.state /
 * chat.* / git.status.result（自动刷新场景） / task.* / chat.proposal / chat.taskReport
 */

import { ARTIFACT_MSG } from './artifactProtocol';
import { HTML_MSG } from './htmlProtocol';
import type {
  ActionProposal,
  Agent,
  WhitelistEntry,
  TodoItem,
  AsideReferent,
  AskUserChoiceAnswers,
  AskUserChoiceQuestion,
  AuthStatus,
  BackendProvider,
  BackendProviderType,
  BoardActorId,
  BoardTask,
  BoardTaskFilters,
  BoardTaskMeta,
  BoardTaskStatus,
  ChatDelta,
  ChatMessage,
  ChatRole,
  ChecklistEdit,
  Conversation,
  DreamRunOutcome,
  EpisodeStatus,
  ErrorCode,
  FileNode,
  GitStatus,
  LlmUsage,
  McpServerConfig,
  McpServerCreateInput,
  McpServerPatch,
  McpServerStatus,
  ModelAssignment,
  Project,
  ProposalStatus,
  RegisteredModel,
  SearchEngineType,
  Settings,
  SubagentTask,
  TaskProgress,
  TaskQuestion,
  ToolCall,
  ToolResult,
  UserProfile,
  MemoryProjectProfile,
  ProjectListEntry,
  EpisodeWithBody,
  PluginRecord,
  SkillRecord,
  PluginUpdateInfo,
  PluginDiffSummary,
  ArtifactRecord,
  Annotation,
  HistoryVersion,
  FileSnapshotRef,
  PromptMeta,
  PromptEntry,
  ScheduledTask,
  ScheduledTaskScope,
  ScheduleSpec,
  TaskGroup,
  TaskGroupInput,
  HandbackItem,
  TriggerOrigin,
  Grant,
  GrantScope,
} from './types';
import type { MemoryOp, MemoryOpOrigin, ApplyResult } from './memory/operations';
import type { ProfileDoc } from './memory/profileDoc';
import type { Platform, PlatformStatus, FeishuUserAuthState } from './platform/message';
import type { UsageLedgerFile } from './usage/types';

// ─── client → server ───────────────────────────────────────────────

// projects
export type ProjectsListReq = { type: 'projects.list' };
export type ProjectsAddReq = { type: 'projects.add'; path: string };
export type ProjectsRemoveReq = { type: 'projects.remove'; id: string };
export type ProjectsSwitchReq = { type: 'projects.switch'; id: string };

// fs
/** 读取某目录的直接子项（一层，懒加载）；path='' 表示项目根。纯读、无副作用 */
export type FsListReq = { type: 'fs.list'; projectId: string; path: string };
/** 订阅/退订某目录的文件变动监听（展开布哨兵 on:true，折叠撤 on:false）；path='' 为项目根。
 *  owner 缺省 'tree'（文件树）；表格视图盯打开文件的父目录时传 `table:${path}`，按 owner 记账精确退订 */
export type FsWatchReq = { type: 'fs.watch'; projectId: string; path: string; on: boolean; owner?: string };
export type FsReadMdReq = { type: 'fs.readMd'; projectId: string; path: string };
export type FsWriteMdReq = {
  type: 'fs.writeMd';
  projectId: string;
  path: string;
  content: string;
  /** 'manual'：⌘S 立刻留个底（给当前内容打一条 manual 快照）；缺省=实时 autosave，只兜底不单独留底 */
  mark?: 'manual';
  /** S27：编辑器提交时的共同起点。带 mergeOnStale 时磁盘现状 !== baseline → 锁内机械合并/弃写。 */
  baseline?: { content: string };
  /** S27：基线过期不直接拒，先试锁内机械合并（编辑器侧的笔专用，见 workfileWrite.mergeOnStale）。 */
  mergeOnStale?: boolean;
};
/** 写 .csv（原子写）。expectedDiskSha256：缺省=无条件写；null=期望文件不存在；
 *  hex=期望磁盘字节哈希一致。不一致返回 conflict、文件不被触碰——比对贴着写盘做，消灭 TOCTOU 窗口 */
export type FsWriteTextReq = {
  type: 'fs.writeText';
  projectId: string;
  path: string;
  content: string;
  expectedDiskSha256?: string | null;
  /** 'manual'：⌘S 立刻留个底（仅实时落盘路径，即 expectedDiskSha256 缺省时有效） */
  mark?: 'manual';
};
/** 磁盘现状摘要——watcher 报变后前端来问"真变了吗"（与自己刚保存的版本比哈希） */
export type FsTextHashReq = { type: 'fs.textHash'; projectId: string; path: string };
/**
 * 文件级文字写回：在 filePath 里把 oldText 唯一出现处替换为 newText（HTML 预览行内编辑写回用）。
 * filePath 为绝对路径——内核 applyTextEdit 作用于任意文件、不绑 project/path 解析。
 * markerId 非空走 data-edit-id 快路径；expectedMtimeMs 传了则做基线冲突校验（缺省跳过）。
 * 成功只回 ack、不广播 fs.changed/indexChanged（写回是预览内同步的、不触发整页 reload）。
 */
export type FsApplyTextEditReq = {
  type: 'fs.applyTextEdit';
  filePath: string;
  markerId?: string | null;
  oldText: string;
  newText: string;
  expectedMtimeMs?: number;
};
/**
 * 取绝对路径文件的 mtime——HTML 预览就地改字的冲突基线（打开 / 写成功后各取一次）。
 * 走绝对 filePath、不绑 project（与 fs.applyTextEdit 同口径）：HtmlViewer 只持有 html 绝对路径，
 * 没有 projectId，复用不上 fs.textHash（绑 projectId+相对 path）。
 */
export type FsStatReq = { type: 'fs.stat'; filePath: string };
/** 无覆盖原子建文件（扩展名限 .md/.csv）。已存在 → conflict 且字节不动；扩展名非法 → invalid */
export type FsCreateFileReq = {
  type: 'fs.createFile';
  projectId: string;
  path: string;
  content: string;
};
/** 建空目录（非 recursive）。已存在（目录或同名文件）→ conflict */
export type FsMkdirReq = { type: 'fs.mkdir'; projectId: string; path: string };
/** 重命名（同目录换名）。撞名 → conflict 不覆盖；非法名 → invalid；源没了 → not-found */
export type FsRenameReq = { type: 'fs.rename'; projectId: string; path: string; newName: string };
/** 同目录生成副本（「基础名 副本.ext」，撞名加序号）。文件夹整树复制 */
export type FsDuplicateReq = { type: 'fs.duplicate'; projectId: string; path: string };
/** 移到目标文件夹 destDir（''=项目根）。自吞/越界 → invalid；撞名 → conflict 留原处；原地 → ok 无操作 */
export type FsMoveReq = { type: 'fs.move'; projectId: string; path: string; destDir: string };
/** 删到系统回收站（可找回，非永久删）。源没了 → not-found */
export type FsTrashReq = { type: 'fs.trash'; projectId: string; path: string };
/** 在系统文件管理器里定位高亮（「在 Finder 中显示」）。纯副作用，回 ack */
export type FsRevealReq = { type: 'fs.reveal'; projectId: string; path: string };

// fileHistory（md/csv 工作文件的「自动留底找回」——deck 的 artifact.*History 是另一套带指针的后端）
/** 列出某工作文件的快照时间轴 */
export type FileHistoryListReq = { type: 'fileHistory.list'; projectId: string; path: string };
/** 取某快照内容（仅预览/diff 用，不落盘）；restore 才写回工作文件 */
export type FileHistoryGetReq = {
  type: 'fileHistory.get';
  projectId: string;
  path: string;
  snapshotId: string;
};
/** 把某旧快照整篇恢复回工作文件（main 在 workfile 锁内：先留底当前版再写回），返回恢复后的内容 */
export type FileHistoryRestoreReq = {
  type: 'fileHistory.restore';
  projectId: string;
  path: string;
  snapshotId: string;
};
/** 清空某工作文件的全部历史（隐私入口） */
export type FileHistoryClearReq = { type: 'fileHistory.clear'; projectId: string; path: string };
/** 注册/注销某工作文件的周期取样（编辑器打开 on:true、关闭/切走 on:false），镜像 fs.watch */
export type FsHistorySampleReq = {
  type: 'fs.history.sample';
  projectId: string;
  path: string;
  on: boolean;
};

// 冲突卡收口（S29·G90）—— renderer ↔ main 的冲突卡生命周期信令。
/**
 * 开冲突卡：把双方版本各存一版进历史（打 'conflict-version'，防收起前崩溃丢未落盘的 mine），
 * 并在主进程登记「此文件正开着冲突卡」（AI 后续写入据此并行 defer）。回两版 snapshot id 供收起补标。
 */
export type ConflictOpenedReq = {
  type: 'conflictCard.opened';
  projectId: string;
  path: string;
  mine: string; // 我的（编辑器在途）版本
  theirs: string; // AI 的（磁盘现状）版本
};
export type ConflictOpenedResult = {
  type: 'conflictCard.opened.result';
  mineId: string;
  theirsId: string;
};
/**
 * 冲突卡收起：撤登记、按出口补标（二选一给落选补 'conflict-losing'、拼合双方留 'conflict-version'），
 * 并起新轮把裁决交回被挂起的 AI 写入（不等用户再开口）。mineId/theirsId 为开卡时回的两版 id。
 */
/**
 * 冲突卡收起的出口。前三值 = 渲染端 ConflictAction 的聚合（保留我的 / 保留 AI 的 / 手动拼合或跨段混选）；
 * cancelled = 未裁决就撤卡（关标签/改名）：不补落选标，仍撤登记并交回 AI。
 */
export type ConflictOutcome = 'mine' | 'theirs' | 'both' | 'cancelled';
export type ConflictResolvedReq = {
  type: 'conflictCard.resolved';
  projectId: string;
  path: string;
  outcome: ConflictOutcome;
  mineId: string;
  theirsId: string;
};
/**
 * 弃写降级入历史（S29 ⑤）：撞同段被弃写、又无编辑器接住在途内容时，把它降级写进历史打 'discarded'
 * 标（可找回），磁盘保留 AI 版。仅加一条历史快照、不碰磁盘文件。
 */
export type FileHistoryRecordDiscardedReq = {
  type: 'fileHistory.recordDiscarded';
  projectId: string;
  path: string;
  content: string;
};

/** 把一张图（粘贴/拖入/裁剪输出）落进当前文档旁的 `<文档名>.assets/`，回相对引用。 */
export type FsWriteImageReq = {
  type: 'fs.writeImage';
  projectId: string;
  docPath: string; // 打开文档的相对路径
  base64: string;
  preferredBase: string; // 文件名基（剪贴板文件名去扩展名 / 默认）
  ext: string; // 含点，如 '.png'
};
export type FsImageWrittenEvent = {
  type: 'fs.image.written';
  ref: string; // <文档名>.assets/<唯一名>，相对该文档目录
};

// table（轻量表格：xlsx 导入 / 表格视图打开 / 导出）
/** xlsx 只读预览：内存转换逐 sheet 回 CSV 文本，零落盘。回执 table.xlsxPreview */
export type TablePreviewXlsxReq = { type: 'table.previewXlsx'; projectId: string; path: string };
/** 触发 xlsx → CSV 转换落盘（预览里的显式「转为可编辑」动作；in-flight 去重）。回执 table.importResult */
export type TableImportXlsxReq = { type: 'table.importXlsx'; projectId: string; path: string };
/** 应答导入冲突三选一（覆盖 / 另存 / 取消）。结果以 table.conflictResolved 回 */
export type TableResolveImportConflictReq = {
  type: 'table.resolveImportConflict';
  conflictId: string;
  choice: 'overwrite' | 'saveAs' | 'cancel';
};
/** 打开 CSV：main 侧 streaming 判超限（>100,000 数据行只回前 1,000 行只读预览）并附来源反查 */
export type TableOpenReq = { type: 'table.open'; projectId: string; path: string };
/** 保存该文件的表格视图偏好（列宽/整表行高，覆盖式落盘）。回 ack。 */
export type TablePrefsSetReq = {
  type: 'table.prefs.set';
  projectId: string;
  path: string;
  prefs: TablePrefs;
};
/** 导出 xlsx：弹保存对话框选位置后写盘，绝对路径以 table.exported 回（取消则 cancelled）。 */
export type TableExportXlsxReq = { type: 'table.exportXlsx'; projectId: string; path: string };
/** 在访达/资源管理器中高亮导出物（path=table.exported 返回的绝对路径）。 */
export type TableRevealExportReq = { type: 'table.revealExport'; projectId: string; path: string };
// renderer query（main → renderer 的通用查询信箱；renderer 以本请求应答）
// kind='dirtySet'：出口闸门执行前先让渲染端 flush 编辑器 pending、再拉当前未落盘集（实时落盘后通常为空）。
export type RendererQueryResultReq = {
  type: 'renderer.queryResult';
  queryId: string;
  result: unknown;
};

// agents
export type AgentsListReq = { type: 'agents.list' };
export type AgentsUpdateReq = { type: 'agents.update'; agentId: string; patch: Partial<Agent> };

// agent avatars（Twin 头像上传）
export type AgentsAvatarUploadReq = {
  type: 'agents.avatar.upload';
  agentId: string;
  /** PNG image as base64（不带 data: 前缀）；主进程会写到 <userData>/avatars/ */
  base64Png: string;
};

// user profile（用户自己的名字 + 头像）
export type UserProfileGetReq = { type: 'user.profile.get' };
export type UserProfileUpdateReq = {
  type: 'user.profile.update';
  patch: Partial<Pick<UserProfile, 'name' | 'avatarPath'>>;
  /**
   * 新头像图片，base64 PNG（不带 data: 前缀）。
   * 跟 patch 一起原子提交：主进程会先落盘新图、再写 profile.avatarPath；
   * 任一步失败整个 update 失败，避免 upload 成功 / patch 失败的孤儿图。
   */
  newAvatarBase64Png?: string;
};

// conversations
export type ConvListReq = { type: 'conv.list'; agentId: string };
export type ConvCreateReq = { type: 'conv.create'; agentId: string; title: string };
export type ConvDeleteReq = { type: 'conv.delete'; agentId: string; conversationId: string };
/** 手动归档：把对话收进「已归档」抽屉（设 archivedAt），可恢复。与 conv.delete（硬删 + 历史落 .bak）是两套机制。 */
export type ConvArchiveReq = { type: 'conv.archive'; agentId: string; conversationId: string };
export type ConvRenameReq = {
  type: 'conv.rename';
  agentId: string;
  conversationId: string;
  title: string;
};
export type ConvClearReq = { type: 'conv.clear'; agentId: string; conversationId: string };
/** 手动压缩（桌面 /compress）——回合外立刻整理当前会话上下文；结果是四态回执（见 ConvCompressResultEvent）。 */
export type ConvCompressReq = { type: 'conv.compress'; agentId: string; conversationId: string };
export type ConvHistoryReq = { type: 'conv.history'; agentId: string; conversationId: string };
/**
 * 睡眠唤醒对账（文档 sleep-wake-chat-recovery）：从主进程拉某对话的「真相快照」——在途回合
 * 死活、仍在等的提问卡、在途半截。前端在收到 chat.wakeRecover 或 mount 兜底时发起。
 * Reply → ChatPendingTurnStateResultEvent。
 */
export type ChatPendingTurnStateQueryReq = {
  type: 'chat.pendingTurnState.query';
  agentId: string;
  conversationId: string;
};
/**
 * 睡眠唤醒对账（mount 兜底拉，sleep-wake-chat-recovery）：列出当前所有在途对话（steeringQueue
 * running 或仍有 waiter 等回答）。窗口重开后 wake 推收不到，靠 mount 时先 list 再逐个 query。
 * Reply → ChatPendingTurnStateListResultEvent。
 */
export type ChatPendingTurnStateListReq = { type: 'chat.pendingTurnState.list' };
/**
 * 标记已读水位（通知中心 §5.1）——打开对话即写。已读要跨重启 / 跨设备活着，必须持久化，
 * 而没有现成事件承载"用户读了"（appendMessage 刷 updatedAt 是反向的），故新增这条最小写 RPC。
 * 前端乐观先行、fire-and-forget 落盘，值随下次 conv.state 同步回来。
 */
export type ConvMarkSeenReq = {
  type: 'conv.markSeen';
  agentId: string;
  conversationId: string;
  seenAt: number;
};
/** 全局搜索：标题 + 消息正文一起搜该 agent 的全部对话（sub + aside） */
export type ConvSearchReq = { type: 'conv.search'; agentId: string; query: string };
/** 对话期 subagent：前端按 taskId 懒加载 subagent 内部对话 sidecar */
export type ConvGetSubagentSidecarReq = {
  type: 'conv.getSubagentSidecar';
  agentId: string;
  conversationId: string;
  taskId: string;
};

// aside（随手评点：⌥ 点击界面任意处 → 短评 / 短聊；指代结构见 shared/types.ts 的 AsideReferent）
/**
 * ⌥ 点来源：窗内（老路，主窗渲染器）/ 窗外（唤起对话，独立浮层渲染器）。
 * 唯一作用是给计数分「窗外」维度（PRD §9 度量）——缺省按窗内，浮层窗显式标 'screen'。
 */
export type AsideOrigin = 'window' | 'screen';
/** 主窗口截图（无载荷）——主进程 capturePage 后归一为逻辑像素，浮层在点击位置画标记 */
export type AsideCaptureReq = { type: 'aside.capture' };
/** one-shot 短评：主进程组装指代 + 截图上下文调一次 LLM；无对话、零落盘 */
export type AsideCommentReq = {
  type: 'aside.comment';
  agentId: string;
  referent: AsideReferent;
  /** 截图 PNG base64（不带 data: 前缀）；所配模型不支持视觉时主进程不带图、仅文本上下文 */
  screenshot?: string;
  /** 来源维度（缺省窗内）；浮层窗标 'screen' 让计数分窗外占比 */
  origin?: AsideOrigin;
};
/** 用户开口 → 创建 kind:'aside' 对话并落种子消息：指代卡 +（可选）已飘出的短评 */
export type AsideBeginReq = {
  type: 'aside.begin';
  agentId: string;
  referent: AsideReferent;
  screenshot?: string;
  /** 已展示给用户的那句短评；用户抢话（短评未到就开口）则缺省 */
  comment?: string;
  /** 短评失败的原因（与 comment 互斥）——种子落一条带 error 的空 assistant 消息，
   *  浮层里那行报错跟着进对话（凡 error 必显示，落盘回看同样成立） */
  commentError?: string;
  origin?: AsideOrigin;
};
/** 浮层短聊期间再次 ⌥ 点击——向既有 aside 对话追加一张指代卡，以其为 user 消息跑一轮正常回合（响应 aside.addReferent.result 带卡；回应轮次经 chat.* 推送） */
export type AsideAddReferentReq = {
  type: 'aside.addReferent';
  agentId: string;
  conversationId: string;
  referent: AsideReferent;
  screenshot?: string;
  origin?: AsideOrigin;
};
/** 转正式对话：rekind aside→sub，消息 / 附件 / sdkSessionId 原地不动（响应 ack；主列表浮现经 conv.state 广播） */
export type AsidePromoteReq = {
  type: 'aside.promote';
  agentId: string;
  conversationId: string;
  origin?: AsideOrigin;
};
/** 按 agent 拉取归档 aside 对话列表（按需、非全量；响应是独立事件，不借 conv.state） */
export type AsideListReq = { type: 'aside.list'; agentId: string };

/**
 * ws 传输用的图片附件（base64 内联）。chat.send / taskboard.note.add / comment.send 共用。
 * 主进程收到后写盘 → 在 ChatMessage.attachments 里落 relPath；前端不需要预先上传。
 * 单张 base64 解码后 ≤ 5 MB，单条 ≤ 8 张；超限 → ATTACHMENT_TOO_LARGE / ATTACHMENT_TOO_MANY。
 */
export type WireImageAttachment = {
  /** base64 编码（不带 data: 前缀） */
  base64: string;
  /** MIME，必须在白名单内 */
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** 用户原始文件名 */
  filename: string;
  /** 客户端自报的字节数；服务端会用解码后真实长度二次校验 */
  bytes: number;
};

// chat
export type ChatSendReq = {
  type: 'chat.send';
  agentId: string;
  conversationId: string;
  text: string;
  /** v0.3：本轮要附带的图片（按发送顺序）。无图时省略。 */
  attachments?: WireImageAttachment[];
  /**
   * Steering：前端生成的本条消息客户端 id。服务端据此回 chat.started（起回合）或
   * chat.steering.added{clientMsgId,serverId}（入队），让前端把乐观「将生效」气泡对齐到服务端裁决。
   * 旧路径（不传）按起回合处理。忙时入队只取 text——v1 纯文本 steering，附件入口前端已禁。
   */
  clientMsgId?: string;
};
export type ChatAbortReq = { type: 'chat.abort'; agentId: string; conversationId: string };
/** Loop 停止（v3）：叫停进行中的 Loop——当前轮中断收尾、已达标保留、落 user-stopped 终态卡。 */
export type LoopStopReq = { type: 'loop.stop'; loopId: string };
/** Loop 中途改标准（v3）：加/删/改一项，入队、下一轮边界生效。 */
export type LoopEditChecklistReq = { type: 'loop.editChecklist'; loopId: string; edit: ChecklistEdit };
/** [重试] 在「上一轮被中断、留有半截」时走这条——不带新消息，从 history 末尾续跑（复用审批后续跑机制）。 */
export type ChatResumeReq = { type: 'chat.resume'; agentId: string; conversationId: string };
/** Steering：撤回一条还在服务端队列、未被读入的「将生效」消息。回 ChatSteeringWithdrawResultEvent。 */
export type ChatSteeringWithdrawReq = {
  type: 'chat.steering.withdraw';
  agentId: string;
  conversationId: string;
  clientMsgId: string;
};
/**
 * 崩溃盘记交还的送达确认：前端已把 chat.steering.recovered 的文本并入输入框草稿，
 * 服务端收到才清盘记——确认前崩溃则下次重启再交还（宁重复不丢）。回 ack。
 */
export type ChatSteeringRecoverAckReq = {
  type: 'chat.steering.recoverAck';
  agentId: string;
  conversationId: string;
};
/**
 * 放行一个待处理项（S08 · G14）：用户在交还的待处理项上点「放行」——服务端按原 SteeringMsg 投影
 * 重新 enqueueOrStart（trigger/payload/attachments 原样），对话空闲即起回合。回 ack。
 * 「清掉」不发命令：前端丢弃即可（盘记已在交还时清）。
 */
export type ChatQueueReadmitReq = {
  type: 'chat.queue.readmit';
  agentId: string;
  conversationId: string;
  item: HandbackItem;
};

// task / proposal
/**
 * 接受一个 proposal 并执行（v0.6 重命名自 task.execute）。
 *
 * - kind='code'：派 subagent 走 queue
 * - kind='mcp.install/update/delete'：走 mcp 自装异步执行
 *
 * 同一个动词覆盖两种 propose——由 router 按 proposal.kind 分发。
 */
export type ProposalExecuteReq = {
  type: 'proposal.execute';
  proposalId: string;
  /** 点的是「始终允许」（S24 · G30）：批准并把该提案全部 grantable scope 记入持久授权清单，同类免卡。 */
  always?: boolean;
};

/**
 * 用户在 ProposalCard 点 [我自己来] 拒绝（v0.6 新增）。
 * router 把 proposal status 置 'rejected' 并写一条 'system-event' 消息进 conv history
 * 让分身下一轮能感知拒绝。
 */
export type ProposalRejectReq = {
  type: 'proposal.reject';
  proposalId: string;
  /** 拒绝附言（G02）：用户可选填写「为什么不批」，作为系统记随拒绝落进历史让分身下轮看到。 */
  note?: string;
};

/**
 * 用户在 AskUserChoiceCard 点「提交」——一次交全卡所有回答（ask_user_choice 工具）。
 * router 按 askId 找到 waiter resolve，阻塞中的 tool.execute 拿到回答在原轮继续。
 * 没选的题在 answers 里 skipped=true（含多选 0 项提交）。
 */
export type AnswerUserChoiceReq = {
  type: 'chat.answerUserChoice';
  askId: string;
  answers: AskUserChoiceAnswers;
};
/**
 * 用户在断路器跳闸卡点「继续放行 / 停止」（G01/G04）。router 按 breakerId settle 唤醒挂起的
 * 工具执行：resume=清零接着跑；stop=同时刹停本回合。
 */
export type CircuitBreakDecisionReq = {
  type: 'chat.circuitBreakDecision';
  agentId: string;
  conversationId: string;
  breakerId: string;
  decision: 'resume' | 'stop';
};
export type TaskCancelReq = { type: 'task.cancel'; taskId: string };
export type TaskRollbackReq = { type: 'task.rollback'; taskId: string };
export type TaskRollbackConfirmReq = { type: 'task.rollback.confirm'; taskId: string };
export type TaskRedoRollbackReq = { type: 'task.redoRollback'; taskId: string };
export type TaskAnswerQuestionReq = {
  type: 'task.answerQuestion';
  taskId: string;
  questionId: string;
  answer: string;
};
export type TaskCancelTwinWaitReq = { type: 'task.cancelTwinWait'; taskId: string };
export type ProposalDiscardReq = { type: 'proposal.discard'; proposalId: string };

// 已授权清单（S24 · G30）——「始终允许」持久授权的唯一可见/可撤销面。reqId 由 ClientRequest 基类带。
export type GrantListReq = { type: 'grants.list' };
export type GrantRevokeReq = { type: 'grants.revoke'; key: string };
/**
 * 设置页策略表拨杆「开→免卡」写授权（2026-07-30 决策 3）——语义对齐卡上「始终允许」，
 * 此前授权写入只有 settleApprovalDecision 一个内部调用方、从未暴露 ws 面。
 * label 不由请求方给：handler 经行为注册表按 owner 语言推导（与 settle 烘焙同词同语）。
 */
export type GrantAddReq = { type: 'grants.add'; scope: GrantScope };

// 行为收紧覆盖（2026-07-31 策略表双向开关）——「默认不问的行拨成每次问」的行 id 集读写面。
export type BehaviorPolicyListReq = { type: 'behaviorPolicy.list' };
/** 拨杆写口：rowId 限注册表 askable 行（后端白名单校验），ask=true 每次问 / false 恢复默认不问。 */
export type BehaviorPolicySetAskReq = { type: 'behaviorPolicy.setAsk'; rowId: string; ask: boolean };

// memory
export type MemoryUndoReq = {
  type: 'memory.undo';
  /** 撤销状态要落盘回对话 JSONL，而 conversations/store 的读写都以 agentId 为第一参数（无反查） */
  agentId: string;
  conversationId: string;
  /** 对应记忆消息的 messageId（前端从 ChatMessage.id 拿） */
  messageId: string;
  /** 目标记忆的相对路径（相对 ~/.oru/memory/） */
  relPath: string;
  /**
   * 档案类记忆：那次写入后完整文件内容的 hash（卡片 payload 的 revertHash）。带上＝回滚这一次
   * 写入而非挪走文件——档案里没有可整体移走的「这条记忆」。主进程据它认出该版并校验「之后
   * 没再被动过」，不成立即拒绝。缺省＝episode，整条移进回收站。
   */
  revertHash?: string;
};
export type MemoryListEpisodesReq = {
  type: 'memory.listEpisodes';
  /** 是否包含 superseded 状态的事件（默认 false） */
  includeSuperseded?: boolean;
};
export type MemoryReadEpisodeReq = {
  type: 'memory.readEpisode';
  /** 相对 ~/.oru/memory/ 的路径 */
  relPath: string;
};
export type MemoryDeleteEpisodeReq = {
  type: 'memory.deleteEpisode';
  relPath: string;
};
/** 读 dream 变更记录（memory/changelog.md 全文，手账「整理记录」节渲染） */
export type MemoryReadChangelogReq = {
  type: 'memory.readChangelog';
};
/** 开发者入口：手动触发一次 dream 复盘 */
export type MemoryDreamRunNowReq = {
  type: 'memory.dream.runNow';
};

// ─── Memory v2 Page IPC ─────────────────────────────────────
export type MemoryApplyOpsReq = {
  type: 'memory.applyOps';
  ops: MemoryOp[];
  /** 默认 'ui'（更窄权限）；后端写入路径必须显式传 'record' / 'capture' / 'dream'。 */
  origin?: MemoryOpOrigin;
};
export type MemoryAgentSelfReadReq = { type: 'memory.agentSelf.read' };
export type MemoryProjectProfileReadReq = {
  type: 'memory.projectProfile.read';
  projectId: string;
};
export type MemoryProjectListReadAllReq = { type: 'memory.projectList.readAll' };
// 自由分章档案（user/profile.md · self.md · 项目 profile.md 统一走文档模型）：读返回 ProfileDoc，
// 写整篇覆盖（前端改 ProfileDoc 结构后回传，后端 renderProfileDoc + writeMemoryDocument）。
export type MemoryDocReadReq = { type: 'memory.doc.read'; relPath: string };
export type MemoryDocWriteReq = { type: 'memory.doc.write'; relPath: string; doc: ProfileDoc };
// 档案历史通道（Task 4）
export type MemoryHistoryListReq = { type: 'memory.history.list'; relPath: string };
export type MemoryHistoryGetReq = { type: 'memory.history.get'; relPath: string; snapshotId: string };
export type MemoryHistoryRestoreReq = { type: 'memory.history.restore'; relPath: string; snapshotId: string };
export type MemoryEpisodeReadPredecessorReq = {
  type: 'memory.episode.readPredecessor';
  /** 完整 relPath，由 renderer 已经从 episode 列表拿到 */
  relPath: string;
};

// 档案编辑原始 live 通道（Task 1）
/** 读档案原始 body（不解析 ProfileDoc，编辑器用）。回 memory.doc.live 事件。 */
export type MemoryDocReadLiveReq = { type: 'memory.doc.readLive'; relPath: string };
/** 写档案原始 body（编辑器保存路径，支持三方合并 + discarded 兜底）。回 memory.doc.live 事件。 */
export type MemoryDocWriteLiveReq = {
  type: 'memory.doc.writeLive';
  relPath: string;
  content: string;
  baseline?: string;
  mergeOnStale?: boolean;
  // WS 写只来自用户，只能打 manual；AI 标（'ai'）走 writeMemoryDocument 内部调用、不经此通道
  mark?: 'manual';
};

// git
export type GitStatusReq = { type: 'git.status'; projectId: string };
export type GitDiffReq = { type: 'git.diff'; projectId: string };
export type GitCommitReq = { type: 'git.commit'; projectId: string; message: string };
export type GitPushReq = { type: 'git.push'; projectId: string };

// settings / auth
export type SettingsGetReq = { type: 'settings.get' };
export type SettingsUpdateReq = { type: 'settings.update'; settings: Partial<Settings> };

// ─── 用量账本（S13 · G110）────────────────────────────────────────────
/** 拉全量用量日桶——渲染层按选定时间范围本地聚合（切换范围无需再往返）。 */
export type UsageGetReq = { type: 'usage.get' };

// ─── 系统信号（S14 · G106/G127）───────────────────────────────────────
/**
 * 不归任何对话的系统信号种类：渠道掉线 / 凭据过期 / 存储损坏 / 写盘失败 / 调度停摆 /
 * 预算警戒（软线，事前警戒）/ 预算耗尽（硬上限，无人值守已暂停待处置）。
 */
export type SystemSignalKind =
  | 'channel-offline'
  | 'credential-expired'
  | 'storage-corruption'
  | 'write-failed'
  | 'scheduler-stalled'
  | 'budget-warning'
  | 'budget-exhausted'
  | 'history-milestone-archived'
  | 'history-conflict-recoverable'
  /** 旧撤销缺陷（2026-07-27 前档案卡撤销＝删整份档案）误删的档案仍在记忆回收站，提示可找回 */
  | 'trashed-profile-found';

/**
 * 一条系统信号。title 由渲染层按 kind + params 译（UI 拥有 i18n）；detail 是原始诊断细节
 * （含协议 / jargon，不翻）。id 是去重键，同源同实例复发只更新不新增。
 */
export type SystemSignal = {
  id: string;
  kind: SystemSignalKind;
  severity: 'warning' | 'critical';
  params?: Record<string, string | number>;
  detail?: string;
  createdAt: number;
};

// ─── 找人阶梯第二级 · 系统级通知（S30·G51）────────────────────────────
/** 一条需要用户处理的对话，供主进程弹系统通知（title=对话名、body=为何找你，均由渲染端按 i18n 组好）。 */
export type DesktopAttentionItem = { agentId: string; convId: string; title: string; body: string };
/**
 * 渲染端把当前「需要你处理」集合推给主进程（每次变更发一次，fire-and-forget）——主进程据自己的前台态决定：
 * 应用不在前台时给新增项弹系统通知、把程序坞角标设成集合大小；在前台则清角标不弹（窗口内 L1 已覆盖）。
 */
export type DesktopAttentionReq = { type: 'desktop.attention'; items: DesktopAttentionItem[] };
/** 用户点了系统通知：主进程 focus 窗口后广播这条，渲染端切到对应对话（复用 setActive）。 */
export type DesktopOpenConversationEvent = { type: 'desktop.openConversation'; agentId: string; convId: string };

/** 通用 todo（计划清单，S32·G49）：AI 调 todo 工具更新计划清单后广播给前端展示（overwrite 覆盖式）。 */
export type ChatTodoEvent = { type: 'chat.todo'; conversationId: string; items: TodoItem[] };
/**
 * 拉某条对话当前的计划清单（渲染层切对话 / 连上后取初值，之后靠 chat.todo 广播增量）。
 * 清单按对话落盘、活过重启，没有这条通道就成了「模型每轮看得见、用户屏幕上空空如也」。
 */
export type ChatTodoListReq = { type: 'chat.todo.list'; agentId: string; conversationId: string };

/** 拉当前在场的系统信号（渲染层连上后取初值，之后靠 system.signals 广播增量）。 */
export type SystemSignalsListReq = { type: 'system.signals.list' };
/** 用户忽略一条系统信号（本地隐藏，不删底层问题；自愈后可再提示）。 */
export type SystemSignalDismissReq = { type: 'system.signals.dismiss'; id: string };

// ─── 定时任务 ────────────────────────────────────────────────────────
export type ScheduledTaskListReq = { type: 'scheduledTask.list'; scope?: ScheduledTaskScope };
/** ⋯ 菜单「立即执行」——补跑一次（runTaskNow）。建/改/删/启停/错过区都走组端点。 */
export type ScheduledTaskRunReq = { type: 'scheduledTask.run'; id: string };
/** 频率预览：自然语言频率 + 接下来三次触发时刻（cron 解析单一事实来源在主进程）。 */
export type ScheduledTaskPreviewReq = { type: 'scheduledTask.preview'; spec: ScheduleSpec };
/**
 * 查询当前后台执行中的定时任务 id（S18）——前端重载后靠它恢复「执行中」指示（临时态不落历史）；
 * 应用重启执行体不存活，返回空、指示自然消失。
 */
export type ScheduledTaskInflightReq = { type: 'scheduledTask.inflight' };

// ─── 组端点（多触发规则）：一个「用户任务」= 多条共享 groupId 的底层 task；组写走 groupOps ──
export type ScheduledTaskCreateGroupReq = { type: 'scheduledTask.createGroup'; input: TaskGroupInput };
export type ScheduledTaskUpdateGroupReq = {
  type: 'scheduledTask.updateGroup';
  groupId: string;
  input: TaskGroupInput;
};
export type ScheduledTaskSetGroupEnabledReq = {
  type: 'scheduledTask.setGroupEnabled';
  groupId: string;
  enabled: boolean;
};
export type ScheduledTaskDeleteGroupReq = { type: 'scheduledTask.deleteGroup'; groupId: string };
/** 错过待处理区组级「执行」——补跑组内所有错过规则。 */
export type ScheduledTaskRunGroupMissedReq = { type: 'scheduledTask.runGroupMissed'; groupId: string };
/** 错过待处理区组级「忽略」——忽略整组错过。 */
export type ScheduledTaskDismissGroupMissedReq = {
  type: 'scheduledTask.dismissGroupMissed';
  groupId: string;
};

// ─── 后台命令（S19 登记表 → 对话内后台命令行）────────────────────────
/** 全量后台命令快照（连上/重连时取初值；增量走 bgCommand.changed 广播）。 */
export type BgCommandListReq = { type: 'bgCommand.list' };
/** 读某条后台命令的累积输出尾部（详情浮层「查看输出」）。 */
export type BgCommandOutputReq = { type: 'bgCommand.output'; id: string };

// ─── 三方平台接入（设置页「平台连接」）──────────────────────────────
/** 拉平台配置 + 连接状态（凭证只回「是否已配置」布尔，红线 1 绝不回密文）。 */
export type PlatformGetConfigReq = { type: 'platform.getConfig' };
/** 写凭证（密文经此一次性进主进程的 credentialStore，永不回读）。 */
export type PlatformSetCredentialReq = {
  type: 'platform.setCredential';
  platform: Platform;
  appId?: string;
  appSecret?: string;
  botToken?: string;
};
export type PlatformClearCredentialReq = { type: 'platform.clearCredential'; platform: Platform };
export type PlatformSetEnabledReq = { type: 'platform.setEnabled'; platform: Platform; enabled: boolean };
export type PlatformSetRemoteAgentReq = { type: 'platform.setRemoteAgent'; agentId: string | null };
/** 生成一次性配对码（显示在桌面，平台侧发回完成绑定）。 */
export type PlatformIssuePairingCodeReq = { type: 'platform.issuePairingCode' };
export type PlatformRemoveWhitelistReq = { type: 'platform.removeFromWhitelist'; id: string };
/** 设置里手动把一个用户 ID 加进白名单（除「发配对码绑定」外的直接入口，source:'manual'）。 */
export type PlatformAddWhitelistReq = { type: 'platform.addToWhitelist'; id: string; platform: Platform };
/** 生成飞书「一键开通权限」深链 + 所需 scope 全集（schema 自动算 + PoC 种子并集）。 */
export type PlatformFeishuScopeLinkReq = { type: 'platform.feishuScopeLink' };
/** 飞书首次自检：跑 doctor + 校验所需 scope，缺啥给直达申请链接。 */
export type PlatformDoctorReq = { type: 'platform.doctor' };
/** 飞书用户授权（S5 · device flow）：发起（顶替进行中的 flow）/ 取消 / 解除授权（清 token）。 */
export type PlatformFeishuUserAuthStartReq = { type: 'platform.feishuUserAuthStart' };
export type PlatformFeishuUserAuthCancelReq = { type: 'platform.feishuUserAuthCancel' };
export type PlatformFeishuUserAuthRevokeReq = { type: 'platform.feishuUserAuthRevoke' };
/** 把当前 pending 态的授权链接发到已绑定飞书用户的私聊（「链接可发飞书」）。 */
export type PlatformFeishuUserAuthSendLinkReq = { type: 'platform.feishuUserAuthSendLink' };
export type AuthStatusReq = { type: 'auth.status' };

// prompt 工作台
/** 拉全部 prompt 清单（只回 meta，不带 body）*/
export type PromptsListReq = { type: 'prompts.list' };
/** 拉单段 prompt 全文（含 body）*/
export type PromptsGetReq = { type: 'prompts.get'; id: string };
/** 调试跑：用指定 model + system 上下文跑一次 completion */
export type PromptbenchRunReq = {
  type: 'promptbench.run';
  modelId: string;
  systemContext: string;
  input: string;
};

// backend providers / models / assignments
export type ProvidersListReq = { type: 'providers.list' };
export type ProvidersAddReq = {
  type: 'providers.add';
  /** 不带 id；id 由主进程生成 */
  provider: Omit<BackendProvider, 'id'>;
};
export type ProvidersUpdateReq = {
  type: 'providers.update';
  id: string;
  /** 允许修改的字段；不能改 type（避免数据形态错位，删了重建） */
  patch: Partial<Pick<BackendProvider, 'label' | 'apiKey' | 'baseUrl'>>;
};
export type ProvidersRemoveReq = { type: 'providers.remove'; id: string };
/** 测试与某 provider 的连通性——主进程发一次最小 chat call */
export type ProvidersTestReq = { type: 'providers.test'; id: string };

/** 测试与某搜索引擎的连通性——主进程发一次最小 query */
export type WebSearchTestEngineReq = {
  type: 'webSearch.testEngine';
  engineType: SearchEngineType;
  apiKey: string;
};

/** 测试某个外部 MCP server 的连通性（v0.5）—— Settings ▸ MCP 服务 ▸ [测试连接] 触发 */
export type McpTestConnectionReq = {
  type: 'mcp.testConnection';
  serverId: string;
};

/** 拉取某 MCP server 当前暴露的工具列表（用于 Settings UI 显示）*/
export type McpListToolsReq = {
  type: 'mcp.listTools';
  serverId: string;
};

/** 重启某 MCP server 子进程（settings 改动后或诊断用）*/
export type McpRestartReq = {
  type: 'mcp.restart';
  serverId: string;
  /**
   * v0.5.4：takeOver=true 时启动前先 pkill 所有其他 chrome-devtools-mcp 实例
   * （Claude Code / Cursor 等都会被断开）—— 解决 Chrome 144+ autoConnect "单 MCP client" 限制
   */
  takeOver?: boolean;
};

/** 新建一个 MCP server（v0.6）—— id 由后端生成，不接受客户端传 */
export type McpCreateReq = {
  type: 'mcp.create';
  config: McpServerCreateInput;
};

/** 修改现有 MCP server 的配置（v0.6）—— 改 enabled 触发即时启停 */
export type McpUpdateReq = {
  type: 'mcp.update';
  serverId: string;
  patch: McpServerPatch;
};

/** 删除一个 MCP server（v0.6）—— stopServer + 从 settings 移除 */
export type McpDeleteReq = {
  type: 'mcp.delete';
  serverId: string;
};

/** 拉所有 MCP server 的运行时状态（v0.6）—— Settings UI 加载时拉一次 */
export type McpRuntimeListReq = {
  type: 'mcp.runtime.list';
};

export type ModelsListReq = { type: 'models.list' };
export type ModelsAddReq = {
  type: 'models.add';
  /** 不带 id；id 由主进程生成 */
  model: Omit<RegisteredModel, 'id'>;
};
export type ModelsRemoveReq = { type: 'models.remove'; id: string };
export type ModelsUpdateReq = {
  type: 'models.update';
  id: string;
  /**
   * 允许修改的字段；不能改 modelId / providerId（这俩变了等于换模型，请删重加）。
   * 校验同 add：contextWindow ≥ 1024；maxOutputTokens 若给须 ≤ 合并后的 contextWindow。
   */
  patch: Partial<
    Pick<
      RegisteredModel,
      | 'label'
      | 'contextWindow'
      | 'supportsVision'
      | 'maxOutputTokens'
      | 'supportsPromptCache'
      | 'supportsReasoning'
      | 'reasoningEffort'
    >
  >;
};

export type ModelAssignmentsUpdateReq = {
  type: 'modelAssignments.update';
  usage: LlmUsage;
  /** RegisteredModel.id；null 表示清空该用途 */
  modelId: string | null;
};

export type ModelThinkingUpdateReq = {
  type: 'modelThinking.update';
  usage: LlmUsage;
  /** 该用途是否开启思考 */
  thinking: boolean;
};

// taskboard
export type TaskboardListReq = { type: 'taskboard.list'; filters?: BoardTaskFilters };
export type TaskboardCreateReq = {
  type: 'taskboard.create';
  title: string;
  description?: string;
  status?: BoardTaskStatus;
  assignee?: BoardActorId;
  projectTag?: string;
  /** 描述图片（渲染端暂存的 base64）；建 task 拿到 id 后服务端落盘，取消即不发→无孤儿 */
  attachments?: WireImageAttachment[];
};
/**
 * 增删任务描述图片，**增量语义**：add=新增 base64、removeRelPaths=要删的既有附件 relPath。
 * 服务端锁内基于最新盘做「删 removeRelPaths + 追加 saved」——并发两次增删各自组合、不互相覆盖
 * （不用渲染端算好全集覆盖写，那会因快照过期丢图）。
 */
export type TaskboardSetAttachmentsReq = {
  type: 'taskboard.setAttachments';
  taskId: string;
  add?: WireImageAttachment[];
  removeRelPaths?: string[];
};
export type TaskboardUpdateReq = {
  type: 'taskboard.update';
  id: string;
  patch: Partial<Pick<BoardTask, 'title' | 'description' | 'status' | 'assignee' | 'projectTag'>>;
};
export type TaskboardDeleteReq = { type: 'taskboard.delete'; id: string };
export type TaskboardRestoreReq = { type: 'taskboard.restore'; id: string };
export type TaskboardGetReq = { type: 'taskboard.get'; id: string };

// taskboard 评论（PR-D1：协议；PR-D2 接 router）
/** plain 留言——仅 appendMessage，不触发 agent */
export type TaskboardNoteAddReq = {
  type: 'taskboard.note.add';
  taskId: string;
  text: string;
  mentions?: BoardActorId[];
  /** 前端乐观插入临时 id；服务端原样回传到 .added.tempId */
  tempId?: string;
  /** 评论图片（与 chat.send 同形态）；非 vision 模型也照存照显示，仅喂模型时被剔除 */
  attachments?: WireImageAttachment[];
};
/** @Oru 触发 agent run（mentions 必含 'oru'） */
export type TaskboardCommentSendReq = {
  type: 'taskboard.comment.send';
  taskId: string;
  text: string;
  mentions: BoardActorId[];
  tempId?: string;
  /** 评论图片（与 chat.send 同形态）；vision 模型 @oru 时进模型输入，非 vision 自动剔除 */
  attachments?: WireImageAttachment[];
};
/** 拉评论历史（含懒创建评论 conv） */
export type TaskboardCommentsReq = { type: 'taskboard.comments'; taskId: string };
/** 用户停止本任务下的 Oru 调用；MVP 不暴露 UI，协议留口 */
export type TaskboardCommentAbortReq = { type: 'taskboard.comment.abort'; taskId: string };
/** 删一条评论（用户留言）——只删该条 message，@oru 母评论下的 Oru 回复保留（PM 2026-07-15 拍板） */
export type TaskboardNoteDeleteReq = {
  type: 'taskboard.note.delete';
  taskId: string;
  messageId: string;
};

// system
export type SystemOpenPathReq = { type: 'system.openPath'; path: string };

// 全局点睛（系统级唤起对话）的权限引导——查状态 + 跳系统设置面板（替代已删的 Tray 入口）
/** 查两道系统权限：屏幕录制可查；输入监控无 API、固定 'unknown'。 */
export type DesktopPresencePermissionsReq = { type: 'desktopPresence.permissions' };
/** 跳系统设置手动授权（程序内无法直接申请这两道权限）。 */
export type DesktopPresenceOpenPermissionReq = {
  type: 'desktopPresence.openPermission';
  target: 'screen' | 'input';
};
/** 屏幕录制取 electron getMediaAccessStatus 的值；输入监控查不了，固定 'unknown'。 */
export type DesktopPresencePermissionsResultEvent = {
  type: 'desktopPresence.permissions.result';
  screenRecording: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
};

// ─── Skill 模块（v1）────────────────────────────────────────────
//
// Plugin / Skill 的 12 个 WS 动词。命名规范跟 mcp.* 一致：
// 请求 type 用 'plugin.<verb>' / 'skill.<verb>'；响应用 'plugin.<verb>.result'。

export type PluginListReq = { type: 'plugin.list' };
export type PluginGetReq = { type: 'plugin.get'; pluginId: string };
export type PluginInstallReq = {
  type: 'plugin.install';
  githubUrl: string;
  /** 可选锁定 commit；默认锁 HEAD */
  commit?: string;
  /** 触发安装的 conversation；缺省用 active main conv */
  conversationId?: string;
};
export type PluginUninstallReq = {
  type: 'plugin.uninstall';
  pluginId: string;
  conversationId?: string;
};
export type PluginUpdateReq = {
  type: 'plugin.update';
  pluginId: string;
  conversationId?: string;
};
export type PluginCheckUpdatesReq = { type: 'plugin.checkUpdates' };
export type PluginGetUpdateDiffReq = { type: 'plugin.getUpdateDiff'; pluginId: string };
export type PluginSetEnabledReq = { type: 'plugin.setEnabled'; pluginId: string; enabled: boolean };

export type SkillListReq = { type: 'skill.list' };
export type SkillGetReq = { type: 'skill.get'; skillId: string };
export type SkillCreateReq = {
  type: 'skill.create';
  name: string;
  skillMd: string;
  scripts?: Array<{ relPath: string; content: string }>;
  conversationId?: string;
};
export type SkillPatchReq = {
  type: 'skill.patch';
  target: 'skill' | 'plugin-manifest';
  name: string;
  oldString: string;
  newString: string;
  conversationId?: string;
};
export type SkillDeleteReq = { type: 'skill.delete'; skillId: string };
export type SkillSetEnabledReq = { type: 'skill.setEnabled'; skillId: string; enabled: boolean };

// ─── Deck 模块（v1）────────────────────────────────────────────
//
// 命名：请求动词两段 camelCase；reply 加 .result 后缀（同 mcp.* / plugin.* / skill.* / git.*）
// 详细设计：docs/tech/2026-05-26-html-deck-tech-design.md §12

/** 列出某项目下所有 deck + 当前 active artifactId */
export type DeckListReq = { type: typeof ARTIFACT_MSG.list; projectId: string };

/** 切换 active deck；null = 关闭 deck mode 退回普通 chat */
export type DeckActivateReq = { type: typeof ARTIFACT_MSG.activate; artifactId: string | null };

/**
 * 收编现有文件夹为 deck（「加入演示稿」，deck 找回 §3.2）。
 * path 为相对项目根（POSIX）；main 拼绝对路径、校验在项目下、二次确认 segmentSlides≥1。
 */
export type ArtifactAdoptReq = { type: typeof ARTIFACT_MSG.adopt; projectId: string; path: string };

export type ArtifactAdoptResultEvent =
  | { type: typeof ARTIFACT_MSG.adoptResult; ok: true; artifactId: string }
  | { type: typeof ARTIFACT_MSG.adoptResult; ok: false; message: string };

/**
 * 加一条框选 region 注释；payload 含 comment + 捕获快照 + locator，main 补 id/时间戳/status。
 * crop 截图 bytes（base64 PNG）可选——框选阶段才真正传图；不传则 cropPath=''。
 */
export type DeckAddAnnotationReq = {
  type: typeof ARTIFACT_MSG.addAnnotation;
  artifactId: string;
  annotation: Pick<Annotation, 'comment' | 'htmlSnippet' | 'text' | 'locator'>;
  /** crop 截图 base64 PNG（无 data: 前缀）；落到 .annotations/crops/<id>.png */
  cropPngBase64?: string;
};

/** 改注释 comment（patch 子集；pageIndex 不可改——改就是新建一条） */
export type DeckUpdateAnnotationReq = {
  type: typeof ARTIFACT_MSG.updateAnnotation;
  artifactId: string;
  annotationId: string;
  patch: Partial<Pick<Annotation, 'comment'>>;
};

export type DeckRemoveAnnotationReq = {
  type: typeof ARTIFACT_MSG.removeAnnotation;
  artifactId: string;
  annotationId: string;
};

/**
 * 提交一批标注（执行权交对话 LLM，设计 §6.2）：
 * 防护性 commit + 标注转 submitted + 建 Submission，返回注入对话的 payload。
 */
export type ArtifactSubmitAnnotationsReq = {
  type: typeof ARTIFACT_MSG.submitAnnotations;
  artifactId: string;
  annotationIds: string[];
  conversationId: string;
};

/** submitAnnotations 注入 payload 单项——前端据此预填 composer（comment + crop 图） */
export type ArtifactSubmitPayloadItem = {
  annotationId: string;
  comment: string;
  /** crop 截图相对路径（`.annotations/crops/<id>.png`），无截图时空串 */
  cropPath: string;
  /**
   * crop 截图字节（纯 base64，不带 `data:` 前缀）。无截图时省略。
   * 后端直接给字节——renderer 在 Vite dev 下是 http 源，fetch file:// 被 webSecurity 拦，
   * 拿不到磁盘 crop，只能由后端在响应里带。
   *
   * 为什么不复用 `oru-avatar://` 那套自定义 protocol（也能让 renderer 按路径读盘字节）：
   * crop ≤8 张小 png、提交是低频动作、走 localhost IPC，第二次传字节成本可忽略；用 payload
   * 内联省掉注册新 protocol + 把 file:// 缩略图全改成 protocol URL 的改动面。若日后 crop 体积
   * 涨上来，再切 protocol。
   */
  cropBase64?: string;
};

// ok 判别联合：ok=true 时三件套必填（语义本就必填，不再标可选骗类型）；ok=false 时只带 message
export type ArtifactSubmitAnnotationsResult =
  | {
      type: typeof ARTIFACT_MSG.submitAnnotationsResult;
      artifactId: string;
      ok: true;
      groupId: string;
      beforeVersionId: string;
      payload: ArtifactSubmitPayloadItem[];
    }
  | {
      type: typeof ARTIFACT_MSG.submitAnnotationsResult;
      artifactId: string;
      ok: false;
      /** 拒绝原因（如已有未完成提交组） */
      message: string;
    };

/**
 * 据当前文稿更新这份演示设计——一次提交：复用提交组路径建组，
 * 主对话据文稿全文手术式改 index.html 后调收尾工具落版本。
 * includeAnnotations=true 时把该 deck 所有 pending 标注一并并入组（连标注一起改）。
 */
export type ArtifactUpdateFromNarrativeReq = {
  type: typeof ARTIFACT_MSG.updateFromNarrative;
  artifactId: string;
  conversationId: string;
  includeAnnotations: boolean;
};

/** 用户手动「标记完成」——走与 AI 收尾同一逻辑，results 空 = 全成功 */
export type ArtifactManualFinalizeReq = {
  type: typeof ARTIFACT_MSG.manualFinalize;
  artifactId: string;
  groupId: string;
};

/** 停止修改（撤回，设计 §6.5）——标注回 pending、清 groupId、删 Submission */
export type ArtifactStopSubmissionReq = {
  type: typeof ARTIFACT_MSG.stopSubmission;
  artifactId: string;
  groupId: string;
};

/** 保存提交组（接受改后态）——index.html 不动，组解散、剩余 failed 标注清 groupId */
export type ArtifactSaveSubmissionReq = {
  type: typeof ARTIFACT_MSG.saveSubmission;
  artifactId: string;
  groupId: string;
};

/** 取消提交组（回退改前态）——checkout beforeVersion 写回 index.html，组解散 */
export type ArtifactCancelSubmissionReq = {
  type: typeof ARTIFACT_MSG.cancelSubmission;
  artifactId: string;
  groupId: string;
};

/** 「退回改前」（崩溃中断组，PRD §六-6）——据中断记录 checkout beforeVersion、标注降级、清记录 */
export type ArtifactDiscardInterruptedReq = {
  type: typeof ARTIFACT_MSG.discardInterrupted;
  artifactId: string;
  groupId: string;
};

/** 进入对比——把 before/after 快照临时写到制品根目录，回相对名 */
export type ArtifactEnterCompareReq = {
  type: typeof ARTIFACT_MSG.enterCompare;
  artifactId: string;
  groupId: string;
};

/** 退出对比——删两个临时快照文件 */
export type ArtifactExitCompareReq = {
  type: typeof ARTIFACT_MSG.exitCompare;
  artifactId: string;
};

/** enterCompare 结果：两份临时快照的相对名（前端自己拼 fileUrl） */
export type ArtifactEnterCompareResult = {
  type: typeof ARTIFACT_MSG.enterCompareResult;
  beforeFile: string;
  afterFile: string;
};

// ─── HTML 标注提交（项目B 第三期 Task14，与 artifact.* 对称、keyed by htmlPath）─────────
// 松散 HTML 不套 artifactId：每条带 htmlPath，handler 解析 htmlTarget(htmlPath) 喂共用提交内核。
// 字段语义逐条同对应 artifact.* 消息，只把 artifactId 换成 htmlPath（绝对路径）。

/** 打开 html 预览时加载其 sidecar 标注 + 提交组视图（deck 由 artifact.activate 触发，html 显式拉一次）。
 *  顺带 reconcile 孤儿提交组（崩溃后降级/「已中断」派生），同 deck activate 口径。 */
export type HtmlActivateReq = { type: typeof HTML_MSG.activate; htmlPath: string };
export type HtmlActivateResult = {
  type: typeof HTML_MSG.activateResult;
  htmlPath: string;
  annotations: Annotation[];
  /** 活跃组 / 「已中断」派生视图 / null（同 submissionChanged 的口径） */
  submission: ArtifactSubmissionView | null;
};

export type HtmlAddAnnotationReq = {
  type: typeof HTML_MSG.addAnnotation;
  htmlPath: string;
  // locator 可选：html 不存定位（PRD「点卡片不跳」），省略 → 后端归零 locator
  annotation: Pick<Annotation, 'comment' | 'htmlSnippet' | 'text'> & { locator?: Annotation['locator'] };
  /** crop 截图 base64 PNG（无 data: 前缀）；落到 sidecar 的 crops 目录 */
  cropPngBase64?: string;
};
export type HtmlUpdateAnnotationReq = {
  type: typeof HTML_MSG.updateAnnotation;
  htmlPath: string;
  annotationId: string;
  patch: Partial<Pick<Annotation, 'comment'>>;
};
export type HtmlRemoveAnnotationReq = {
  type: typeof HTML_MSG.removeAnnotation;
  htmlPath: string;
  annotationId: string;
};
export type HtmlSubmitAnnotationsReq = {
  type: typeof HTML_MSG.submitAnnotations;
  htmlPath: string;
  annotationIds: string[];
  conversationId: string;
};
// ok 判别联合，同 ArtifactSubmitAnnotationsResult；payload 单项复用 ArtifactSubmitPayloadItem
export type HtmlSubmitAnnotationsResult =
  | {
      type: typeof HTML_MSG.submitAnnotationsResult;
      htmlPath: string;
      ok: true;
      groupId: string;
      beforeVersionId: string;
      payload: ArtifactSubmitPayloadItem[];
    }
  | {
      type: typeof HTML_MSG.submitAnnotationsResult;
      htmlPath: string;
      ok: false;
      message: string;
    };
export type HtmlManualFinalizeReq = { type: typeof HTML_MSG.manualFinalize; htmlPath: string; groupId: string };
export type HtmlStopSubmissionReq = { type: typeof HTML_MSG.stopSubmission; htmlPath: string; groupId: string };
export type HtmlSaveSubmissionReq = { type: typeof HTML_MSG.saveSubmission; htmlPath: string; groupId: string };
export type HtmlCancelSubmissionReq = { type: typeof HTML_MSG.cancelSubmission; htmlPath: string; groupId: string };
export type HtmlDiscardInterruptedReq = { type: typeof HTML_MSG.discardInterrupted; htmlPath: string; groupId: string };
export type HtmlEnterCompareReq = { type: typeof HTML_MSG.enterCompare; htmlPath: string; groupId: string };
export type HtmlExitCompareReq = { type: typeof HTML_MSG.exitCompare; htmlPath: string };
export type HtmlEnterCompareResult = {
  type: typeof HTML_MSG.enterCompareResult;
  beforeFile: string;
  afterFile: string;
};

/**
 * 行内编辑落盘——主进程按 oldText 子串唯一性（或 data-edit-id 快路径）定位、写 index.html、
 * push undo entry、按 30s 防抖排队 commit。oldText/newText = 编辑前后的 innerHTML。
 * markerId 仅 Oru 自产元素源里有 data-edit-id 时带上做快路径，外部 HTML 为 null。
 */
export type DeckApplyInlineEditReq = {
  type: typeof ARTIFACT_MSG.applyInlineEdit;
  artifactId: string;
  markerId?: string | null;
  oldText: string;
  newText: string;
  pageIndex: number;
};

export type DeckListHistoryReq = { type: typeof ARTIFACT_MSG.listHistory; artifactId: string };

/** 切到某版本作为新起点；force=true 跳过 missingImages 询问 */
export type DeckCheckoutHistoryReq = {
  type: typeof ARTIFACT_MSG.checkoutHistory;
  artifactId: string;
  versionId: string;
  force?: boolean;
};

/** 渲染某历史版本的联系表网格图——历史窗口右侧预览（不改动磁盘，只渲图） */
export type DeckHistoryPreviewReq = {
  type: typeof ARTIFACT_MSG.historyPreview;
  artifactId: string;
  versionId: string;
};

/** 导出格式：HTML 单文件自包含 / HTML 打包 zip / PDF / PPT 图片版 */
export type ExportFormat = 'html-inline' | 'html-zip' | 'pdf' | 'pptx';

/**
 * 图片版导出（pdf/pptx）的清晰度档位 = 离屏渲染的 deviceScaleFactor：1 标准 / 2 高清 / 3 超清。
 * 出图分辨率 = 画布尺寸 × scale；页面物理尺寸不变，只是每页位图更精细（也更大）。html 导出无此概念。
 */
export type ExportScale = 1 | 2 | 3;

/** 导出 deck。四种格式一律从磁盘读 deckPath（含 pdf：离屏渲染整份 deck），与实时预览无关。 */
export type DeckExportReq = {
  type: typeof ARTIFACT_MSG.export;
  artifactId: string;
  format: ExportFormat;
  /** 仅 pdf/pptx 有意义；缺省 1（标准）。html 导出忽略。 */
  scale?: ExportScale;
};

/** 取消进行中的图片版导出（按 artifactId）：中断离屏渲染，已渲染的丢弃、不落盘。 */
export type DeckExportCancelReq = {
  type: typeof ARTIFACT_MSG.exportCancel;
  artifactId: string;
};

export type DeckUndoReq = { type: typeof ARTIFACT_MSG.undo; artifactId: string };
export type DeckRedoReq = { type: typeof ARTIFACT_MSG.redo; artifactId: string };

// ─── md 文档导出（自包含 HTML 单文件 / 矢量 PDF）──────────────────────────────
/**
 * 导出编辑器中打开的 md 文档。与 deck 导出的本质差异：HTML 由渲染端 renderToStaticMarkup 产出、
 * 经 `html` 传入完整字符串（真相源只活在前端，主进程是纯执行器，只内联二进制资源 + 各出口落地）。
 * `paperMode` 仅 pdf 有意义（A4 纸张版的物理页边距/页码归主进程 printToPDF，与 pageSize 同处）。
 */
export type DocExportReq = {
  type: 'doc.export';
  projectId: string;
  path: string; // 项目相对文档 path
  html: string;
  format: 'html' | 'pdf';
  paperMode?: boolean;
};
/** 取消进行中的导出（按 projectId+path）：中断 PDF 离屏渲染，不落盘、无残件。 */
export type DocExportCancelReq = { type: 'doc.exportCancel'; projectId: string; path: string };

/** 拖拽重排页面顺序。newOrder[newPos] = oldPageIndex，必须是 0..N-1 的一个排列 */
export type DeckReorderSlidesReq = {
  type: typeof ARTIFACT_MSG.reorderSlides;
  artifactId: string;
  newOrder: number[];
};

/**
 * 事后生成 deck（创建流改造）——供前端空状态 CTA / 标签栏按钮调用（前端入口在 WS2 接）：
 * 据 artifactId 按 .narrative.md + 持久化的 deckSkillId 派 subagent 生成 HTML。
 */
export type ArtifactGenerateDeckReq = {
  type: typeof ARTIFACT_MSG.generateDeck;
  artifactId: string;
  conversationId: string;
};

export type ClientRequestPayload =
  | ProjectsListReq
  | ProjectsAddReq
  | ProjectsRemoveReq
  | ProjectsSwitchReq
  | FsListReq
  | FsWatchReq
  | FsReadMdReq
  | FsWriteMdReq
  | FsWriteTextReq
  | FsTextHashReq
  | FsApplyTextEditReq
  | FsStatReq
  | FsCreateFileReq
  | FsMkdirReq
  | FsRenameReq
  | FsDuplicateReq
  | FsMoveReq
  | FsTrashReq
  | FsRevealReq
  | FileHistoryListReq
  | FileHistoryGetReq
  | FileHistoryRestoreReq
  | FileHistoryClearReq
  | FsHistorySampleReq
  | ConflictOpenedReq
  | ConflictResolvedReq
  | FileHistoryRecordDiscardedReq
  | DesktopAttentionReq
  | FsWriteImageReq
  | TableImportXlsxReq
  | TablePreviewXlsxReq
  | TableResolveImportConflictReq
  | TableOpenReq
  | TablePrefsSetReq
  | TableExportXlsxReq
  | TableRevealExportReq
  | RendererQueryResultReq
  | AgentsListReq
  | AgentsUpdateReq
  | AgentsAvatarUploadReq
  | UserProfileGetReq
  | UserProfileUpdateReq
  | ConvListReq
  | ConvCreateReq
  | ConvDeleteReq
  | ConvArchiveReq
  | ConvRenameReq
  | ConvClearReq
  | ConvCompressReq
  | ConvMarkSeenReq
  | ConvHistoryReq
  | ConvSearchReq
  | ConvGetSubagentSidecarReq
  | AsideCaptureReq
  | AsideCommentReq
  | AsideBeginReq
  | AsideAddReferentReq
  | AsidePromoteReq
  | AsideListReq
  | ChatSendReq
  | LoopStopReq
  | LoopEditChecklistReq
  | ChatAbortReq
  | ChatResumeReq
  | ChatSteeringWithdrawReq
  | ChatSteeringRecoverAckReq
  | ChatQueueReadmitReq
  | ProposalExecuteReq
  | ProposalRejectReq
  | AnswerUserChoiceReq
  | CircuitBreakDecisionReq
  | TaskCancelReq
  | TaskRollbackReq
  | TaskRollbackConfirmReq
  | TaskRedoRollbackReq
  | TaskAnswerQuestionReq
  | TaskCancelTwinWaitReq
  | ProposalDiscardReq
  | GrantListReq
  | GrantRevokeReq
  | GrantAddReq
  | BehaviorPolicyListReq
  | BehaviorPolicySetAskReq
  | MemoryUndoReq
  | MemoryListEpisodesReq
  | MemoryReadChangelogReq
  | MemoryReadEpisodeReq
  | MemoryDeleteEpisodeReq
  | MemoryDreamRunNowReq
  | MemoryApplyOpsReq
  | MemoryDocReadReq
  | MemoryDocWriteReq
  | MemoryHistoryListReq
  | MemoryHistoryGetReq
  | MemoryHistoryRestoreReq
  | MemoryAgentSelfReadReq
  | MemoryProjectProfileReadReq
  | MemoryProjectListReadAllReq
  | MemoryEpisodeReadPredecessorReq
  | MemoryDocReadLiveReq
  | MemoryDocWriteLiveReq
  | GitStatusReq
  | GitDiffReq
  | GitCommitReq
  | GitPushReq
  | SettingsGetReq
  | SettingsUpdateReq
  | UsageGetReq
  | SystemSignalsListReq
  | SystemSignalDismissReq
  | ChatTodoListReq
  | ChatPendingTurnStateQueryReq
  | ChatPendingTurnStateListReq
  | ScheduledTaskListReq
  | ScheduledTaskRunReq
  | ScheduledTaskPreviewReq
  | ScheduledTaskInflightReq
  | ScheduledTaskCreateGroupReq
  | ScheduledTaskUpdateGroupReq
  | ScheduledTaskSetGroupEnabledReq
  | ScheduledTaskDeleteGroupReq
  | ScheduledTaskRunGroupMissedReq
  | ScheduledTaskDismissGroupMissedReq
  | BgCommandListReq
  | BgCommandOutputReq
  | AuthStatusReq
  | PromptsListReq
  | PromptsGetReq
  | PromptbenchRunReq
  | ProvidersListReq
  | ProvidersAddReq
  | ProvidersUpdateReq
  | ProvidersRemoveReq
  | ProvidersTestReq
  | WebSearchTestEngineReq
  | McpTestConnectionReq
  | McpListToolsReq
  | McpRestartReq
  | McpCreateReq
  | McpUpdateReq
  | McpDeleteReq
  | McpRuntimeListReq
  | ModelsListReq
  | ModelsAddReq
  | ModelsRemoveReq
  | ModelsUpdateReq
  | ModelAssignmentsUpdateReq
  | ModelThinkingUpdateReq
  | TaskboardListReq
  | TaskboardCreateReq
  | TaskboardUpdateReq
  | TaskboardDeleteReq
  | TaskboardRestoreReq
  | TaskboardGetReq
  | TaskboardNoteAddReq
  | TaskboardCommentSendReq
  | TaskboardCommentsReq
  | TaskboardCommentAbortReq
  | TaskboardNoteDeleteReq
  | TaskboardSetAttachmentsReq
  | SystemOpenPathReq
  | DesktopPresencePermissionsReq
  | DesktopPresenceOpenPermissionReq
  // Skill 模块 v1
  | PluginListReq
  | PluginGetReq
  | PluginInstallReq
  | PluginUninstallReq
  | PluginUpdateReq
  | PluginCheckUpdatesReq
  | PluginGetUpdateDiffReq
  | PluginSetEnabledReq
  | SkillListReq
  | SkillGetReq
  | SkillCreateReq
  | SkillPatchReq
  | SkillDeleteReq
  | SkillSetEnabledReq
  // Deck 模块 v1
  | DeckListReq
  | DeckActivateReq
  | ArtifactAdoptReq
  | DeckAddAnnotationReq
  | DeckUpdateAnnotationReq
  | DeckRemoveAnnotationReq
  | ArtifactSubmitAnnotationsReq
  | ArtifactUpdateFromNarrativeReq
  | ArtifactManualFinalizeReq
  | ArtifactStopSubmissionReq
  | ArtifactSaveSubmissionReq
  | ArtifactCancelSubmissionReq
  | ArtifactDiscardInterruptedReq
  | ArtifactEnterCompareReq
  | ArtifactExitCompareReq
  // HTML 标注提交（项目B 第三期，keyed by htmlPath）
  | HtmlActivateReq
  | HtmlAddAnnotationReq
  | HtmlUpdateAnnotationReq
  | HtmlRemoveAnnotationReq
  | HtmlSubmitAnnotationsReq
  | HtmlManualFinalizeReq
  | HtmlStopSubmissionReq
  | HtmlSaveSubmissionReq
  | HtmlCancelSubmissionReq
  | HtmlDiscardInterruptedReq
  | HtmlEnterCompareReq
  | HtmlExitCompareReq
  | DeckApplyInlineEditReq
  | DeckListHistoryReq
  | DeckCheckoutHistoryReq
  | DeckHistoryPreviewReq
  | DeckExportReq
  | DeckExportCancelReq
  | DocExportReq
  | DocExportCancelReq
  | DeckUndoReq
  | DeckRedoReq
  | DeckReorderSlidesReq
  | ArtifactGenerateDeckReq
  | PlatformGetConfigReq
  | PlatformSetCredentialReq
  | PlatformClearCredentialReq
  | PlatformSetEnabledReq
  | PlatformSetRemoteAgentReq
  | PlatformIssuePairingCodeReq
  | PlatformRemoveWhitelistReq
  | PlatformAddWhitelistReq
  | PlatformFeishuScopeLinkReq
  | PlatformDoctorReq
  | PlatformFeishuUserAuthStartReq
  | PlatformFeishuUserAuthCancelReq
  | PlatformFeishuUserAuthRevokeReq
  | PlatformFeishuUserAuthSendLinkReq;

export type ClientRequest = ClientRequestPayload & { reqId: string };

// ─── server → client ───────────────────────────────────────────────

// projects
export type ProjectsStateEvent = {
  type: 'projects.state';
  projects: Project[];
  activeId: string | null;
};

// fs
export type FsListResultEvent = {
  type: 'fs.list.result';
  projectId: string;
  path: string;
  entries: FileNode[];
  /** 该目录直接子项超过上限被截断时，未显示的项数；未截断则缺省。截断对用户可见，不静默 */
  truncated?: number;
};

export type FsMdContentEvent = {
  type: 'fs.md.content';
  projectId: string;
  path: string;
  content: string;
};

export type FsMdSavedEvent = {
  type: 'fs.md.saved';
  projectId: string;
  path: string;
  /**
   * S27 落盘结果：缺省 'written'（普通落盘/⌘S）。'merged'=锁内机械合并、content 为合并产物，
   * 编辑器据此把 view+base 换入到 content；'discarded'=撞同段弃写、磁盘未动，编辑器据此开冲突卡。
   */
  result?: 'written' | 'merged' | 'discarded';
  /** result==='merged' 时携合并产物（磁盘现内容）。 */
  content?: string;
};

// fileHistory 结果
export type FileHistoryListResultEvent = {
  type: 'fileHistory.list.result';
  projectId: string;
  path: string;
  snapshots: FileSnapshotRef[];
};
/** fileHistory.get：单个快照内容（预览/diff） */
export type FileHistoryContentEvent = {
  type: 'fileHistory.content';
  projectId: string;
  path: string;
  snapshotId: string;
  content: string;
};
/** fileHistory.restore：恢复后的工作文件内容（前端据此更新编辑器） */
export type FileHistoryRestoredEvent = {
  type: 'fileHistory.restored';
  projectId: string;
  path: string;
  content: string;
};

export type FsTextWriteResultEvent = {
  type: 'fs.text.writeResult';
  projectId: string;
  path: string;
  status: 'saved' | 'conflict';
  mtimeMs?: number;
  /** saved 时为写入内容的 sha256——前端更新基线 */
  sha256?: string;
};

export type FsTextHashEvent = {
  type: 'fs.text.hash';
  projectId: string;
  path: string;
  /** null=文件不存在 */
  sha256: string | null;
  size: number;
  mtimeMs: number;
};

/** fs.stat 应答：绝对路径文件的 mtime（Math.floor 毫秒，与 applyTextEdit 基线校验同口径）。 */
export type FsStatEvent = { type: 'fs.stat.result'; filePath: string; mtimeMs: number };
/** fs.createFile / fs.mkdir 的统一结果（"建文件/建目录"同一族）。mkdir 不会回 invalid */
export type FsCreateResultEvent = {
  type: 'fs.create.result';
  projectId: string;
  path: string;
  status: 'ok' | 'conflict' | 'invalid';
};

/** 改名/副本/移动/删除的统一结果。path=操作后的目标相对路径（移动/改名后的新位置；其余原路径） */
export type FsOpResultEvent = {
  type: 'fs.op.result';
  projectId: string;
  path: string;
  status: 'ok' | 'conflict' | 'invalid' | 'not-found' | 'incomplete';
  /** 改名联动回写引用后的新文档内容——供 relocate 重置编辑器内存态（仅 .md+assets 改名时带）。 */
  content?: string;
};

// table
/** 来源反查命中：同目录脚本头部声明了「写出：该 CSV」。source 取自脚本「来源：」声明，缺省 null */
export type TableProvenance = { script: string; source: string | null };

/**
 * 表格视图偏好（按文件持久化）：列宽 + 整表行高。
 * 落盘时封 `version` 版本号，读出的本类型不含 version（version 是落盘封套，非业务字段）。
 */
// rowHeightPx = 整表默认行高（下拉三档设定）；rowHeightsPx = 按文件行索引的稀疏覆盖（拖某行底边设定），
// 单行取值 = rowHeightsPx[row] ?? rowHeightPx ?? 紧凑。稀疏 map 键=fileRow，只存被显式改过的行。
// 结构增删时随数据移位（行高键、列宽下标都跟着走，撤销恢复被删行/列的原值）——见 tableStore applyPrefs / invertPrefs。
export type TablePrefs = {
  columnWidths?: number[];
  rowHeightPx?: number;
  rowHeightsPx?: Record<number, number>;
};

export type TableOpenedEvent = {
  type: 'table.opened';
  projectId: string;
  path: string;
  /** 数据行数超过 100,000 → 只读预览模式 */
  overLimit: boolean;
  /** ≤ 上限：CSV 全文（renderer 用 shared/csv 解析）；超限时 null */
  content: string | null;
  /** 超限时前 1,001 条记录（[0] 是表头行）；未超限 null */
  previewRows: string[][] | null;
  /** 只看编码（无 BOM 的合法 UTF-8）——保存 / 导出「要不要弹转换确认」的唯一判据 */
  encodingSafe: boolean;
  encoding: 'utf-8' | 'gbk';
  mtimeMs: number;
  /** 磁盘字节 sha256；超限只读时 null（无保存场景） */
  sha256: string | null;
  provenance: TableProvenance[];
  /** 该文件的视图偏好（列宽/行高）随首帧捎带，避免默认列宽渲染后偏好到达再跳布局；无偏好时 null（必填，「无偏好」单一表达为 null）。 */
  prefs: TablePrefs | null;
};

/** 超限文件的总行数异步补报（首屏不等读完全文件） */
export type TableRowCountEvent = { type: 'table.rowCount'; projectId: string; path: string; totalRows: number };

export type TableImportConflictEvent = {
  type: 'table.importConflict';
  conflictId: string;
  projectId: string;
  xlsxPath: string;
  /** 与新转换结果不一致的现有 CSV（项目相对路径），按文件粒度一事一弹 */
  targetPath: string;
};

export type TableConflictResolvedEvent = {
  type: 'table.conflictResolved';
  conflictId: string;
  /** reconflict：弹窗挂起期间磁盘又变了，已按新快照重发一条 importConflict */
  outcome: 'written' | 'savedAs' | 'cancelled' | 'reconflict';
  savedAsPath?: string;
};

export type TableImportFailedEvent = {
  type: 'table.importFailed';
  projectId: string;
  xlsxPath: string;
  message: string;
};

/** 提示级通知（如"上次拆出的 X 本次未出现"），不阻塞任何动作 */
export type TableImportNoticeEvent = {
  type: 'table.importNotice';
  projectId: string;
  xlsxPath: string;
  message: string;
};

/** xlsx 预览单 sheet 数据：CSV 文本（超限时截到表头+前 1,000 行）+ 行数与截断标记 */
export type TableXlsxPreviewSheet = { name: string; csv: string; totalRows: number; overLimit: boolean };

/** table.previewXlsx 回执：成功带 sheets；失败 sheets=null + message（请求-应答语义，不走广播） */
export type TableXlsxPreviewEvent = {
  type: 'table.xlsxPreview';
  projectId: string;
  path: string;
  sheets: TableXlsxPreviewSheet[] | null;
  message?: string;
};

/** 单 sheet 的落盘结果：written=新写/覆盖；identical=与现有 CSV 逐字节一致零写盘；conflict=已挂起冲突待三选一 */
export type TableImportSheetResult = {
  name: string;
  targetPath: string;
  status: 'written' | 'identical' | 'conflict';
};

/** table.importXlsx 回执：逐 sheet 结果（targetPath 供预览原地切换），失败 failed + message */
export type TableImportResultEvent = {
  type: 'table.importResult';
  projectId: string;
  xlsxPath: string;
  sheets: TableImportSheetResult[] | null;
  message?: string;
};

/** 冲突三选一写盘成功（覆盖/另存）后的广播——预览据此完成原地切换（savedAs 时 targetPath=savedAsPath） */
export type TableImportWrittenEvent = {
  type: 'table.importWritten';
  projectId: string;
  xlsxPath: string;
  targetPath: string;
};

export type TableExportedEvent = {
  type: 'table.exported';
  projectId: string;
  path: string;
  /** 用户选定并写出的 xlsx 绝对路径；用户在保存对话框取消时为 null（真失败走错误回执，不到这里）。 */
  xlsxPath: string | null;
};

// AI 闸门撞上非 UTF-8 CSV 时曾广播 table.canonicalConfirmRequired 弹一个 App 级模态框，
// 已由 convert_csv_encoding 的审批卡取代（AI 发起、用户在对话里一键确认）——同一件事不留两套 UI。
// 用户自己保存表格那条路的「转规范 / 另存副本」在 CsvEditor 内嵌，与本事件无关、原样保留。

/** main → renderer 的通用查询（信箱模式，renderer 以 renderer.queryResult 应答，首答生效） */
export type RendererQueryEvent = {
  type: 'renderer.query';
  queryId: string;
  kind: 'dirtySet';
  payload?: unknown;
};

export type FsChangedEvent = {
  type: 'fs.changed';
  projectId: string;
  /** 发生变动的目录（项目相对路径，''=根）。watcher 事件精确到目录；缺省表示来源未知，前端兜底刷所有已展开目录 */
  path?: string;
  /**
   * 发生变动的具体文件（项目相对路径）——协同接收方（编辑器合并、预览刷新）按此精确命中「就是我这个文件」。
   * 仅单文件落盘（用户写 / AI 写）携带；树操作（建/改名/移动/删除）只带目录级 path，不带 filePath。
   * 旧消费者（fsStore/tableStore）只认 path、忽略本字段；新接收方只认 filePath——新旧互不干扰。
   */
  filePath?: string;
  /**
   * S27 作者标（数据哨兵，不翻）：'user'=用户手动落盘、'ai'=AI 落盘、'merged'=锁内机械合并产物。
   * 编辑器**以「磁盘内容是否与我提交的一致」为承重判据**，author 只作快速路径提示（'merged' 必不等于
   * 提交内容故必被换入）；并发下两支同类笔可能撞，单靠 author 不足——内容比对才是真相（理想页 Note 节点）。
   * 供 S28（换笔覆盖可见）/S29（冲突卡收口）消费。树操作/无来源信息可缺省。
   */
  author?: 'user' | 'ai' | 'merged';
};

// agents
export type AgentsStateEvent = {
  type: 'agents.state';
  agents: Agent[];
  activeId: string | null;
};

export type AgentsAvatarUploadResultEvent = {
  type: 'agents.avatar.upload.result';
  agentId: string;
  /** 写入后的绝对文件路径，前端通过 oru-avatar:// 加载 */
  path: string;
};

// user profile state — get / update / 主进程主动广播都用这一个 event
export type UserProfileStateEvent = {
  type: 'user.profile.state';
  profile: UserProfile;
};

// conversations
export type ConvStateEvent = {
  type: 'conv.state';
  agentId: string;
  conversations: Conversation[];
};

export type ConvHistoryResultEvent = {
  type: 'conv.history.result';
  agentId: string;
  conversationId: string;
  messages: ChatMessage[];
};

/**
 * 手动压缩回执（conv.compress 的响应）——四态：compressed（fallback 区分摘要成 / 硬丢兜底）、
 * busy（有回合在跑）、empty（tooShort=对话还太短 / nothingNew=没有新内容可压）、failed。
 */
export type ConvCompressResultEvent = {
  type: 'conv.compress.result';
  agentId: string;
  conversationId: string;
  status: 'compressed' | 'busy' | 'empty' | 'failed';
  fallback?: boolean;
  emptyReason?: 'tooShort' | 'nothingNew';
};

/** 搜索结果一组：一个对话 + 标题是否命中 + 命中的消息（全文，前端做关键词上下文切片 + 高亮） */
export type ConvSearchHit = {
  conversation: Conversation;
  titleHit: boolean;
  messages: Array<{ id: string; role: ChatRole; text: string }>;
};
export type ConvSearchResultEvent = {
  type: 'conv.search.result';
  agentId: string;
  /** 回带本次查询词，前端据此对齐（防抖期间旧结果晚到时丢弃） */
  query: string;
  groups: ConvSearchHit[];
  totalHits: number;
};

export type ConvSubagentSidecarResultEvent = {
  type: 'conv.subagentSidecar.result';
  agentId: string;
  conversationId: string;
  taskId: string;
  /** subagent 内部完整消息流；taskId 不存在时返回空数组（不视为错）  */
  messages: ChatMessage[];
};

// aside（随手评点）
export type AsideCaptureResultEvent = {
  type: 'aside.capture.result';
  /** 主窗口截图 PNG base64（不带 data: 前缀），主进程已归一为逻辑像素 */
  screenshot: string;
};

export type AsideCommentResultEvent = {
  type: 'aside.comment.result';
  /** 短评全文（one-shot 输出，零落盘） */
  text: string;
};

export type AsideBeginResultEvent = {
  type: 'aside.begin.result';
  conversation: Conversation;
  /** 种子消息（按落盘顺序）：指代卡（必有）+ 短评（用户抢话则无） */
  messages: ChatMessage[];
};

/**
 * aside.addReferent 的响应——携带已落盘的指代卡（hydrate 过 displayUrl），渲染端
 * 追加进 chatStore 桶：浮层立即可见这张卡、promote 后 ChatArea（桶非空不拉历史）
 * 开头完整。与 begin 的「响应带数据、渲染端灌桶」同一模式；AI 回应轮次仍经 chat.* 推送。
 */
export type AsideAddReferentResultEvent = {
  type: 'aside.addReferent.result';
  message: ChatMessage;
};

/**
 * aside.list 的响应——独立事件，刻意不借 conv.state：后者语义是 main+sub 全量同步 +
 * 整体替换 + 参与 active 计算，aside 查询是按需、非全量、不参与 active 的另一种语义。
 */
export type AsideListResultEvent = {
  type: 'aside.list.result';
  agentId: string;
  conversations: Conversation[];
};

// chat
export type ChatStartedEvent = {
  type: 'chat.started';
  conversationId: string;
  messageId: string;
};

export type ChatDeltaEvent = {
  type: 'chat.delta';
  conversationId: string;
  messageId: string;
  delta: ChatDelta;
};

export type ChatToolCallEvent = {
  type: 'chat.toolCall';
  conversationId: string;
  messageId: string;
  tool: ToolCall;
};

export type ChatToolResultEvent = {
  type: 'chat.toolResult';
  conversationId: string;
  messageId: string;
  result: ToolResult;
};

/**
 * 前台命令实时输出（S19·G19）——长命令执行期间边跑边把累积输出推给 UI（只给人看，不喂模型；
 * 模型仍到 chat.toolResult 才拿到内容）。渲染层把它挂到该消息里正在运行的 bash 工具卡下滚动显示，
 * 工具结果到达即由 toolResult 接管。chunk 是本次新增的一段输出。
 */
export type ChatCommandOutputEvent = {
  type: 'chat.commandOutput';
  conversationId: string;
  messageId: string;
  chunk: string;
};

export type ChatDoneEvent = {
  type: 'chat.done';
  conversationId: string;
  messageId: string;
};

// ─── Steering（对话忙时中途转向）────────────────────────────────
// 服务端是唯一裁决者；前端只乐观显示，最终态以这些回执/事件为准。

/** 忙时 chat.send 被裁决为「入队」：前端把乐观「将生效」气泡对齐到这个 serverId。必先于 consumed。 */
export type ChatSteeringAddedEvent = {
  type: 'chat.steering.added';
  conversationId: string;
  clientMsgId: string;
  serverId: string;
  /**
   * 渠道排队消息（S10）投影：桌面对渠道入站消息没有乐观「将生效」气泡（不是桌面用户打的字），
   * 靠这两个字段现渲染一条排队气泡。桌面自己的消息不带（前端乐观气泡承载），字段缺省即老语义。
   */
  text?: string;
  origin?: TriggerOrigin;
};

/** 一批「将生效」在动作边界被读入（已落盘为正式 user 消息）：前端气泡落定为已读入。 */
export type ChatSteeringConsumedEvent = {
  type: 'chat.steering.consumed';
  conversationId: string;
  serverIds: string[];
};

/**
 * chat.steering.withdraw 的回执（仅发给请求方，单渲染端足够，故不另发广播）：
 * removed=撤成、前端移除气泡；alreadyConsumed=撤回晚于读入、气泡落定为已读入（不静默/不闪烁）。
 */
export type ChatSteeringWithdrawResultEvent = {
  type: 'chat.steering.withdrawResult';
  conversationId: string;
  clientMsgId: string;
  result: 'removed' | 'alreadyConsumed';
};

/**
 * chat.abort 的回执（S08 · G14）：带回未消费（仍在队列）的队列项投影，前端按 handbackForm 分流——
 * 桌面用户亲手打的字并入输入框草稿；机器触发 / 渠道消息列成待处理项（放行 / 清掉）。已消费的留历史、不在此。
 */
export type ChatAbortResultEvent = {
  type: 'chat.abortResult';
  conversationId: string;
  items: HandbackItem[];
};

/**
 * 故障 / 远程刹车后队列交还（S08 · G14）：回合因故障（error）或远程 /stop 中止而异常结束时，
 * 未消费队列显式交还用户发落——广播同构投影，前端按 handbackForm 分流（同 chat.abortResult）。
 */
export type ChatQueueHandbackEvent = {
  type: 'chat.queue.handback';
  conversationId: string;
  items: HandbackItem[];
};

/**
 * 崩溃盘记交还（对话打开 conv.history 时推送）：上次进程崩溃时还在队列、未消费的队列项，
 * 交还用户发落——前端按 handbackForm 分流（与 chat.abortResult 同形态），随后回
 * chat.steering.recoverAck 确认送达，服务端才清盘记。绝不自动执行。
 */
export type ChatSteeringRecoveredEvent = {
  type: 'chat.steering.recovered';
  agentId: string;
  conversationId: string;
  items: HandbackItem[];
};

/**
 * chat.pendingTurnState.query 的回执：某对话在途回合的「真相快照」，供睡眠唤醒后对账。
 * running=false 表示该回合已被外部中断（真掐断）——前端走「已中断」分支渲染。
 * pendingAsks 是仍在等回答的提问卡（waiter 还在）；inflightPartial 是在途半截（含未节流写盘的
 * 完整内存部分），为空表示无半截产出。
 */
export type ChatPendingTurnStateResultEvent = {
  type: 'chat.pendingTurnState.result';
  conversationId: string;
  running: boolean;
  pendingAsks: { askId: string; questions: AskUserChoiceQuestion[] }[];
  inflightPartial: { messageId: string; text: string; toolCalls: ToolCall[] } | null;
};

/**
 * 主进程 powerMonitor 'wake' 主动推送：携带需要恢复（在途）的对话 id 列表。前端对所列每个
 * 对话发 chat.pendingTurnState.query 拉真相快照。与渲染层 mount 兜底拉互补（窗口已关重开时
 * wake 推收不到的路径）。
 */
export type ChatWakeRecoverEvent = {
  type: 'chat.wakeRecover';
  conversationIds: string[];
};

/** chat.pendingTurnState.list 的回执：当前在途对话的 conversationId 列表（供 mount 兜底拉）。 */
export type ChatPendingTurnStateListResultEvent = {
  type: 'chat.pendingTurnState.list.result';
  conversationIds: string[];
};

/** transport 层重试通知。OpenAI-compatible backend 遇到 5xx/429/网络错时发，
 *  让 UI 状态行显示"🔁 上游错误，正在重试 (n/N)…"。下次 chat.delta 到达时清零。 */
export type ChatRetryingEvent = {
  type: 'chat.retrying';
  conversationId: string;
  messageId: string;
  attempt: number;       // 第几次重试，从 1 开始
  maxRetries: number;    // 上限，给 UI 显示 "n/N"
};

/** 绑定到具体流式消息的错误事件。区别于通用 'error'：后者全局 toast，前者
 *  写到 chatStore 的 message.error，让状态行展示并按 retryable 决定是否给 [重试]。 */
export type ChatErrorEvent = {
  type: 'chat.error';
  conversationId: string;
  messageId: string;
  code: string;
  message: string;
  retryable: boolean;
};

export type ChatProposalEvent = {
  type: 'chat.proposal';
  conversationId: string;
  proposal: ActionProposal;
};

/**
 * 「带选项提问」弹卡（ask_user_choice 工具 execute 内 emit）——携带 askId 供回答 round-trip。
 * 前端按 askId 挂一张待答的交互卡（pending 态只活在实时流里，不进持久化）。
 * 答完 / 中断后由同一 tool 的 chat.toolResult（result.structured=回答）承载只读小结与 replay。
 */
export type ChatAskUserChoiceEvent = {
  type: 'chat.askUserChoice';
  conversationId: string;
  messageId: string;
  askId: string;
  questions: AskUserChoiceQuestion[];
};

/**
 * 断路器跳闸卡广播（G01/G04）——工具调用异常频繁或连续失败时弹出，让用户点「继续放行 / 停止」。
 * pending 态只活在实时流里，不持久化；用户决定经 chat.circuitBreakDecision 回来。
 */
export type ChatCircuitBreakEvent = {
  type: 'chat.circuitBreak';
  conversationId: string;
  messageId: string;
  breakerId: string;
  reason: 'consecutive-failures' | 'high-frequency';
};

/**
 * proposal 落定状态变化广播（v0.6）—— 接受执行成功 / 失败 / 用户拒绝 三种落定时机都发。
 *
 * 卡片 UI 收到后把对应 proposal 的视觉态切到 executed / failed / rejected。
 *
 * mcp.install 成功执行时附带新 serverId，让前端能直接定位到 Settings 详情面板。
 */
export type ProposalStatusChangedEvent = {
  type: 'proposal.statusChanged';
  proposalId: string;
  status: Exclude<ProposalStatus, 'pending'>;
  /** 终态（executed/failed/rejected）才有；executing 进行中无完成时间 */
  completedAt?: number;
  failureMessage?: string;
  serverId?: string;
};

export type ChatTaskReportEvent = {
  type: 'chat.taskReport';
  conversationId: string;
  taskId: string;
  message: ChatMessage;
};

/**
 * 审批决定存证广播（S24 · G130）——桌面 / 渠道任一端点定审批后，决定终态作为一条 kind='proposal'
 * 消息随对话历史落盘并广播。前端据此把内存活卡替换为只读存证卡（已批准/已拒绝 + 谁准的 + 摘要），
 * 不等重启。重启只是让存证卡从历史重建。
 */
export type ChatProposalRecordEvent = {
  type: 'chat.proposalRecord';
  conversationId: string;
  message: ChatMessage; // kind='proposal'，含 proposalRecord payload
};

/** 已授权清单结果（S24 · G30）：list 拉取与 revoke 撤销后都回最新全量清单（撤销省一次 round-trip）。 */
export type GrantListResultEvent = {
  type: 'grants.list.result';
  grants: Grant[];
  /** grants.add 写盘失败时置真（语义对齐 settle 的 grantPersistFailed）——前端据此提示「未能保存」。 */
  grantPersistFailed?: boolean;
};

/** 收紧覆盖清单结果（2026-07-31）：list 拉取与 setAsk 写入后都回最新全量（同 grants 口径）。 */
export type BehaviorPolicyListResultEvent = {
  type: 'behaviorPolicy.list.result';
  askRows: string[];
  /** setAsk 写盘失败 / 非法行 id 时置真——前端据此提示「未能保存」。 */
  persistFailed?: boolean;
};

/** Twin 通过 record_memory 工具新写一条记忆时主进程推送 */
export type ChatMemoryRecordEvent = {
  type: 'chat.memoryRecord';
  conversationId: string;
  message: ChatMessage; // kind='memory-record' 含 memoryRecord payload
};

/**
 * /loop 收敛活动卡更新。一条 kind='loop-checklist' 消息（含 loopCard payload）随 loop 推进反复推送，
 * 同 id 就地覆盖（复用 subagent chip 的 upsert 机制）——编译→逐轮→收敛全程一张卡。
 */
export type ChatLoopCardEvent = {
  type: 'chat.loopCard';
  conversationId: string;
  message: ChatMessage; // kind='loop-checklist'
};

/**
 * Loop 拆解反问收场（stopReason='clarify'）：拆不出可核验判据时，Oru 的反问作为一条普通
 * assistant 消息落盘并经本事件推达（前端 insertSpecialMessage 落桶、同 id 去重），伴随卡
 * 另行经 chat.loopCard 落安静终态。
 */
export type ChatLoopClarifyEvent = {
  type: 'chat.loopClarify';
  conversationId: string;
  message: ChatMessage; // role='assistant' 纯文本
};

/** 当天首次要改某个非 git 项目时主进程推送一条提示条 */
export type ChatGitHintEvent = {
  type: 'chat.gitHint';
  conversationId: string;
  message: ChatMessage; // kind='git-hint'
};

/** 定时任务到点触发时主进程推送（前端在打开着的会话流里实时插入触发卡，不必等下次拉历史） */
export type ChatScheduledTriggerEvent = {
  type: 'chat.scheduledTrigger';
  conversationId: string;
  message: ChatMessage; // kind='scheduled-trigger' 含 scheduledTrigger payload
};

/**
 * 定时任务后台执行体开跑（S18）——承载对话内当场出现「执行中」指示（临时态，不落历史）。
 * 前端在打开着 conversationId 的会话流里插入执行中卡；应用重启执行体不存活、指示自然消失。
 */
export type ScheduledRunStartedEvent = {
  type: 'scheduledRun.started';
  conversationId: string;
  taskId: string;
  title: string;
};

/**
 * 定时任务后台执行体结束（S18）——携带已落盘的结果卡（+可选产出消息），正开着对话的前端实时收到。
 * card 恒有（kind='scheduled-run'）；output 仅成功且产出非空时有（kind='scheduled-run-output'）。
 */
export type ScheduledRunFinishedEvent = {
  type: 'scheduledRun.finished';
  conversationId: string;
  taskId: string;
  card: ChatMessage;
  output?: ChatMessage;
};

/**
 * 平台（飞书/Discord）入站 user 消息上屏——桌面 user 消息靠前端乐观回显，平台 user 消息
 * 由本事件携全量 ChatMessage 推达（渲染端 insertSpecialMessage 落桶、同 id 去重）。让桌面打开着
 * 的同一对话实时看到「对方在平台发了什么」，不再只见 assistant 回复。
 */
export type ChatInboundUserMessageEvent = {
  type: 'chat.inboundUserMessage';
  conversationId: string;
  message: ChatMessage; // role='user'
};

/** 撤销后主进程推送（前端把卡片改成"已撤销"状态） */
export type ChatMemoryUndoneEvent = {
  type: 'chat.memoryUndone';
  conversationId: string;
  messageId: string;
};

/** v0.2：上下文压缩发生时主进程推送（前端在对话流插入通知卡） */
export type ChatContextCompressedEvent = {
  type: 'chat.contextCompressed';
  conversationId: string;
  message: ChatMessage; // kind='context-compressed' 含 contextCompressed payload
};

// memory
export type MemoryEpisodesResultEvent = {
  type: 'memory.episodes.result';
  episodes: Array<{
    relPath: string;
    title: string;
    scope: string;
    tags: string[];
    /** 文件 mtime 用于排序 */
    mtime: number;
    status: EpisodeStatus;
    /** v2: episode 类别（五类之一，老文件可能 fallback 'agent'） */
    type: string;
    /** v2: 一句话描述；老文件可能空串 */
    description: string;
    /** v2: YYYY-MM-DD */
    date: string;
    /** 'user-direct' = 用户明确要求记住（手账「嘱记」标） */
    source?: string;
    /** 来源对话 id（capture 落 sources:[convId]）；笔记详情「查看原文 ›」跳来源对话（P2/E4 一期） */
    sources?: string[];
    /** dream 纠错产物的校对日期（手账「dream」标） */
    correctedAt?: string;
    /** status=retired 时的淘汰判据（手账「已整理掉」展开行） */
    retiredReason?: string;
  }>;
};
export type MemoryChangelogResultEvent = {
  type: 'memory.changelog.result';
  /** changelog.md 全文（不存在时空串）；按 `## YYYY-MM-DD` 分节，节内先夜记段落后明细行 */
  content: string;
};
export type MemoryEpisodeContentResultEvent = {
  type: 'memory.episode.content.result';
  relPath: string;
  /** 完整 markdown（含 frontmatter） */
  content: string;
  /** frontmatter 解析出来的关键字段 */
  status: EpisodeStatus;
  title: string;
  tags: string[];
};
/**
 * 手动 dream 跑完后的结果。summary 形状定义在 shared/types.ts 的 DreamRunOutcome——
 * dream.ts / scheduler / 本协议 / UI 全部 import 同一份，加 variant 时只改一处。
 */
export type MemoryDreamRunNowResultEvent = {
  type: 'memory.dream.runNow.result';
  summary: DreamRunOutcome;
};

// ─── Memory v2 Page result events ──────────────────────────────────
export type MemoryApplyOpsResultEvent = {
  type: 'memory.applyOps.result';
  result: ApplyResult;
};
// 文档读/写统一回这个（写走读后回，前端刷新即用）
export type MemoryDocResultEvent = {
  type: 'memory.doc.result';
  relPath: string;
  doc: ProfileDoc;
  /** frontmatter 的 last-updated（系统自管）；手账「修订 MM·DD」显示（C5）。缺则不显示徽。 */
  lastUpdated?: string;
};
/** 档案落盘后广播（Task 3）：已打开的档案编辑器据此刷新。独立于 fs.changed，避免波及项目文件 store。 */
export type MemoryDocChangedEvent = { type: 'memory.doc.changed'; relPath: string };
/** live 读/写回包（Task 1）：content=body-only，status 反映合并结果（written/merged/discarded）。 */
export type MemoryDocLiveEvent = {
  type: 'memory.doc.live';
  relPath: string;
  content: string;
  status: 'written' | 'merged' | 'discarded';
};
// 档案历史通道结果事件（Task 4）
export type MemoryHistoryListResultEvent = {
  type: 'memory.history.list.result';
  relPath: string;
  snapshots: FileSnapshotRef[];
};
export type MemoryHistoryContentEvent = {
  type: 'memory.history.content';
  relPath: string;
  snapshotId: string;
  content: string;
};
export type MemoryHistoryRestoredEvent = {
  type: 'memory.history.restored';
  relPath: string;
  content: string;
};
export type MemoryAgentSelfResultEvent = {
  type: 'memory.agentSelf.result';
  content: string;
};
export type MemoryProjectProfileResultEvent = {
  type: 'memory.projectProfile.result';
  projectId: string;
  profile: MemoryProjectProfile;
};
export type MemoryProjectListResultEvent = {
  type: 'memory.projectList.result';
  projects: ProjectListEntry[];
};
export type MemoryEpisodePredecessorResultEvent = {
  type: 'memory.episode.predecessor.result';
  predecessor: EpisodeWithBody | null;
};

// task
export type TaskStartedEvent = { type: 'task.started'; task: SubagentTask };
export type TaskProgressEvent = { type: 'task.progress'; progress: TaskProgress };
export type TaskDoneEvent = { type: 'task.done'; taskId: string; summary: string };
export type TaskFailedEvent = { type: 'task.failed'; taskId: string; errorMessage: string };
export type TaskStatusChangedEvent = {
  type: 'task.statusChanged';
  taskId: string;
  status: SubagentTask['status'];
};
export type TaskQuestionEvent = {
  type: 'task.question';
  taskId: string;
  question: TaskQuestion;
};
export type TaskQuestionAnsweredEvent = {
  type: 'task.questionAnswered';
  taskId: string;
  question: TaskQuestion;
};
export type TaskRollbackConflictEvent = {
  type: 'task.rollbackConflict';
  taskId: string;
  conflictPaths: string[];
};

// git
export type GitStatusResultEvent = {
  type: 'git.status.result';
  projectId: string;
  status: GitStatus;
};

export type GitDiffResultEvent = {
  type: 'git.diff.result';
  projectId: string;
  diff: string;
};

export type GitOkEvent = {
  type: 'git.ok';
  projectId: string;
  action: 'commit' | 'push' | 'branch';
  detail?: string;
};

// settings / auth
/** 平台连接状态实时推送（主动推 + getConfig 响应里也带）。 */
export type PlatformStatusEvent = { type: 'platform.status'; status: PlatformStatus };
/** 平台配置快照（设置页渲染依据；凭证只给「是否已配置」布尔）。 */
export type PlatformConfigEvent = {
  type: 'platform.config';
  config: {
    remoteDefaultAgentId: string | null;
    whitelist: WhitelistEntry[];
    feishuEnabled: boolean;
    discordEnabled: boolean;
    feishuConfigured: boolean;
    discordConfigured: boolean;
    /** 飞书用户授权（S5）：是否已有可用 user token（布尔 + 昵称元数据，绝无密文）。 */
    feishuUserAuthorized: boolean;
    feishuUserName?: string;
    statuses: PlatformStatus[];
  };
};
/** 一次性配对码（生成后回给桌面显示，限时）。 */
export type PlatformPairingCodeEvent = { type: 'platform.pairingCode'; code: string; expiresAt: number };
/** 飞书「一键开通权限」深链 + 所需 scope 全集。 */
export type PlatformScopeLinkEvent = { type: 'platform.scopeLink'; link: string; scopes: string[] };
/** 飞书首次自检结果：doctor 逐项 + scope 校验；缺 scope 时给直达申请链接。 */
export type PlatformDoctorResultEvent = {
  type: 'platform.doctorResult';
  doctor: { ok: boolean; checks: Array<{ name: string; status: string; message: string }>; error?: string };
  /** 走 `auth scopes` 查应用已开通：三态——齐全(ok) / 真缺(missing 非空) / 查不了(error，missing 留空)。 */
  scopeCheck: { ok: boolean; granted: string[]; missing: string[]; error?: string };
  /** 缺 scope 时的「点这申请」深链（仅含缺的那些）。 */
  applyLink?: string;
};

/** 飞书用户授权状态迁移（S5 · device flow）——start/cancel/revoke 的回包 + 轮询期间的主动推。 */
export type PlatformFeishuUserAuthEvent = { type: 'platform.feishuUserAuth'; state: FeishuUserAuthState };

export type SettingsStateEvent = {
  type: 'settings.state';
  settings: Settings;
};

/**
 * 定时任务全量状态——任何改动后广播全端（对齐 settings.state）；list 的回包也用它。
 * tasks 是展开的底层 task（逐条消费方用：missed→conv 去重等）；groups 是聚合后的用户可见任务
 * （列表/通知/错过/创建卡走它）。两者同源，由 buildScheduledStatePayload 单一 helper 构造。
 */
export type ScheduledTaskStateEvent = {
  type: 'scheduledTask.state';
  tasks: ScheduledTask[];
  groups: TaskGroup[];
};

/** 后台命令（S19 登记表）状态快照——对话内后台命令行「运行中脉冲 + 时长」的数据源。 */
export type BgCommandView = {
  id: string;
  conversationId: string;
  status: 'running' | 'exited' | 'crashed';
  exitCode: number | null;
  timedOut: boolean;
  startedAt: number;
  finishedAt: number | null;
};
/** 后台命令全量状态——bgCommand.list 的回包；单条登记/终态变化另广播 bgCommand.changed 增量。 */
export type BgCommandStateEvent = {
  type: 'bgCommand.state';
  commands: BgCommandView[];
};
export type BgCommandChangedEvent = {
  type: 'bgCommand.changed';
  command: BgCommandView;
};
/** 后台命令累积输出尾部（详情浮层「查看输出」用；与 read_background_output 同一读取内核）。 */
export type BgCommandOutputEvent = {
  type: 'bgCommand.output.result';
  id: string;
  text: string;
};

/** 用量账本全量日桶（S13 · G110）——usage.get 的回包；渲染层据此按范围本地聚合。 */
export type UsageStateEvent = {
  type: 'usage.state';
  days: UsageLedgerFile['days'];
};

/** 系统信号全量（S14 · G106）——system.signals.list 的回包、以及任一信号增删后的广播都用它。 */
export type SystemSignalsEvent = {
  type: 'system.signals';
  signals: SystemSignal[];
};

/** 频率预览结果——自然语言频率 + 接下来三次触发时刻。 */
export type ScheduledTaskPreviewResultEvent = {
  type: 'scheduledTask.preview.result';
  frequency: string;
  runs: number[];
};

/** scheduledTask.inflight 的回包（S18）——当前后台执行中的任务 id 列表（前端重载后恢复「执行中」指示）。 */
export type ScheduledTaskInflightResultEvent = {
  type: 'scheduledTask.inflight.result';
  taskIds: string[];
};

export type AuthStatusEvent = {
  type: 'auth.status';
  status: AuthStatus;
};

// prompt 工作台
/** prompts.list 的结果——只回 meta，不带 body */
export type PromptsListedEvent = { type: 'prompts.listed'; prompts: PromptMeta[] };
/** prompts.get 的结果——单段全文 */
export type PromptsOneEvent = { type: 'prompts.one'; prompt: PromptEntry };
/** promptbench.run 的结果——一次 completion 的输出文本 */
export type PromptbenchResultEvent = { type: 'promptbench.result'; text: string };

// backend providers / models / assignments
export type ProvidersStateEvent = {
  type: 'providers.state';
  providers: BackendProvider[];
};
export type ModelsStateEvent = {
  type: 'models.state';
  models: RegisteredModel[];
};
export type ModelAssignmentsStateEvent = {
  type: 'modelAssignments.state';
  assignments: ModelAssignment;
};
/** providers.test 的结果；ok=false 时 message 含失败原因 */
export type ProviderTestResultEvent = {
  type: 'provider.test.result';
  providerId: string;
  ok: boolean;
  /** providerType 给前端做错误提示文案分类用 */
  providerType: BackendProviderType;
  message: string;
};

/** webSearch.testEngine 的结果 */
export type WebSearchTestResultEvent = {
  type: 'webSearch.test.result';
  engineType: SearchEngineType;
  ok: boolean;
  message?: string;
};

/** mcp.testConnection 的结果（v0.5）—— 含 handshake + 探活两步结果 */
export type McpTestResultEvent = {
  type: 'mcp.test.result';
  serverId: string;
  status: McpServerStatus;
  /** 探活通过时附带工具数量 */
  toolCount?: number;
  /** 失败 / probe_failed 时的错误简述 */
  message?: string;
};

/** mcp.listTools 的结果 */
export type McpToolsListEvent = {
  type: 'mcp.tools.list';
  serverId: string;
  tools: { name: string; description: string }[];
};

/** mcp.restart 的结果（等同于 mcp.test.result，restart 后立即重测） */
export type McpRestartResultEvent = {
  type: 'mcp.restart.result';
  serverId: string;
  status: McpServerStatus;
  toolCount?: number;
  message?: string;
  /** 熔断冷却截止时间戳（手动重连成功会清零）；UI 据此派生「已暂停自动重连」展示。 */
  circuitOpenUntil?: number;
};

/** mcp.create 的结果 —— ok=true 时 serverId 必有；用 discriminated union 让前端拿 id 不用猜 */
export type McpCreateResultEvent =
  | { type: 'mcp.create.result'; ok: true; serverId: string }
  | { type: 'mcp.create.result'; ok: false; message: string };

/** mcp.update 的结果 —— 改字段后若触发了 restart，附带最新 runtime status */
export type McpUpdateResultEvent = {
  type: 'mcp.update.result';
  serverId: string;
  ok: boolean;
  /** 若改了 enabled / args / env / command 触发了 restart，附带新状态 */
  status?: McpServerStatus;
  toolCount?: number;
  message?: string;
  /**
   * 熔断冷却截止时间戳。即便本次只改 label/描述（未 restart），也带上当前值——
   * 否则前端 upsert 整体替换 runtime entry 时会把熔断展示清成 undefined（误消预警）。
   */
  circuitOpenUntil?: number;
};

/** mcp.delete 的结果 */
export type McpDeleteResultEvent = {
  type: 'mcp.delete.result';
  serverId: string;
  ok: boolean;
  message?: string;
};

/** mcp.runtime.list 的结果 —— 含每个 server 的当前 runtime 状态（status / lastError / lastStderr） */
export type McpRuntimeListResultEvent = {
  type: 'mcp.runtime.list.result';
  states: Array<{
    serverId: string;
    status: McpServerStatus;
    toolCount?: number;
    lastError?: string;
    lastStderr?: string;
    circuitOpenUntil?: number;
  }>;
  /**
   * 用户在**别的工具**（Claude Code 的 ~/.claude.json、项目 .mcp.json）里配了、但 Oru 没有的
   * MCP server 名。Oru 从 2026-07-27 起不再加载它们（此前 claude-code 子进程会自行加载，
   * 绕过 Oru 全部工具收口）——列出来让用户知道为什么某个服务突然用不了了、以及去哪补。
   * 空数组 = 没有这种情况，UI 不显示提示。
   */
  unmanaged?: string[];
};

// taskboard
export type TaskboardListResultEvent = {
  type: 'taskboard.list.result';
  tasks: BoardTaskMeta[];
};
/** taskboard.create 的 reply：携带新建任务的 meta（含 id），让请求方能立即定位到自己刚建的任务，
 *  无需依赖 broadcast 对账。其他客户端通过 taskboard.taskUpsert broadcast 同步。 */
export type TaskboardCreateResultEvent = {
  type: 'taskboard.create.result';
  task: BoardTaskMeta;
};
export type TaskboardTaskUpsertEvent = {
  type: 'taskboard.taskUpsert';
  task: BoardTaskMeta;
};
export type TaskboardTaskDeleteEvent = {
  type: 'taskboard.taskDelete';
  id: string;
};
export type TaskboardTaskRestoreEvent = {
  type: 'taskboard.taskRestore';
  task: BoardTaskMeta;
};
/** taskboard.get 的 reply：返回完整 BoardTask（含 description）。
 *  TaskDetailModal 用——list 返回的是 BoardTaskMeta（去掉了 description）。 */
export type TaskboardGetResultEvent = {
  type: 'taskboard.get.result';
  task: BoardTask | null;
};
/** taskboard.setAttachments 的 reply：返回写完的完整 task（attachments 已 hydrate displayUrl） */
export type TaskboardSetAttachmentsResultEvent = {
  type: 'taskboard.setAttachments.result';
  task: BoardTask;
};

// taskboard 评论事件
/** taskboard.comments 的 reply：完整 conv + 历史（前端拿到后调 conversationStore.registerConversation
 *  让 byId 注册到 kind='taskboard-comment'，是重启后首开任务详情时让 chat 事件正确路由的关键） */
export type TaskboardCommentsResultEvent = {
  type: 'taskboard.comments.result';
  taskId: string;
  conversation: Conversation;
  messages: ChatMessage[];
};
/** taskboard.note.add / comment.send 的 reply（透传 tempId 给前端替换乐观插入项） */
export type TaskboardNoteAddedEvent = {
  type: 'taskboard.note.added';
  taskId: string;
  tempId?: string;
  message: ChatMessage;
};
/** 评论删除后回执——前端据此从列表移除该 message（Oru 回复不受影响） */
export type TaskboardNoteDeletedEvent = {
  type: 'taskboard.note.deleted';
  taskId: string;
  messageId: string;
};
/** 评论 conv 懒创建后立即广播——前端 byId 注册，避免后续 chat.delta 找不到 conv */
export type TaskboardCommentConvCreatedEvent = {
  type: 'taskboard.commentConvCreated';
  task: BoardTaskMeta;
  conversation: Conversation;
};
/** 同任务已有 Oru 调用在跑（同时配 reply error code BOARD_COMMENT_BUSY） */
export type TaskboardCommentBusyEvent = {
  type: 'taskboard.commentBusy';
  taskId: string;
};

// ─── Skill 模块（v1）响应事件 ──────────────────────────────────

export type PluginListResultEvent = {
  type: 'plugin.list.result';
  plugins: PluginRecord[];
};
export type PluginGetResultEvent = {
  type: 'plugin.get.result';
  plugin: PluginRecord | null;
};
/** 通用 ok/message 响应——install / uninstall / update 触发 proposal 时返回 proposalId */
export type PluginActionResultEvent =
  | { type: 'plugin.action.result'; ok: true; proposalId: string }
  | { type: 'plugin.action.result'; ok: false; message: string };
export type PluginCheckUpdatesResultEvent = {
  type: 'plugin.checkUpdates.result';
  updates: PluginUpdateInfo[];
};
export type PluginGetUpdateDiffResultEvent = {
  type: 'plugin.getUpdateDiff.result';
  diff: PluginDiffSummary | null;
};
export type PluginSetEnabledResultEvent = {
  type: 'plugin.setEnabled.result';
  ok: boolean;
  message?: string;
};

export type SkillListResultEvent = {
  type: 'skill.list.result';
  skills: SkillRecord[];
};
export type SkillGetResultEvent = {
  type: 'skill.get.result';
  skill: SkillRecord | null;
  /** SKILL.md 全文 */
  skillMd?: string;
};
export type SkillActionResultEvent =
  | { type: 'skill.action.result'; ok: true; proposalId: string }
  | { type: 'skill.action.result'; ok: false; message: string };
export type SkillDeleteResultEvent = {
  type: 'skill.delete.result';
  ok: boolean;
  message?: string;
};
export type SkillSetEnabledResultEvent = {
  type: 'skill.setEnabled.result';
  ok: boolean;
  message?: string;
};

/** Plugin 注册表内容变化广播（装/卸/升级后端会发，让 UI 全量刷） */
export type PluginsStateEvent = {
  type: 'plugins.state';
  plugins: PluginRecord[];
};
/** Skill 注册表内容变化广播 */
export type SkillsStateEvent = {
  type: 'skills.state';
  skills: SkillRecord[];
};

/** Skill 模块 chip 落 chat 流时的广播——前端 chatStore 据此插入消息 */
export type ChatSkillModuleEvent = {
  type: 'chat.skillModule';
  conversationId: string;
  message: ChatMessage;
};

/**
 * 对话期 Subagent（v2）chip 实时广播。
 * 运行中状态变化（running ↔ awaiting_approval）只广播，不落盘；
 * 完成 / 失败时同样广播一次，但 router 内部会附带 appendMessage 落盘。
 * 前端按 message.id 去重——同一 chip 用同一 messageId，每次更新覆盖。
 */
export type ChatSubagentChipEvent = {
  type: 'chat.subagentChip';
  conversationId: string;
  message: ChatMessage;
};

// ─── Deck 模块（v1）响应事件 ──────────────────────────────────

/** deck.list reply */
export type DeckListResultEvent = {
  type: typeof ARTIFACT_MSG.listResult;
  projectId: string;
  decks: ArtifactRecord[];
  activeArtifactId: string | null;
};

/** deck.listHistory reply */
export type DeckListHistoryResultEvent = {
  type: typeof ARTIFACT_MSG.listHistoryResult;
  artifactId: string;
  versions: HistoryVersion[];
  currentVersion: string;
};

/** deck.historyPreview reply：该版本的联系表网格图（base64，可能多张分批）+ 页数 */
export type DeckHistoryPreviewResultEvent = {
  type: typeof ARTIFACT_MSG.historyPreviewResult;
  artifactId: string;
  versionId: string;
  sheetImages: string[];
  pageCount: number;
};

/** deck.checkoutHistory reply；missingImages 非空时前端弹询问，用户确认后用 force=true 重发 */
export type DeckCheckoutHistoryResultEvent = {
  type: typeof ARTIFACT_MSG.checkoutHistoryResult;
  ok: boolean;
  missingImages?: string[];
};

/** deck.export reply */
export type DeckExportResultEvent = {
  type: typeof ARTIFACT_MSG.exportResult;
  ok: boolean;
  path?: string;
  message?: string;
  /** 用户主动取消（非失败）——前端据此关弹窗、不报错。 */
  cancelled?: boolean;
};

/** 导出逐页进度广播（仅 pdf/pptx）：done=已渲染页数，total=总页数。按 artifactId 关联前端导出 UI。 */
export type DeckExportProgressEvent = {
  type: typeof ARTIFACT_MSG.exportProgress;
  artifactId: string;
  done: number;
  total: number;
};

/** doc.export 的响应（带相同 reqId）。cancelled 区分用户主动取消与真失败；message 是说人话的原因。 */
export type DocExportResultEvent = {
  type: 'doc.export.result';
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  message?: string;
  /** HTML 出口未能内联的本地图片引用（PRD：缺图不阻断导出，但附清单提示，让用户知道导出物有图损坏）。 */
  missing?: string[];
};

/** 主动状态广播：deck 列表 / active 变化 */
export type DeckStateEvent = {
  type: typeof ARTIFACT_MSG.state;
  projectId: string;
  decks: ArtifactRecord[];
  activeArtifactId: string | null;
};

/** index.html 落盘后广播 → renderer 触发 webview.reload() */
export type DeckIndexChangedEvent = {
  type: typeof ARTIFACT_MSG.indexChanged;
  artifactId: string;
};

/** 注释变化广播：add / update / remove / batch 提交后清空成功项 */
export type DeckAnnotationsChangedEvent = {
  type: typeof ARTIFACT_MSG.annotationsChanged;
  artifactId: string;
  annotations: Annotation[];
};

/** 提交组（Submission）视图——前端渲染「修改中/完成」组所需的最小字段（不含 conversationId） */
export type ArtifactSubmissionView = {
  groupId: string;
  annotationIds: string[];
  beforeVersionId: string;
  /** 有=完成，无=修改中 */
  afterVersionId?: string;
  /**
   * 安全阀强制定版时残留的客观体检项条数（任务 9 决策 5 的 Q2 信号）。
   * 仅"AI 撞收尾轮数上限被强制定版"这条窄路径设值——完成态据此标"AI 报告仍有 N 处客观问题"。
   * 正常定版 / 显式 ack 保留 / 干净收工都不设（保留由 AI 自述，见决策 2）。
   */
  residualOnForceFinalize?: number;
  /**
   * 「已中断」派生展示态（项目B 第二期，PRD §六-6）：崩溃后无 live Submission，但有持久中断记录 +
   * 标注仍 submitted 时，后端重建此视图（interrupted=true）。前端据此渲染「已中断」+「继续」/「退回改前」，
   * 不进 Submission 内存模型（守"两态由 afterVersionId 派生"铁律——这是视图层派生标记）。
   */
  interrupted?: boolean;
  /** 仅 interrupted 视图带：崩溃前提交它的对话 id，「继续」据此切回原对话预填 composer。 */
  conversationId?: string;
};

/** 提交组状态转移广播：成组 / 解组 / 收尾时由各 handler 补发 */
export type ArtifactSubmissionChangedEvent = {
  type: typeof ARTIFACT_MSG.submissionChanged;
  artifactId: string;
  /** null = 该 artifact 当前无活跃组 */
  submission: ArtifactSubmissionView | null;
};

// ─── HTML 提交广播（项目B 第三期 Task14）——与 deck 事件同形，artifactId 换 htmlPath ───
/** html 内容落盘后广播 → renderer 触发 webview.reload() */
export type HtmlIndexChangedEvent = { type: typeof HTML_MSG.indexChanged; htmlPath: string };
/** html 标注变化广播：add / update / remove / 提交后状态变 */
export type HtmlAnnotationsChangedEvent = {
  type: typeof HTML_MSG.annotationsChanged;
  htmlPath: string;
  annotations: Annotation[];
};
/** html 提交组状态转移广播；ArtifactSubmissionView 不含 artifactId，deck/html 共用 */
export type HtmlSubmissionChangedEvent = {
  type: typeof HTML_MSG.submissionChanged;
  htmlPath: string;
  /** null = 该 html 当前无活跃组 */
  submission: ArtifactSubmissionView | null;
};

export type AckEvent = { type: 'ack' };

export type ErrorEvent = {
  type: 'error';
  code: ErrorCode;
  message: string;
};

export type ServerEventPayload =
  | ProjectsStateEvent
  | FsListResultEvent
  | FsMdContentEvent
  | FsMdSavedEvent
  | FsTextWriteResultEvent
  | FsTextHashEvent
  | FsStatEvent
  | FsCreateResultEvent
  | FsOpResultEvent
  | FsImageWrittenEvent
  | FileHistoryListResultEvent
  | FileHistoryContentEvent
  | FileHistoryRestoredEvent
  | ConflictOpenedResult
  | DesktopOpenConversationEvent
  | ChatTodoEvent
  | TableOpenedEvent
  | TableRowCountEvent
  | TableImportConflictEvent
  | TableConflictResolvedEvent
  | TableImportFailedEvent
  | TableImportNoticeEvent
  | TableXlsxPreviewEvent
  | TableImportResultEvent
  | TableImportWrittenEvent
  | TableExportedEvent
  | RendererQueryEvent
  | FsChangedEvent
  | AgentsStateEvent
  | AgentsAvatarUploadResultEvent
  | UserProfileStateEvent
  | ConvStateEvent
  | ConvHistoryResultEvent
  | ConvCompressResultEvent
  | ConvSearchResultEvent
  | ConvSubagentSidecarResultEvent
  | AsideCaptureResultEvent
  | AsideCommentResultEvent
  | AsideBeginResultEvent
  | AsideAddReferentResultEvent
  | AsideListResultEvent
  | ChatStartedEvent
  | ChatDeltaEvent
  | ChatToolCallEvent
  | ChatToolResultEvent
  | ChatCommandOutputEvent
  | ChatDoneEvent
  | ChatSteeringAddedEvent
  | ChatSteeringConsumedEvent
  | ChatSteeringWithdrawResultEvent
  | ChatSteeringRecoveredEvent
  | ChatQueueHandbackEvent
  | ChatAbortResultEvent
  | ChatRetryingEvent
  | ChatErrorEvent
  | ChatProposalEvent
  | ChatAskUserChoiceEvent
  | ChatPendingTurnStateResultEvent
  | ChatWakeRecoverEvent
  | ChatPendingTurnStateListResultEvent
  | ProposalStatusChangedEvent
  | ChatTaskReportEvent
  | ChatProposalRecordEvent
  | GrantListResultEvent
  | BehaviorPolicyListResultEvent
  | ChatMemoryRecordEvent
  | ChatLoopCardEvent
  | ChatLoopClarifyEvent
  | ChatGitHintEvent
  | ChatScheduledTriggerEvent
  | ScheduledRunStartedEvent
  | ScheduledRunFinishedEvent
  | ChatInboundUserMessageEvent
  | ChatCircuitBreakEvent
  | ChatMemoryUndoneEvent
  | ChatContextCompressedEvent
  | MemoryEpisodesResultEvent
  | MemoryChangelogResultEvent
  | MemoryEpisodeContentResultEvent
  | MemoryDreamRunNowResultEvent
  | MemoryApplyOpsResultEvent
  | MemoryDocResultEvent
  | MemoryDocChangedEvent
  | MemoryDocLiveEvent
  | MemoryHistoryListResultEvent
  | MemoryHistoryContentEvent
  | MemoryHistoryRestoredEvent
  | MemoryAgentSelfResultEvent
  | MemoryProjectProfileResultEvent
  | MemoryProjectListResultEvent
  | MemoryEpisodePredecessorResultEvent
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskDoneEvent
  | TaskFailedEvent
  | TaskStatusChangedEvent
  | TaskQuestionEvent
  | TaskQuestionAnsweredEvent
  | TaskRollbackConflictEvent
  | GitStatusResultEvent
  | GitDiffResultEvent
  | GitOkEvent
  | SettingsStateEvent
  | ScheduledTaskStateEvent
  | BgCommandStateEvent
  | BgCommandChangedEvent
  | BgCommandOutputEvent
  | UsageStateEvent
  | SystemSignalsEvent
  | ScheduledTaskPreviewResultEvent
  | ScheduledTaskInflightResultEvent
  | AuthStatusEvent
  | PromptsListedEvent
  | PromptsOneEvent
  | PromptbenchResultEvent
  | ProvidersStateEvent
  | ModelsStateEvent
  | ModelAssignmentsStateEvent
  | ProviderTestResultEvent
  | WebSearchTestResultEvent
  | McpTestResultEvent
  | McpToolsListEvent
  | McpRestartResultEvent
  | McpCreateResultEvent
  | McpUpdateResultEvent
  | McpDeleteResultEvent
  | McpRuntimeListResultEvent
  | TaskboardListResultEvent
  | TaskboardCreateResultEvent
  | TaskboardTaskUpsertEvent
  | TaskboardTaskDeleteEvent
  | TaskboardTaskRestoreEvent
  | TaskboardGetResultEvent
  | TaskboardSetAttachmentsResultEvent
  | TaskboardCommentsResultEvent
  | TaskboardNoteAddedEvent
  | TaskboardNoteDeletedEvent
  | TaskboardCommentConvCreatedEvent
  | TaskboardCommentBusyEvent
  // Skill 模块 v1
  | PluginListResultEvent
  | PluginGetResultEvent
  | PluginActionResultEvent
  | PluginCheckUpdatesResultEvent
  | PluginGetUpdateDiffResultEvent
  | PluginSetEnabledResultEvent
  | SkillListResultEvent
  | SkillGetResultEvent
  | SkillActionResultEvent
  | SkillDeleteResultEvent
  | SkillSetEnabledResultEvent
  | PluginsStateEvent
  | SkillsStateEvent
  | ChatSkillModuleEvent
  | ChatSubagentChipEvent
  // Deck 模块 v1
  | DeckListResultEvent
  | ArtifactAdoptResultEvent
  | ArtifactSubmitAnnotationsResult
  | ArtifactEnterCompareResult
  | DeckListHistoryResultEvent
  | DeckHistoryPreviewResultEvent
  | DeckCheckoutHistoryResultEvent
  | DeckExportResultEvent
  | DeckExportProgressEvent
  | DocExportResultEvent
  | DeckStateEvent
  | DeckIndexChangedEvent
  | DeckAnnotationsChangedEvent
  | ArtifactSubmissionChangedEvent
  // HTML 标注提交（项目B 第三期）
  | HtmlActivateResult
  | HtmlSubmitAnnotationsResult
  | HtmlEnterCompareResult
  | HtmlIndexChangedEvent
  | HtmlAnnotationsChangedEvent
  | HtmlSubmissionChangedEvent
  | PlatformStatusEvent
  | PlatformConfigEvent
  | PlatformPairingCodeEvent
  | PlatformScopeLinkEvent
  | PlatformDoctorResultEvent
  | PlatformFeishuUserAuthEvent
  | DesktopPresencePermissionsResultEvent
  | AckEvent
  | ErrorEvent;

export type ServerEvent = ServerEventPayload & { reqId?: string };

// ─── 端口握手 ──────────────────────────────────────────────────────
// preload 通过 contextBridge 把端口塞给 renderer
// 全局变量名固定为 __ORU_WS_PORT__

export const ORU_PORT_GLOBAL = '__ORU_WS_PORT__' as const;
