/**
 * 审批行为分类注册表（2026-07-30 拍板，PRD 决策 1-8）——「权限与行为」策略表的单一事实源。
 *
 * 分类分两区（PRD 第四节）：行为行回答「它要做什么」、决定默认值；修饰行回答「多严重 /
 * 判不判得出 / 通道有没有保障」，命中时覆盖行为行的结论。两个消费方共用这一份：审批卡
 * 标题映射（behaviorForProposal）与设置页策略表——行为行的增删改只允许发生在这一个文件，
 * 两处各写一份映射必然漂移。
 *
 * 文案不落库：每行只挂 i18n key（proposal ns 的 behaviors.*），渲染层与主进程各用自己的
 * t 取词，语言域与卡上其余字一致。
 */
import type { ActionProposal, GrantScope } from '../types';

export type BehaviorRow = {
  /** 行 id；可整类授权的行与 scope 同名（category id 直接取用，单例 kind 见 SCOPE_ROW）。 */
  id: string;
  zone: 'behavior' | 'modifier';
  /** 标题 / 说明的 i18n key（proposal ns） */
  titleKey: string;
  descKey: string;
  /** hover tip（技术解释）的 i18n key；设置页经原生 title 属性展示 */
  tipKey?: string;
  /**
   * 可整类授权的行挂的单例 scope（「始终允许」的最小单位）。无 scope 的行：
   * 默认不问（只显示状态）、按收件人授权（perRecipient）、或锁定（灾难级）。
   */
  scope?: GrantScope;
  /** 按收件人授权（发送内容到外部）：delivery 是开放集合无静态 scope，行随首次授权动态长出 */
  perRecipient?: true;
  /**
   * 可「收紧」的行（2026-07-31 PM 拍板：策略表双向开关）：默认不问，用户可拨成「每次问」——
   * 覆盖记在 behaviorPolicy store（askRows），运行时消费点见 emitProposal（提案类）与
   * writeFile（aiOwned 的 D3 免审）。无此标记的行：read/dispatchSubagent 与只读挡职责重叠
   * 不做开关；noStructureGuarantee 是纯说明（升档规则本体在 bashCommand 分类里）。
   */
  askable?: true;
  /** 锁定行（灾难级）：必问、永不可授权，设置页显示「始终询问」且无拨杆 */
  locked?: boolean;
  /** 工作挡默认是否弹卡（默认不问的行显示状态或由 askable 拨杆控制） */
  defaultAsks: boolean;
};

const B = (id: string) => `behaviors.${id}` as const;
const T = (id: string) => `behaviors.${id}.tip` as const;

/** 行为行（PRD 第四节上表，顺序即设置页呈现顺序）。 */
const BEHAVIOR_ROWS: BehaviorRow[] = [
  { id: 'read', zone: 'behavior', titleKey: `${B('read')}.title`, descKey: `${B('read')}.desc`, defaultAsks: false },
  {
    id: 'webAccess', zone: 'behavior', titleKey: `${B('webAccess')}.title`, descKey: `${B('webAccess')}.desc`,
    scope: { kind: 'category', id: 'webAccess' }, defaultAsks: true,
  },
  {
    id: 'create', zone: 'behavior', titleKey: `${B('create')}.title`, descKey: `${B('create')}.desc`,
    askable: true, defaultAsks: false,
  },
  {
    id: 'modify', zone: 'behavior', titleKey: `${B('modify')}.title`, descKey: `${B('modify')}.desc`,
    askable: true, defaultAsks: false,
  },
  {
    id: 'overwrite', zone: 'behavior', titleKey: `${B('overwrite')}.title`, descKey: `${B('overwrite')}.desc`,
    scope: { kind: 'overwrite' }, defaultAsks: true,
  },
  {
    id: 'fileDelete', zone: 'behavior', titleKey: `${B('fileDelete')}.title`, descKey: `${B('fileDelete')}.desc`,
    scope: { kind: 'category', id: 'fileDelete' }, defaultAsks: true,
  },
  {
    id: 'sendExternal', zone: 'behavior', titleKey: `${B('sendExternal')}.title`, descKey: `${B('sendExternal')}.desc`,
    // 总开关（2026-07-31 PM 拍板）：拨开 = 所有外发免卡（默认关）；按收件人授权维持为默认形态，
    // 清单随首次授权在下方动态长出。两特征共存：scope 管总开关、perRecipient 管收件人行。
    tipKey: T('sendExternal'),
    scope: { kind: 'category', id: 'sendExternal' }, perRecipient: true, defaultAsks: true,
  },
  {
    id: 'mcp', zone: 'behavior', titleKey: `${B('mcp')}.title`, descKey: `${B('mcp')}.desc`,
    scope: { kind: 'category', id: 'mcp' }, defaultAsks: true,
  },
  {
    id: 'plugin', zone: 'behavior', titleKey: `${B('plugin')}.title`, descKey: `${B('plugin')}.desc`,
    scope: { kind: 'category', id: 'plugin' }, defaultAsks: true,
  },
  {
    id: 'skillInstall', zone: 'behavior', titleKey: `${B('skillInstall')}.title`, descKey: `${B('skillInstall')}.desc`,
    scope: { kind: 'category', id: 'skillInstall' }, defaultAsks: true,
  },
  {
    id: 'scheduledTask', zone: 'behavior', titleKey: `${B('scheduledTask')}.title`, descKey: `${B('scheduledTask')}.desc`,
    scope: { kind: 'category', id: 'scheduledTask' }, defaultAsks: true,
  },
  {
    id: 'destructiveCommand', zone: 'behavior', titleKey: `${B('destructiveCommand')}.title`, descKey: `${B('destructiveCommand')}.desc`,
    scope: { kind: 'destructive' }, defaultAsks: true,
  },
  { id: 'dispatchSubagent', zone: 'behavior', titleKey: `${B('dispatchSubagent')}.title`, descKey: `${B('dispatchSubagent')}.desc`, defaultAsks: false },
];

/** 修饰行（PRD 第四节下表）：命中时覆盖行为行的结论（升档优先于降档）。 */
const MODIFIER_ROWS: BehaviorRow[] = [
  {
    id: 'catastrophic', zone: 'modifier', titleKey: `${B('catastrophic')}.title`, descKey: `${B('catastrophic')}.desc`,
    tipKey: T('catastrophic'),
    locked: true, defaultAsks: true,
  },
  {
    id: 'unknown', zone: 'modifier', titleKey: `${B('unknown')}.title`, descKey: `${B('unknown')}.desc`,
    tipKey: T('unknown'),
    scope: { kind: 'unknown' }, defaultAsks: true,
  },
  // 说明性修饰（无独立授权单位）：经 bash 执行的同一行为按破坏性命令问（通道给不了回收站/
  // 撞名不覆盖/锁保障）——升档规则本体在 bashCommand 的破坏性分类里，无独立开关点，保持纯说明。
  {
    id: 'noStructureGuarantee', zone: 'modifier', titleKey: `${B('noStructureGuarantee')}.title`, descKey: `${B('noStructureGuarantee')}.desc`,
    tipKey: T('noStructureGuarantee'), defaultAsks: true,
  },
  // AI 自产且用户未动的覆盖不问（D3，现状）；askable——用户可拨成「每次问」关掉这道免审。
  {
    id: 'aiOwned', zone: 'modifier', titleKey: `${B('aiOwned')}.title`, descKey: `${B('aiOwned')}.desc`,
    tipKey: T('aiOwned'), askable: true, defaultAsks: false,
  },
];

/** 策略表全量行：行为行 + 修饰行，注册表内顺序即呈现顺序。 */
export const APPROVAL_BEHAVIOR_ROWS: readonly BehaviorRow[] = [...BEHAVIOR_ROWS, ...MODIFIER_ROWS];

const ROW_BY_ID = new Map(APPROVAL_BEHAVIOR_ROWS.map((r) => [r.id, r]));

/** 单例 / category scope → 注册表行（人话标签的单源）；delivery 按收件人动态，无静态行。 */
export function rowForScope(scope: GrantScope): BehaviorRow | undefined {
  switch (scope.kind) {
    case 'destructive':
      return ROW_BY_ID.get('destructiveCommand');
    case 'unknown':
      return ROW_BY_ID.get('unknown');
    case 'overwrite':
      return ROW_BY_ID.get('overwrite');
    case 'category':
      return ROW_BY_ID.get(scope.id);
    case 'delivery':
      return undefined;
  }
}

/**
 * delivery scope 的收件人展示名：优先取提案上投递目标的人话 label（如「飞书:研发群」），
 * scope 里只有 recipient id 兜不出人名时回落 `渠道:收件人`。卡上按钮（AlwaysAllowButton）
 * 与授权烘焙（grants/label.ts）共用，两处各写一份必漂移。
 */
export function deliveryTargetLabel(
  scope: GrantScope & { kind: 'delivery' },
  proposal: ActionProposal,
): string {
  const target = proposal.delivery?.find(
    (d) => d.channel === scope.channel && (d.recipient ?? '') === scope.recipient,
  );
  return target?.label ?? `${scope.channel}:${scope.recipient}`;
}

/**
 * 审批卡标题映射（决策 1）：提案 → 行为行。标题写行为类型、描述写具体对象。
 * 返回 undefined 的提案不在行为分类面（code 派工 / deck 创建 / skill 建改），卡片保留自有标题。
 *
 * bash 归类（PRD）：未知命令（opaque）优先于破坏性——修饰行升档覆盖行为行；灾难级不改行为
 * 归属（仍是破坏性命令，卡面另有锁定横幅）；只有投递 / 覆盖而无破坏性的按各自行为行。
 */
export function behaviorForProposal(p: ActionProposal): BehaviorRow | undefined {
  switch (p.kind) {
    case 'bash': {
      // segments 容忍缺省：历史持久化消息 / 外部构造的提案可能没带（分类只影响标题，不该因此炸卡）
      if ((p.segments ?? []).some((s) => s.opaque)) return ROW_BY_ID.get('unknown');
      if (p.isDestructive) return ROW_BY_ID.get('destructiveCommand');
      if (p.delivery?.length) return ROW_BY_ID.get('sendExternal');
      if (p.overwriteTargets?.length) return ROW_BY_ID.get('overwrite');
      return undefined;
    }
    case 'file.write':
      if (p.mode === 'delete') return ROW_BY_ID.get('fileDelete');
      if (p.mode === 'overwrite') return ROW_BY_ID.get('overwrite');
      if (p.mode === 'create') return ROW_BY_ID.get('create');
      return ROW_BY_ID.get('modify');
    case 'mcp.install':
    case 'mcp.update':
    case 'mcp.delete':
      return ROW_BY_ID.get('mcp');
    case 'plugin.install':
    case 'plugin.update':
    case 'plugin.uninstall':
      return ROW_BY_ID.get('plugin');
    case 'skill.install':
      return ROW_BY_ID.get('skillInstall');
    case 'scheduled-task':
      return ROW_BY_ID.get('scheduledTask');
    case 'web.fetch':
    case 'browser.navigate':
      return ROW_BY_ID.get('webAccess');
    default:
      return undefined;
  }
}
