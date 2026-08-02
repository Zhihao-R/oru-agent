/**
 * 任务的 5 个 agent 工具：list_tasks / create_task / update_task / delete_task / restore_task
 *
 * - 工具名 + 参数采用 PRD §5.5 的 snake_case；内部翻译到 store 的 camelCase
 * - 5 个全部注册到 'twinMain'（不引入新 LlmUsage——见 tech doc §3 / §7.6）
 * - delete_task 内置"自删守卫"：评论场景 ctx.boardCurrentTaskId === id 时返回 isError，
 *   防止 Oru 在自己的评论线里把当前任务删掉破坏评论线（PRD 6.2 / tech doc §12 边界 case）
 */
import type { AgentTool } from '@shared/agent/backend';
import type {
  BoardActorId,
  BoardTaskFilters,
  BoardTaskStatus,
} from '@shared/types';
import * as taskboardStore from '../../taskboard/store';
import type { UpdatePatch } from '../../taskboard/store';

const STATUS_VALUES: BoardTaskStatus[] = ['待办', '进行中', '待验收', '已完成'];
const ASSIGNEE_VALUES: BoardActorId[] = ['you', 'oru'];

function toolErrorText(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const code = err?.code ? `[${err.code}] ` : '';
  return `${code}${err?.message ?? String(e)}`;
}

// ─────────────────────────────────────────────────────────────
// list_tasks
//
// 描述风格说明：本工具是 router-critical（Twin 选错会把记忆查询误当任务查询），
// atomcode-cadence 第一波优先升级到"该用 / 别用 / 失败"四要素格式。同文件内
// create_task / update_task / delete_task / restore_task 是写操作，调用前用户已明示意图，
// 误选风险低，保持原格式。后续若发现写操作工具也误选，再批量升级。
// ─────────────────────────────────────────────────────────────

type ListTasksInput = {
  status?: BoardTaskStatus[];
  project_tag?: string;
  assignee?: BoardActorId;
  include_deleted?: boolean;
  q?: string;
};

export function makeListTasksTool(): AgentTool {
  return {
    name: 'list_tasks',
    mutatesEnvironment: false,
    description: `查询任务列表（用户的待办、进行中、已完成项）。

**该用**：用户问"我还有什么任务" / "X 项目下我在做啥" / "回收站里有啥"；你判断该 commit / 该派活前先看一眼当前在做什么。

**别用**：
- 用户问"我之前说过 X"——这是记忆查询，用 grep_memory + read_memory，不是 taskboard
- 用户给的"任务"是闲聊式承诺（"我打算明天去跑步"）——这不是 Oru 任务系统范畴，别 taskboard 也别 propose

所有筛选参数可选可叠加：
- status：状态数组，例 ["待办","进行中","待验收"] 查未完成全集
- project_tag：按项目 tag 过滤
- assignee："you" / "oru"
- include_deleted：默认 false——查回收站要显式传 true
- q：标题+描述关键词模糊匹配

失败时：通常不失败；如果 fs 异常按返回错误告诉用户而不是重试。`,
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          items: { type: 'string', enum: STATUS_VALUES },
          description: '状态枚举数组；不传 = 不按状态过滤',
        },
        project_tag: {
          type: 'string',
          description: '按项目 tag 过滤；不传 = 全部项目',
        },
        assignee: {
          type: 'string',
          enum: ASSIGNEE_VALUES,
          description: '归属人 actor id；不传 = 全部归属人',
        },
        include_deleted: {
          type: 'boolean',
          description: '是否包含回收站项；默认 false',
        },
        q: {
          type: 'string',
          description: '标题/描述关键词模糊匹配（小写包含）',
        },
      },
    },
    async execute(input) {
      const args = (input ?? {}) as ListTasksInput;
      const filters: BoardTaskFilters = {
        status: args.status,
        projectTag: args.project_tag,
        assignee: args.assignee,
        includeDeleted: args.include_deleted,
        q: args.q,
      };
      try {
        const tasks = await taskboardStore.listTasks(filters);
        if (tasks.length === 0) {
          return { text: '(没有匹配的任务)' };
        }
        // 按状态分组（含 deleted 时单独分一组）
        const groups = new Map<string, string[]>();
        for (const t of tasks) {
          const groupKey = t.deletedAt ? '回收站' : t.status;
          const tag = t.projectTag ? ` #${t.projectTag}` : '';
          const line = `[${t.id}] ${t.title}  @${t.assignee}${tag}`;
          const arr = groups.get(groupKey) ?? [];
          arr.push(line);
          groups.set(groupKey, arr);
        }
        const order = [...STATUS_VALUES, '回收站'];
        const sections: string[] = [];
        for (const k of order) {
          const arr = groups.get(k);
          if (!arr || arr.length === 0) continue;
          sections.push(`${k} (${arr.length})\n${arr.map((l) => `  ${l}`).join('\n')}`);
        }
        return { text: `共 ${tasks.length} 条任务：\n${sections.join('\n\n')}` };
      } catch (e) {
        return { isError: true, text: toolErrorText(e) };
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────
// create_task
// ─────────────────────────────────────────────────────────────

type CreateTaskInput = {
  title: string;
  description?: string;
  status?: BoardTaskStatus;
  assignee?: BoardActorId;
  project_tag?: string;
};

export function makeCreateTaskTool(): AgentTool {
  return {
    name: 'create_task',
    mutatesEnvironment: true,
    description:
      '新建一条任务。title 必填；其他可选。assignee 不传默认 "you"（用户）——' +
      '这是 PRD 主场景：用户让 Oru 帮建任务时，归属人通常是用户自己。' +
      '如果是 Oru 自己要做这件事，请显式传 "oru"。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题（必填）' },
        description: { type: 'string', description: '描述（可选，留空合法）' },
        status: {
          type: 'string',
          enum: STATUS_VALUES,
          description: '初始状态；不传默认"待办"',
        },
        assignee: {
          type: 'string',
          enum: ASSIGNEE_VALUES,
          description: '归属人；不传默认 "you"（用户）。Oru 自己要做才传 "oru"',
        },
        project_tag: { type: 'string', description: '项目 tag；自由文本' },
      },
      required: ['title'],
    },
    async execute(input) {
      const args = (input ?? {}) as CreateTaskInput;
      try {
        const t = await taskboardStore.createTask(
          {
            title: args.title,
            description: args.description,
            status: args.status,
            assignee: args.assignee,
            projectTag: args.project_tag,
          },
          'you',
        );
        return { text: `已新建任务 [${t.id}]：${t.title}` };
      } catch (e) {
        return { isError: true, text: toolErrorText(e) };
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────
// update_task
// ─────────────────────────────────────────────────────────────

type UpdateTaskInput = {
  id: string;
  fields: Partial<{
    title: string;
    description: string;
    status: BoardTaskStatus;
    assignee: BoardActorId;
    project_tag: string;
  }>;
};

export function makeUpdateTaskTool(): AgentTool {
  return {
    name: 'update_task',
    mutatesEnvironment: true,
    description:
      '修改任务字段（title / description / status / assignee / project_tag）。' +
      'status 反映"实际在做"的事实，Oru 不自行推断并修改——' +
      '只在用户明确说"标为进行中/已完成"或"把这个改成 X"等时才传 status。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        fields: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: STATUS_VALUES },
            assignee: { type: 'string', enum: ASSIGNEE_VALUES },
            project_tag: { type: 'string' },
          },
        },
      },
      required: ['id', 'fields'],
    },
    async execute(input) {
      const args = (input ?? {}) as UpdateTaskInput;
      const patch: UpdatePatch = {};
      const f = args.fields ?? {};
      if ('title' in f) patch.title = f.title;
      if ('description' in f) patch.description = f.description;
      if ('status' in f) patch.status = f.status;
      if ('assignee' in f) patch.assignee = f.assignee;
      if ('project_tag' in f) patch.projectTag = f.project_tag;
      try {
        const t = await taskboardStore.updateTask(args.id, patch);
        return { text: `已更新任务 [${t.id}]：${t.title}` };
      } catch (e) {
        return { isError: true, text: toolErrorText(e) };
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────
// delete_task（含自删守卫）
// ─────────────────────────────────────────────────────────────

type DeleteTaskInput = { id: string };

export function makeDeleteTaskTool(): AgentTool {
  return {
    name: 'delete_task',
    mutatesEnvironment: true,
    description: '把任务移入回收站（软删除，可随时恢复）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
      },
      required: ['id'],
    },
    async execute(input, ctx) {
      const args = (input ?? {}) as DeleteTaskInput;
      // 自删守卫：评论场景 boardCurrentTaskId 才会被注入；主聊天永远 undefined
      // truthy 校验防御 null / 空串等异常注入值——只有"双方都是非空且相等"才拦
      if (ctx.boardCurrentTaskId && args.id && args.id === ctx.boardCurrentTaskId) {
        return {
          isError: true,
          text:
            '不能在该任务自己的评论里删除该任务——会破坏当前评论线。' +
            '请用户在任务详情面板里手动删除，或回主聊天里删。',
        };
      }
      try {
        const t = await taskboardStore.softDeleteTask(args.id, 'oru');
        return { text: `已删除任务 [${t.id}]：${t.title}（已进回收站，可随时恢复）` };
      } catch (e) {
        return { isError: true, text: toolErrorText(e) };
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────
// restore_task
// ─────────────────────────────────────────────────────────────

type RestoreTaskInput = { id: string };

export function makeRestoreTaskTool(): AgentTool {
  return {
    name: 'restore_task',
    mutatesEnvironment: true,
    description: '从回收站恢复任务到主视图。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
      },
      required: ['id'],
    },
    async execute(input) {
      const args = (input ?? {}) as RestoreTaskInput;
      try {
        const t = await taskboardStore.restoreTask(args.id);
        return { text: `已恢复任务 [${t.id}]：${t.title}` };
      } catch (e) {
        return { isError: true, text: toolErrorText(e) };
      }
    },
  };
}
