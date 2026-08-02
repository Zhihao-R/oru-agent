/**
 * 三方平台统一消息 DTO（tech design §2）——飞书 / Discord 的入站事件经 adapter.normalize
 * 翻译成这一套形状，gateway 之后只认它，不碰平台原始体。
 *
 * 形状抄 Hermes（SessionSource + MessageEvent），第一期 DM only：群字段先不建模（克制），
 * 长尾平台字段靠 `raw` 逃生舱兜住。双 ID 的理由见 SessionSource.userIdAlt。
 */

import type { ApprovalMode } from '../types';

export type Platform = 'feishu' | 'discord';

/**
 * 平台斜杠命令（gateway 处理、不进 agent；桌面快捷输入复用同一套解析）。控制类无参；
 * `/mode <挡位>` `/model [编号]` 带参——取参集中在 command.ts 一处解析（跨平台同源），
 * 故命令是结构化值而非裸字符串。
 * setMode.mode 为 null 表示 `/mode` 参数缺失 / 非法，gateway 回用法提示而非静默放过。
 * model.index 为 null 且 invalid 为 false 表示无参（列清单）；invalid: true 表示参数非数字
 * （回用法提示，不静默列清单）；编号超界由 gateway 判（解析层不知道清单长度）。
 */
export type PlatformCommand =
  | { kind: 'stop' }
  | { kind: 'new' }
  | { kind: 'compress' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'model'; index: number | null; invalid: boolean }
  | { kind: 'setMode'; mode: ApprovalMode | null };

export interface SessionSource {
  platform: Platform;
  /** DM 会话 ID（稳定性见 §10 假设 A：删 DM 重开是否变，需实测） */
  chatId: string;
  chatType: 'dm';
  /** 平台 app 内用户 ID（飞书 open_id / Discord user id）——换 bot 可能变 */
  userId: string;
  /**
   * 飞书 union_id：跨 app 稳定 ID。白名单优先存它（换 bot 仍认得你）；
   * 取不到则降级用 userId（§6 配对绑定时实测，降级在设置里标注）。
   */
  userIdAlt?: string;
  /** 逃生舱：平台原始事件体。注意 §7 脱敏——勿带进任何回显 / 日志。 */
  raw: unknown;
}

export interface MessageEvent {
  text: string;
  source: SessionSource;
  /** 平台消息 ID，gateway 去重用（§4.3，防破坏性操作执行两次） */
  messageId: string;
  /**
   * 入站图片的平台内资源标识（飞书 image_key；Discord 接入时放 attachment URL）。
   * 懒拉取：normalize 只解析标识，下载推迟到 runTurn 内经 adapter.fetchImage——
   * 只为通过准入（白名单/去重/命令分流）的消息发生 IO，且无跨层临时文件生死问题。
   */
  imageKeys?: string[];
  /** 解析出的斜杠命令（stop / new / compress / mode…），由 gateway 处理、不进 agent */
  command?: PlatformCommand;
}

/**
 * 出站失败三态（error-retry「送达」拍板：明确失败才重发，结果未知先确认或带幂等键）——
 * transient：平台明确拒绝且瞬时（429 限流 / 连接未建立），重发无双发风险；
 * unknown：结果未知（超时 / 连接中断 / 5xx），请求可能已送达，盲重发即双发；
 * permanent：明确永久（鉴权 / 参数错），重发注定再败。
 */
export type SendFailure = 'transient' | 'unknown' | 'permanent';

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** 失败分类（ok:false 时给出）——重发决策的唯一依据，见 SendFailure。 */
  failure?: SendFailure;
}

/**
 * 「处理中」表情回应的句柄（tech design §B）——markProcessing 贴表情后返回，clearProcessing 据此
 * 移除 Oru 在该消息上贴的全部表情，让对话回到干净状态。平台特有数据：飞书存 reaction_id 精确删、
 * Discord 存 emoji 按机器人身份删。gateway 只透传、不解读（叠加能力不污染通用编排层）。
 */
export interface ProcessingHandle {
  platform: Platform;
  chatId: string;
  messageId: string;
  /** 飞书：已添加的 reaction_id（只删 Oru 自己加的）。 */
  reactionIds?: string[];
  /** Discord：已添加的 emoji。 */
  emoji?: string;
}

/** 平台连接状态（设置页实时显示；主进程 platformManager 产出、经 WS 推渲染进程）。 */
export type PlatformConnState =
  | 'connected'
  | 'connecting'
  | 'credential-error'
  | 'not-configured'
  | 'held-by-other' // 另一实例持有连接（单实例锁）
  | 'disconnected';

export interface PlatformStatus {
  platform: Platform;
  state: PlatformConnState;
  error?: string;
}

/**
 * 飞书用户授权状态机（S5 · device flow）——设置页「飞书用户身份」区块的渲染依据。
 * 主进程 feishuUserAuth.ts 是唯一写源；渲染进程只读（事件推送 + start/cancel/revoke 请求）。
 * 链接/user_code 非密文可上屏；token 永远不出现在本结构（红线 1）。
 */
export type FeishuUserAuthState =
  | { phase: 'idle' }
  | {
      phase: 'pending';
      verificationUri: string;
      /** 带 user_code 预填的完整授权链接（点这直接授权）。 */
      verificationUriComplete: string;
      userCode: string;
      /** 设备码过期时刻（Unix ms）。 */
      expiresAt: number;
    }
  | { phase: 'authorized'; userName?: string; scope: string; grantedAt: number }
  | { phase: 'denied' }
  | { phase: 'expired'; message: string }
  | { phase: 'error'; message: string };

/**
 * 远程审批投影卡（S24 · G30 下半）——平台无关的审批卡数据，适配器各自渲染成原生形态
 * （飞书互动卡片 / Discord 按钮）。同一份审批实体可投影到多个渠道地址；决定回流到同一实体，
 * 先到先得（桌面与渠道谁先点谁生效）。正文经现状 redactSecrets 脱敏后填入。
 */
export interface RemoteApprovalCard {
  proposalId: string;
  title: string;
  /** 做什么＋为什么要确认（脱敏后）。 */
  body: string;
  /** always 仅当提案可持久授权（有 grantable 且非灾难级）时出现。 */
  buttons: Array<'allow' | 'always' | 'reject'>;
}

/**
 * 平台侧审批按钮回调（S24）——飞书 card action / Discord button interaction 归一成这一形状，
 * 经 gateway 入站门卫（只认绑定主人本人的平台身份，与消息入站同一道校验）汇入 settleApprovalDecision。
 */
export interface ApprovalCallbackEvent {
  proposalId: string;
  action: 'allow' | 'always' | 'reject';
  source: SessionSource;
}
