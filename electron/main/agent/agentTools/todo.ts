/**
 * todo AgentTool（计划清单，S32·G49）—— 主 Oru 记这条对话当前的工作计划，逐项标进度。
 *
 * 语义仿 Claude Code TodoWrite：每次调用**覆盖整份清单**（AI 带完整列表再传，不做增量）。清单按对话
 * 落盘（todoStore）、每轮贴回模型眼前（hooks.buildRuntimeContext）、了结后在下一轮开始时清掉
 * （todoSweep）。只有主 Oru 记账——subagent 与定时执行体拿不到这个工具（factory 层剔除）。
 *
 * 覆盖式写入会经 reviseTodos 跟上一版比对：开过工或卡住过的项凭空消失，自动补一条 removed 留痕
 * （只记录、不报警、不拦截）。
 */
import type { AgentTool, ToolContext, ToolResult } from '@shared/agent/backend';
import type { TodoItem, TodoStatus } from '@shared/types';
import { TODO_STATUSES, TODO_STATUS_META, renderTodoLines } from '@shared/todo';
import { updateTodos } from '../todoStore';

const TOOL_DESC = `记这条对话当前的工作计划清单，逐项标进度——你自己和用户都靠它看清活干到哪儿了。

什么时候列：这件事要三步以上，或者用户一次交办了好几件；一两步的小事不用列。
怎么记账：开工一项之前先把它标 in_progress，做完立刻标 done，不要攒到最后一起标。同一时刻通常只让一项 in_progress。
写：带上完整的 items 列表（含没变的项）——**每次覆盖整份清单**，不是增量追加。

状态：
- pending：还没开始
- in_progress：正在做
- done：做完了
- stuck：卡住了。做了一半、报错没解决、缺前提没法继续——**这三种情况都不许标 done**，标 stuck 并在 note 里写清卡在哪
- removed：不做了。计划变了、这项没必要了，在 note 里写为什么

计划变了就整份重写清单，这是正常动作，重写时顺带说一句为什么变；但别拿重写去抹掉没做完的项——开过工或卡住的项凭空消失，会被自动记成一条 removed 留在清单上。

全部项都到终点（done / removed）之后，这份清单会在下一轮开始时自动清掉，不用你手动清空。`;

type TodoCtx = Pick<ToolContext, 'ownerId' | 'agentId' | 'conversationId'>;

/**
 * 覆盖式写入的合并：把上一版里被抹掉、却开过工或卡住过的项补成 removed 留痕。
 *
 * 判据是「这一项开工过或卡住过吗」，不是「这还是不是同一份计划」——后者曾考虑用新旧两版有无交集
 * 判，已放弃：「跑测试」这类通用项跨计划天然复现，撞上一项就会把整份旧计划当幽灵行涌进新清单。
 */
function mergeRevision(prev: TodoItem[], next: TodoItem[]): TodoItem[] {
  const kept = new Set(next.map((it) => it.content));
  const traces: TodoItem[] = [];
  for (const it of prev) {
    if (kept.has(it.content)) continue;
    // 上一版已是留痕项：原样挪过来，连 note 一起（别把已写好的原因冲成空）
    if (it.status === 'removed') traces.push(it);
    else if (TODO_STATUS_META[it.status].leavesTrace) traces.push({ content: it.content, status: 'removed' });
  }
  return [...next, ...traces];
}

/** 写入一版新清单，返回合并留痕后的结果——推 UI 与回执都要用这个返回值，否则补出的项谁也看不见。 */
export function reviseTodos(ctx: TodoCtx, next: TodoItem[]): Promise<TodoItem[]> {
  return updateTodos(ctx.ownerId, ctx.agentId, ctx.conversationId, (prev) => mergeRevision(prev, next));
}

/**
 * stuck / removed 缺 note 时点名，但**不返回 isError**：三条不诚实的路（标完成、赖在进行中、
 * 整项删掉）都是零摩擦的，唯一诚实的路要是还得付一次报错加一轮往返，激励梯度就反了。
 *
 * 只查**模型这次自己传进来的项**，不查合并后的清单：`mergeRevision` 补出的 removed 留痕本来就
 * 没有原因（是系统代记的），对它点名等于让模型为自己没做过的动作找理由，而且那条留痕会原样留在
 * 清单里，此后每次调用都要被点一次名——「只记录、不报警」的设计立场会被这条提示抵消掉。
 */
function missingNoteHint(items: TodoItem[]): string {
  const bad = items.filter((it) => TODO_STATUS_META[it.status].wantsNote && !it.note);
  if (bad.length === 0) return '';
  const names = bad.map((it) => `「${it.content}」`).join('、');
  return `\n\n（${names} 标了卡住 / 不做了，但没说原因，下次调用时补上 note。）`;
}

export function makeTodoTool(): AgentTool {
  return {
    name: 'todo',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '完整的计划清单（覆盖式）',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '这一项要做什么' },
              status: { type: 'string', enum: TODO_STATUSES, description: TODO_STATUSES.join(' / ') },
              note: { type: 'string', description: 'stuck / removed 时说明卡在哪、为什么不做了' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['items'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const raw = (input ?? {}) as { items?: unknown };
      // 只写不读：清单每轮由 buildRuntimeContext 贴进系统上下文，模型手里必然已有最新的一份，
      // 「读回来看看」是它只存内存那个年代的遗留动作（2026-07-28 PM 拍板删掉）。
      if (!Array.isArray(raw.items)) {
        return { isError: true, text: 'todo: 要带上 items（完整的计划清单，覆盖式；这个工具只写不读）' };
      }
      const items: TodoItem[] = [];
      for (const it of raw.items) {
        const o = (it ?? {}) as { content?: unknown; status?: unknown; note?: unknown };
        if (typeof o.content !== 'string' || o.content.trim().length === 0) {
          return { isError: true, text: 'todo: 每一项都要有非空 content' };
        }
        // 未知 status 如实报错，不静默降级成 pending——降级会把模型写的 blocked 悄悄变成「待办」，
        // 比标卡住还省事，正是这次要堵的漏洞。
        if (!TODO_STATUSES.includes(o.status as TodoStatus)) {
          return {
            isError: true,
            text: `todo: 未知的 status「${String(o.status)}」（「${o.content.trim()}」）——只能是 ${TODO_STATUSES.join(' / ')}`,
          };
        }
        const note = typeof o.note === 'string' && o.note.trim().length > 0 ? o.note.trim() : undefined;
        items.push({ content: o.content.trim(), status: o.status as TodoStatus, ...(note ? { note } : {}) });
      }
      const merged = await reviseTodos(ctx, items);
      ctx.onTodoUpdate?.(merged); // 推 UI 展示（无 UI 场景不挂——清单仍存、回执照给）
      const rendered = merged.length ? renderTodoLines(merged) : '（清单已清空）';
      return { text: `计划清单已更新：\n${rendered}${missingNoteHint(items)}` };
    },
  };
}
