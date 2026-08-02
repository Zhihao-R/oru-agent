/**
 * 定时任务的两个 AI 工具（读/写分离）。
 *
 * 第一性：读无副作用→直答不审批；写有破坏性→走审批。
 * - list_scheduled_tasks：mutatesEnvironment=false、persistPolicy='never'，照 listDir 直接执行。
 * - manage_scheduled_task：mutatesEnvironment=true——这是 approvalGate 在「只读挡 execute 之前」的
 *   硬拒声明位（与 proposeOrExecute 独立）。注意不能照抄 bash 的 false（bash 的只读放行靠
 *   proposal.isReadOnly），本工具恒写，必须显式 true。写经 proposeOrExecute（work 挡弹确认卡）。
 *
 * 护栏在工具层强制（不只 UI）：create/update 走 validateSpec（与 UI 同一函数，单一事实来源），
 * 最小触发间隔 1 分钟、结构非法即 throw。
 */
import type { AgentTool, ToolContext, ToolResult } from '@shared/agent/backend';
import type { ScheduledRunLocation, ScheduledTask, ScheduleSpec, TaskGroupInput } from '@shared/types';
import { newScheduledTaskId, newProposalId } from '@shared/ids';
import { listScheduledTasks } from '../../scheduledTasks/store';
import { groupTasks } from '../../scheduledTasks/groupTasks';
import {
  assertRuleCreatable,
  createTaskGroup,
  deleteTaskGroup,
  setTaskGroupEnabled,
  updateTaskGroup,
} from '../../scheduledTasks/groupOps';
import { getConversation } from '../../conversations/store';
import { computeNextRun, currentTimeZone, describeSpec, describeFrequency, fmtLocal } from '../../scheduledTasks/schedule';
import { resolveSchedule, type RawScheduleArgs } from '@shared/scheduledTasks/resolveSchedule';
import { deriveTaskTitle } from '@shared/scheduledTasks/deriveTitle';
import { emitScheduledTaskState } from '../../scheduledTasks/notify';
import { proposeOrExecute } from './emitProposal';
import type { StructuredMarkers } from '@shared/agent/structuredMarkers';
import { tFor } from '../../i18n/t';

// 本文件的工具结果 / 提案描述 / 通知文案周边整段仍是中文（属类③，留 D5 整篇英文化）；这里给
// describeSpec/Frequency 传固定中文取词器，频率片段与周边同语种、零行为变化。真·UI 渲染（任务行
// ScheduledTaskPage、提案卡 ScheduledTaskProposalCard、ComposeModal 预览）各自走界面语言的 t。
const zhT = tFor('zh');

const LIST_DESC = `列出当前所有定时任务（到点自动替用户跑一段 prompt 的清单）。只读、零确认。
回答「我有哪些定时任务」「下一条几点触发」时先用它。返回每条的标题、频率、是否启用、下次触发时间。`;

const MANAGE_DESC = `创建 / 修改 / 删除 / 暂停 / 启用一条定时任务。**所有写操作都会先弹确认卡给用户**，用户确认后才生效。

何时建：用户说「以后每天/每周……帮我做某事」「N 分钟后提醒我……」这类「到某个时间替我做某件事」。
挑节奏：某个具体时刻或「N 分钟后」→ once；日常几点 → daily；每周几 → weekly；每隔几分钟/几小时循环 → interval。
**一条任务可配多条触发时间**：给 schedules 传数组（如「每天 8 点 + 每周一 14 点」＝两条），单条也可只传 schedule。
**周期任务（daily/weekly）尽量带停止条件**（stopAfterRuns：重复 N 次后停）；**interval（间隔重复）必须带 stopAfterRuns**（无「一直」）。
触发间隔不得低于 1 分钟。`;

// 你只需照「今天/明天/星期几」写出日期与钟点——当前日期由系统注入，**切勿自行计算时间戳**
// （把口语时间换算成机器时间戳是最易错的一类计算）。换算由代码统一做，与手动设置页同一套。
const SPEC_SCHEMA = {
  type: 'object',
  description:
    '触发节奏。按 kind 给对应字段；时间一律写人话（日期 2026-06-29、钟点 18:00、星期名）。' +
    '当前日期由系统每轮注入，你只需照「今天/明天/星期几」写出日期与钟点，**切勿自行计算时间戳**（换算由代码统一做）。',
  properties: {
    kind: { type: 'string', enum: ['once', 'daily', 'weekly', 'interval'] },
    date: { type: 'string', description: 'once 某时刻：日期 "YYYY-MM-DD"（配合 time），如 "2026-06-29"' },
    time: { type: 'string', description: 'once 某时刻 / daily / weekly：钟点 "HH:MM"，如 "18:00"' },
    after: {
      type: 'object',
      description: 'once 相对：从现在起多久之后（与 date+time 二选一）',
      properties: {
        value: { type: 'number', description: '数量（≥1）' },
        unit: { type: 'string', enum: ['minute', 'hour', 'day'] },
      },
      required: ['value', 'unit'],
    },
    weekdays: {
      type: 'array',
      items: { type: 'string', enum: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
      description: 'weekly：星期名数组，如 ["mon","wed","fri"]',
    },
    every: { type: 'number', description: 'interval：每隔几个单位（≥1）' },
    unit: { type: 'string', enum: ['minute', 'hour'], description: 'interval：单位（分钟/小时），从创建时刻起算' },
    stopAfterRuns: { type: 'number', description: '本条重复 N 次后自动停（interval 必填；daily/weekly 可选）' },
  },
  required: ['kind'],
};

/** 一条触发规则的原始入参（人话时间 + 可选停止次数）。 */
type RawRuleArgs = RawScheduleArgs & { stopAfterRuns?: number };

interface ManageArgs {
  action?: 'create' | 'update' | 'delete' | 'pause' | 'resume';
  taskId?: string;
  title?: string;
  prompt?: string;
  /** 多条触发时间；与单条 schedule 二选一（都给以 schedules 为准）。 */
  schedules?: RawRuleArgs[];
  schedule?: RawScheduleArgs;
  runLocation?: ScheduledRunLocation;
  /** 单条 schedule 的停止次数（多条时各写进 schedules[i].stopAfterRuns）。 */
  stopAfterRuns?: number;
}

function fmtNext(t: { enabled: boolean; nextRunAt: number | null }): string {
  if (!t.enabled) return '已暂停';
  if (t.nextRunAt == null) return '已结束';
  return new Date(t.nextRunAt).toLocaleString('zh-CN');
}

export function makeListScheduledTasksTool(): AgentTool {
  return {
    name: 'list_scheduled_tasks',
    mutatesEnvironment: false,
    persistPolicy: 'never',
    description: LIST_DESC,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute(): Promise<ToolResult> {
      // 聚合唯一入口：多规则组列成一行、频率逐条合并；id 用 groupId（管理工具的 taskId 语义＝组）
      const groups = groupTasks(await listScheduledTasks());
      if (groups.length === 0) return { text: '当前没有定时任务。' };
      const freqOf = (g: (typeof groups)[number]) =>
        g.rules.map((r) => describeFrequency(r.spec, r.stopAfterRuns, zhT)).join('、');
      const lines = groups.map(
        (g) =>
          `- ${g.title}（${freqOf(g)}）· ${g.enabled ? '启用' : '暂停'} · 下次：${fmtNext(g)}` +
          (g.createdBy === 'agent' ? ' · Oru 建' : '') +
          ` [id:${g.groupId}]`,
      );
      return {
        text: `当前定时任务（${groups.length}）：\n${lines.join('\n')}`,
        structured: {
          tasks: groups.map((g) => ({
            id: g.groupId,
            title: g.title,
            frequency: freqOf(g),
            enabled: g.enabled,
            nextRunAt: g.nextRunAt,
            rules: g.rules.map((r) => ({
              frequency: describeFrequency(r.spec, r.stopAfterRuns, zhT),
              nextRunAt: r.nextRunAt,
            })),
          })),
        },
      };
    },
  };
}

export function makeManageScheduledTaskTool(): AgentTool {
  return {
    name: 'manage_scheduled_task',
    // 恒写——必须 true 让只读挡硬拒生效（不能照抄 bash 的 false）
    mutatesEnvironment: true,
    persistPolicy: 'never',
    description: MANAGE_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'pause', 'resume'] },
        taskId: { type: 'string', description: 'update/delete/pause/resume 的目标任务 id' },
        title: { type: 'string' },
        prompt: { type: 'string', description: '触发时以用户口吻发起的指令' },
        schedules: {
          type: 'array',
          items: SPEC_SCHEMA,
          description: '多条触发时间（一条任务可挂多条）；单条也可用下面的 schedule',
        },
        schedule: SPEC_SCHEMA,
        runLocation: {
          type: 'object',
          // 一般不填：不填则跟随当前对话——在飞书/Discord 对话里创建会自动把结果推回该渠道，桌面对话则开新对话。
          // 仅当要显式覆盖（如"结果单独开新对话"或"跑在某已有对话里"）才填。渠道落点不在此手填（chatId 由系统取）。
          description: '运行位置；一般不填（默认跟随当前对话：渠道对话推回该渠道、桌面对话开新对话）',
          properties: {
            kind: { type: 'string', enum: ['newConversation', 'conversation'] },
            id: { type: 'string' },
          },
          required: ['kind'],
        },
        stopAfterRuns: { type: 'number', description: '重复 N 次后自动停（周期任务防自循环）' },
      },
      required: ['action'],
    },
    async execute(input, ctx): Promise<ToolResult> {
      const args = (input ?? {}) as ManageArgs;
      try {
        switch (args.action) {
          case 'create':
            return await handleCreate(args, ctx);
          case 'update':
            return await handleUpdate(args, ctx);
          case 'delete':
          case 'pause':
          case 'resume':
            return await handleSimple(args, ctx, args.action);
          default:
            return { isError: true, text: 'manage_scheduled_task: 未知 action' };
        }
      } catch (e) {
        return { isError: true, text: `manage_scheduled_task: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

async function pushState(): Promise<void> {
  // 广播失败不应反过来把「已落盘成功」的写操作判成 failed（finalizer 据 execute 结果上报）
  try {
    const { buildScheduledStatePayload } = await import('../../scheduledTasks/rpc');
    await emitScheduledTaskState(() => buildScheduledStatePayload());
  } catch (e) {
    console.warn('[scheduledTasks] 状态广播失败（不影响已落盘的写）', e);
  }
}

/** 默认落点：渠道对话（有 source）→ 推回该渠道；桌面对话 → 开新对话。取数失败保守回落新对话。 */
async function defaultRunLocation(ctx: ToolContext): Promise<ScheduledRunLocation> {
  const src = await getConversation(ctx.agentId, ctx.conversationId)
    .then((c) => c.source)
    .catch(() => null);
  return src ? { kind: 'channel', platform: src.platform, chatId: src.chatId } : { kind: 'newConversation' };
}

type ParsedRule = { spec: ScheduleSpec; stopAfterRuns?: number };
type DisplayRule = ParsedRule & { nextRunAt: number | null };

/** 组规则集指纹（身份+spec+次数）：update 提案的审批窗漂移检测用（title/prompt 由批准内容覆盖，不入纹）。 */
function rulesFingerprint(rules: ScheduledTask[]): string {
  return JSON.stringify(rules.map((t) => [t.id, t.spec, t.stopAfterRuns ?? null]));
}

/** 按 groupId 取组内全部规则（createdAt 升序、id 兜底——与 groupTasks.buildGroup 同口径）。
 * AI 工具的 taskId 语义＝组 id：list 按组返回 groupId，管理写据它定位组。绝不用 getScheduledTask(id)——
 * 组首条规则（其 id===groupId）被删后按 id 查不到、组却仍在，会谎报「找不到」（M9）。与 RPC/UI 同口径。 */
async function resolveGroup(groupId: string): Promise<ScheduledTask[]> {
  return (await listScheduledTasks())
    .filter((t) => t.groupId === groupId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** 解析规则入参：schedules 优先、退回单条 schedule（带顶层 stopAfterRuns）；空表示未提供。 */
function parseRules(args: ManageArgs, now: number): ParsedRule[] {
  const raw: RawRuleArgs[] = args.schedules?.length
    ? args.schedules
    : args.schedule
      ? [{ ...args.schedule, stopAfterRuns: args.stopAfterRuns }]
      : [];
  return raw.map((r) => ({ spec: resolveSchedule(r, now), stopAfterRuns: r.stopAfterRuns }));
}

/** 提案里逐条频率（once 附解析后的绝对时刻，供用户核对「未来的错日期」·tech §F）。 */
function describeRulesText(rules: DisplayRule[]): string {
  return rules
    .map(
      (r) =>
        describeSpec(r.spec, zhT) +
        (r.spec.kind === 'once' && r.nextRunAt != null ? `（${fmtLocal(r.nextRunAt)}）` : ''),
    )
    .join('、');
}

/** 代表 draft（首条规则）：提案卡据它展示 prompt/落点/标题；逐条频率走 proposal.rules。 */
function displayDraft(
  ctx: ToolContext,
  base: { title: string; prompt: string; runLocation: ScheduledRunLocation },
  first: DisplayRule,
): ScheduledTask {
  const id = newScheduledTaskId();
  const now = Date.now();
  return {
    id,
    groupId: id,
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    title: base.title,
    prompt: base.prompt,
    runLocation: base.runLocation,
    spec: first.spec,
    enabled: true,
    createdBy: 'agent',
    stopAfterRuns: first.stopAfterRuns,
    nextRunAt: first.nextRunAt,
    runCount: 0,
    tz: currentTimeZone(),
    createdAt: now,
    updatedAt: now,
  };
}

async function handleCreate(args: ManageArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!args.prompt?.trim()) return { isError: true, text: 'create 需要 prompt（执行内容）' };
  const now = Date.now();
  const rules = parseRules(args, now);
  if (rules.length === 0) return { isError: true, text: 'create 需要 schedule 或 schedules' };
  // 递交提案前逐条校验（结构 + 未来时刻闸 + interval 强制次数，与建组时同一护栏，单一事实源）
  for (const r of rules) assertRuleCreatable(r.spec, r.stopAfterRuns, now);

  const base = {
    title: deriveTaskTitle(args.title, args.prompt),
    prompt: args.prompt.trim(),
    // 不指定落点时跟随当前对话：飞书/Discord 对话 → 推回该渠道；桌面对话 → 开新对话。
    runLocation: args.runLocation ?? (await defaultRunLocation(ctx)),
  };
  const input: TaskGroupInput = { ...base, rules };
  const displayRules: DisplayRule[] = rules.map((r) => ({ ...r, nextRunAt: computeNextRun(r.spec, now, now) }));
  const draft = displayDraft(ctx, base, displayRules[0]);
  return proposeOrExecute(
    ctx,
    {
      id: newProposalId(),
      kind: 'scheduled-task',
      ownerId: ctx.ownerId,
      conversationId: ctx.conversationId,
      status: 'pending',
      createdAt: now,
      forceApproval: true,
      grantable: [{ kind: 'category', id: 'scheduledTask' }],
      action: 'create',
      taskId: draft.id,
      draft,
      rules: displayRules,
      title: '创建定时任务',
      description: `${describeRulesText(displayRules)}，在${locationText(base.runLocation)}：${base.prompt}`,
    },
    {
      approvalText: `已递交创建定时任务提案：${describeRulesText(displayRules)} —— ${base.title}`,
      execute: async () => {
        const groupId = await createTaskGroup(input, {
          ownerId: ctx.ownerId,
          agentId: ctx.agentId,
          createdBy: 'agent',
        });
        await pushState();
        return {
          text: `已创建定时任务「${base.title}」（${describeRulesText(displayRules)}）。`,
          // 渲染层确认卡据此标记渲染（structured 存在 = 创建确实落盘）；taskId=groupId，卡片按组聚合
          structured: { scheduledTask: { taskId: groupId } } satisfies StructuredMarkers,
        };
      },
    },
  );
}

async function handleUpdate(args: ManageArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!args.taskId) return { isError: true, text: 'update 需要 taskId' };
  const now = Date.now();
  // taskId 语义＝组 id（list 按组返回 groupId）。按 groupId 取组内现有规则（升序）——回填 + 位置对齐
  // 既有 taskId 以保住 runCount/历史。组代表条 = 首条（组首条规则被删也仍取得到组，见 resolveGroup）。
  const existing = await resolveGroup(args.taskId);
  if (existing.length === 0) return { isError: true, text: `找不到定时任务 ${args.taskId}` };
  const cur = existing[0];
  // 改了 schedule(s) 才换算+逐条校验；否则沿用现有规则的 spec（只改 title/prompt/落点，不重排程）
  const provided = args.schedules?.length || args.schedule ? parseRules(args, now) : null;
  if (provided) for (const r of provided) assertRuleCreatable(r.spec, r.stopAfterRuns, now);
  const baseRules: ParsedRule[] = provided ?? existing.map((t) => ({ spec: t.spec, stopAfterRuns: t.stopAfterRuns }));

  const base = {
    title: args.title?.trim() || cur.title,
    prompt: args.prompt?.trim() || cur.prompt,
    runLocation: args.runLocation ?? cur.runLocation,
  };
  const displayRules: DisplayRule[] = baseRules.map((r, i) => ({
    ...r,
    // 预览游标按各条自己的锚点：既有条用其 createdAt（interval 网格原点）、新增条用 now（同建组语义）
    nextRunAt: cur.enabled ? computeNextRun(r.spec, now, existing[i]?.createdAt ?? now) : null,
  }));
  // propose 时的组规则指纹：批准时刻据它判「组在审批窗内有没有被改过」（execute 内比对）
  const proposeFingerprint = rulesFingerprint(existing);
  const draft = displayDraft(ctx, base, displayRules[0]);
  return proposeOrExecute(
    ctx,
    {
      id: newProposalId(),
      kind: 'scheduled-task',
      ownerId: ctx.ownerId,
      conversationId: ctx.conversationId,
      status: 'pending',
      createdAt: now,
      forceApproval: true,
      grantable: [{ kind: 'category', id: 'scheduledTask' }],
      action: 'update',
      taskId: cur.id,
      draft,
      rules: displayRules,
      title: '修改定时任务',
      description: `把「${cur.title}」改为 ${describeRulesText(displayRules)}`,
    },
    {
      approvalText: `已递交修改定时任务提案：「${cur.title}」→ ${describeRulesText(displayRules)}`,
      execute: async () => {
        // 审批窗内组可能已被删/改（await 后承重判断必须重读）。用户批准的是「对 propose 时那个组
        // 的修改」——组的规则集（身份+spec+次数）此后有任何漂移，位置对齐都可能嫁接历史/静默删改，
        // 一律如实报错请重新发起；指纹一致才落（此时 propose 快照的 taskId 对齐仍然成立）。
        const existingNow = await resolveGroup(cur.groupId);
        if (existingNow.length === 0)
          return { isError: true, text: `定时任务「${cur.title}」已不存在（可能在确认前被删除）` };
        if (rulesFingerprint(existingNow) !== proposeFingerprint)
          return {
            isError: true,
            text: `定时任务「${cur.title}」在等待确认期间被修改过，本次修改未执行——请基于当前状态重新发起`,
          };
        await updateTaskGroup(cur.groupId, {
          ...base,
          rules: baseRules.map((r, i) => ({ taskId: existing[i]?.id, spec: r.spec, stopAfterRuns: r.stopAfterRuns })),
        });
        await pushState();
        return { text: `已修改定时任务「${base.title}」。` };
      },
    },
  );
}

async function handleSimple(
  args: ManageArgs,
  ctx: ToolContext,
  action: 'delete' | 'pause' | 'resume',
): Promise<ToolResult> {
  if (!args.taskId) return { isError: true, text: `${action} 需要 taskId` };
  // taskId 语义＝组 id；按 groupId 取组代表（组首条规则被删后 getScheduledTask(id) 会落空，见 resolveGroup）
  const cur = (await resolveGroup(args.taskId))[0];
  if (!cur) return { isError: true, text: `找不到定时任务 ${args.taskId}` };

  const verb = action === 'delete' ? '删除' : action === 'pause' ? '暂停' : '启用';
  const now = Date.now();
  return proposeOrExecute(
    ctx,
    {
      id: newProposalId(),
      kind: 'scheduled-task',
      ownerId: ctx.ownerId,
      conversationId: ctx.conversationId,
      status: 'pending',
      createdAt: now,
      forceApproval: true,
      grantable: [{ kind: 'category', id: 'scheduledTask' }],
      action,
      taskId: cur.id,
      title: `${verb}定时任务`,
      description: `${verb}「${cur.title}」`,
    },
    {
      approvalText: `已递交${verb}定时任务提案：「${cur.title}」`,
      execute: async () => {
        // 审批窗内组可能已被删（await 后承重判断必须重读）：重读现状，如实报错而非谎称已删/停/启
        const alive = (await listScheduledTasks()).some((t) => t.groupId === cur.groupId);
        if (!alive) return { isError: true, text: `定时任务「${cur.title}」已不存在（可能在确认前被删除）` };
        // 组级：删/停/启整组（单规则组等价于对那一条）
        if (action === 'delete') await deleteTaskGroup(cur.groupId);
        else await setTaskGroupEnabled(cur.groupId, action === 'resume');
        await pushState();
        return { text: `已${verb}定时任务「${cur.title}」。` };
      },
    },
  );
}

export function locationText(loc: ScheduledRunLocation): string {
  // channel 落点工具面暂不开放创建（enum 未含），但 AI 编辑既有渠道任务时确认卡要如实描述落点，
  // 不能谎报成「指定对话」（整体验收 2026-07-13 发现）。
  if (loc.kind === 'channel') return `推送到渠道（${loc.platform === 'feishu' ? '飞书' : 'Discord'}）`;
  return loc.kind === 'newConversation' ? '每次新建对话' : '指定对话';
}

