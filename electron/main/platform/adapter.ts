/**
 * PlatformAdapter 契约（tech design §3）——每平台一个实现，职责只有两件：
 * 连平台长连接、把平台事件 normalize 成统一 MessageEvent 回调给 gateway。
 *
 * 三方法抄 Hermes（connect / disconnect / send），比 OpenClaw 的 facet 插件契约更简洁——
 * 第一期硬编码飞书 + Discord 两个 adapter，不做插件机制（PRD 边界）。
 *
 * 副作用纪律（CLAUDE.md）：connect 起的长连接 / 重连 timer / 心跳 timer 必须在 disconnect
 * 里成对清干净（off / clearTimeout / 释放锁），用 AbortSignal 贯穿。
 */
import type {
  ApprovalCallbackEvent,
  MessageEvent,
  Platform,
  ProcessingHandle,
  RemoteApprovalCard,
  SendResult,
} from '@shared/platform/message';

export interface PlatformAdapter {
  readonly platform: Platform;
  /** 出站单条文本上限（飞书 8000 / Discord 2000）——分段回发据此切（§8） */
  readonly maxMessageLength: number;
  /** 出站文件字节上限——超限降级提示「去桌面取」，不静默失败（§8） */
  readonly maxFileBytes: number;
  /**
   * 远程审批能力（S24 · G30 下半）：'button'=能投互动卡片 + 按钮回流（飞书）；'text'=仅纯文本
   * （Discord 本期，回落现状「拒绝+提示」）；'none'=无。声明 'text'/'none' 的适配器不实现下面三个方法。
   */
  readonly approvalCapability: 'button' | 'text' | 'none';

  /** 建长连接并注册入站回调；返回是否连上。回调内的处理失败不应让连接崩。 */
  connect(onMessage: (e: MessageEvent) => Promise<void>): Promise<boolean>;

  /** 断开并清干净所有 timer / listener / 锁（成对清理）。 */
  disconnect(): Promise<void>;

  send(
    chatId: string,
    content: string,
    opts?: {
      /** 回复某条消息（平台 reply 语义） */
      replyTo?: string;
      /** 出站附件本地路径（产物回发） */
      filePaths?: string[];
    },
  ): Promise<SendResult>;

  /**
   * 下载入站图片字节（懒拉取，与 MessageEvent.imageKeys 配对）——key 为平台内资源标识，
   * messageId 为其所在消息。只在 runTurn 内、消息已通过准入后调用。失败抛错（由调用方
   * 回「图片处理失败」回执）。平台无入站图能力则不实现。
   */
  fetchImage?(messageId: string, key: string): Promise<Buffer>;

  /**
   * 取用户展示信息（绑定白名单时抓昵称，展示用，可选）——飞书走通讯录 API。best-effort：
   * 抓不到 / 无权限返回 null（绑定照常，界面回落显示 id）。平台无此能力则不实现。
   */
  fetchUserProfile?(userId: string): Promise<{ name?: string } | null>;

  /**
   * 给收到的消息贴「处理中」表情（§B，可选）——轻量「我在干活」信号，不占一条消息。
   * 平台无此能力则不实现（gateway 据 optional 跳过）。失败返回 null（表情只是锦上添花，不崩 turn）。
   */
  markProcessing?(chatId: string, messageId: string): Promise<ProcessingHandle | null>;
  /** 移除该消息上 Oru 贴的全部「处理中」表情（§B，与 markProcessing 成对）。 */
  clearProcessing?(handle: ProcessingHandle): Promise<void>;

  // ── 远程可点审批卡（S24 · G30 下半；approvalCapability==='button' 才实现）──
  /** 发出审批投影卡，返回平台侧消息 id（用于事后改写成终态）；失败返回 null（副本非承重）。 */
  sendApprovalCard?(chatId: string, card: RemoteApprovalCard): Promise<{ platformMessageId: string } | null>;
  /** 把已发出的投影卡原地改写成终态（飞书更新卡片）。改写失败不影响判定（本地是事实源）。 */
  updateApprovalCardToTerminal?(
    chatId: string,
    platformMessageId: string,
    decision: 'approved' | 'rejected',
  ): Promise<void>;
  /**
   * 注册审批按钮回流回调（platformManager 连接后注入）——适配器把平台 card action 事件 normalize 成
   * ApprovalCallbackEvent 后交给 cb（cb 内经 gateway 入站门卫校验身份再汇入 settleApprovalDecision）。
   */
  setApprovalCallback?(cb: (e: ApprovalCallbackEvent) => Promise<void>): void;
}
