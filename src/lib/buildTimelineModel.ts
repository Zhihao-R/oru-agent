/**
 * O(n) 线性扫描：扁平 DebugRecord[] → 嵌套 TimelineModel
 *
 * 关键点：parallel_group_start / done 是主进程 derive.ts FSM emit 的边界 record，
 * 前端只需"识别归组"——**不做二次 FSM**。
 *
 * 时间线节点类型：
 * - LLM 调用：合并 llm_call_start + llm_call_done 为一个节点
 * - 工具调用：合并 tool_call_start + tool_call_done 为一个节点（属于 group 时归入 group.children）
 * - 并发组：parallel_group_start 开 group，parallel_group_done 关 group
 * - 其他事件（round_start / prompt_built / final_answer / round_done / error）：直接作为顶层节点
 */
import type { DebugRecord, DebugPayloadMap } from '@shared/debug/types';

/**
 * 时间线节点的"显示类型"——独立于 DebugEventType 的命名空间，避免两套 namespace 混用。
 * 'llm_call' 合并 llm_call_start + llm_call_done；'tool_call' 合并 tool_call_start + tool_call_done；
 * 其他直接复用原始事件类型。
 */
export type DisplayType =
  | 'llm_call'
  | 'tool_call'
  | 'round_start'
  | 'prompt_built'
  | 'inference_view'
  | 'final_answer'
  | 'error'
  | 'parallel_group_start'
  | 'parallel_group_done'
  | 'round_done';

/** 工具调用的扁平元数据——name/input 来自 tool_call_start，详情面板和 EventRow 直接读，
 *  不再透出整个 DebugRecord<'tool_call_start'>，避免 backend schema 拆分细节渗透到前端模型 */
export interface ToolMeta {
  name: string;
  input: Record<string, unknown>;
}

/** 时间线上一行：单个事件（已合并 start+done） */
export interface TimelineEvent {
  kind: 'event';
  /** 在 ndjson 里的源 record（用于详情面板渲染——以 done 优先；无 done 时用 start） */
  record: DebugRecord;
  /** 显示类型（独立命名空间，与 record.type 解耦） */
  displayType: DisplayType;
  /** 是否未完成（start 落盘但 done 没落盘——卡死或 crash） */
  unfinished?: boolean;
  /** 工具调用专用扁平元数据（含 name / input；done payload 上没这俩字段） */
  toolMeta?: ToolMeta;
  /** 标识符（用于 selectEvent 选中） */
  id: string;
  /**
   * 节点的"事件起始相对时间"（毫秒）。
   * 合并节点（llm_call / tool_call）取 start.relMs；未合并节点直接 = record.relMs。
   * 关键：跟并发组 startRecord.relMs 在同一时间维度上对比——避免 done 时刻误读。
   */
  relMs: number;
}

export interface TimelineGroup {
  kind: 'group';
  groupId: string;
  llmCallIndex: number;
  /** group_done 没到来时为 undefined（组未完成） */
  longestDurationMs?: number;
  /** start record（用于 selectEvent） */
  startRecord: DebugRecord<'parallel_group_start'>;
  doneRecord?: DebugRecord<'parallel_group_done'>;
  children: TimelineEvent[];
  id: string;
}

export type TimelineNode = TimelineEvent | TimelineGroup;

export interface TimelineModel {
  /** round_start 记录（含 userText / source / attachments），方便顶部展示 */
  roundStart?: DebugRecord<'round_start'>;
  /** round_done（含 token 汇总） */
  roundDone?: DebugRecord<'round_done'>;
  /** final_answer 记录 */
  finalAnswer?: DebugRecord<'final_answer'>;
  /** 顶层节点列表，按 ndjson 顺序排列 */
  nodes: TimelineNode[];
}

export function buildTimelineModel(records: DebugRecord[]): TimelineModel {
  const model: TimelineModel = { nodes: [] };

  /** 当前正在累积的并发组；null 表示在顶层 */
  let currentGroup: TimelineGroup | null = null;

  /** llm_call_start / tool_call_start 记下来等 done 来合并；key = callIndex 或 toolCallId */
  const pendingLlmStart = new Map<number, DebugRecord<'llm_call_start'>>();
  const pendingToolStart = new Map<string, DebugRecord<'tool_call_start'>>();

  function pushEvent(ev: TimelineEvent): void {
    if (currentGroup) currentGroup.children.push(ev);
    else model.nodes.push(ev);
  }

  for (const rec of records) {
    switch (rec.type) {
      case 'round_start':
        model.roundStart = rec as DebugRecord<'round_start'>;
        model.nodes.push({
          kind: 'event',
          record: rec,
          displayType: 'round_start',
          id: `${rec.type}-${rec.seq}`,
          relMs: rec.relMs,
        });
        break;

      case 'prompt_built':
        pushEvent({
          kind: 'event',
          record: rec,
          displayType: 'prompt_built',
          id: `${rec.type}-${rec.seq}`,
          relMs: rec.relMs,
        });
        break;

      case 'inference_view':
        // adapter 输出归档——v0.5 新事件，承载 wireHistory（PRD 术语：真实入参）。
        // 每次 backend.runConversation 一条；撞墙 retry / passive compress 后多条。
        // 跟 llm_call 同一时间尺度，作为顶层节点；不入并发组。
        pushEvent({
          kind: 'event',
          record: rec,
          displayType: 'inference_view',
          id: `${rec.type}-${rec.seq}`,
          relMs: rec.relMs,
        });
        break;

      case 'error':
        // error 事件意味着主流出问题——若并发组未关闭，强制收尾，避免后续节点错位
        currentGroup = null;
        pushEvent({
          kind: 'event',
          record: rec,
          displayType: 'error',
          id: `${rec.type}-${rec.seq}`,
          relMs: rec.relMs,
        });
        break;

      case 'llm_call_start':
        // 新一次 LLM 调用 → 上一个 group（如果还开着）一定已结束。这是对 parallel_group_done
        // 缺失（kill -9）的兜底：保证后续 tool_call_done 不会被错误吞进上一个 group。
        currentGroup = null;
        pendingLlmStart.set((rec.payload as DebugPayloadMap['llm_call_start']).callIndex, rec as DebugRecord<'llm_call_start'>);
        break;

      case 'llm_call_done': {
        // LLM 调用结束节点一定属于顶层——backend 的 yield 顺序里 llm_usage 在 tool_use 之后，
        // 这条 record 在 ndjson 物理上落在 parallel_group_start 之后；前端按"语义归属"重排到顶层。
        // 注意：不关闭 currentGroup——这条 record 是当前 group 的"产生者"（LLM 输出 tool_use
        // 触发的 group），group 仍在进行中（tool_result 还没 emit）。
        const callIndex = (rec.payload as DebugPayloadMap['llm_call_done']).callIndex;
        const startRec = pendingLlmStart.get(callIndex);
        model.nodes.push({
          kind: 'event',
          record: rec,
          displayType: 'llm_call',
          id: `llm-${callIndex}-${rec.seq}`,
          relMs: startRec ? startRec.relMs : rec.relMs,
        });
        pendingLlmStart.delete(callIndex);
        break;
      }

      case 'parallel_group_start': {
        const p = rec.payload as DebugPayloadMap['parallel_group_start'];
        currentGroup = {
          kind: 'group',
          groupId: p.groupId,
          llmCallIndex: p.llmCallIndex,
          startRecord: rec as DebugRecord<'parallel_group_start'>,
          children: [],
          id: `group-${p.groupId}`,
        };
        model.nodes.push(currentGroup);
        break;
      }

      case 'parallel_group_done': {
        const p = rec.payload as DebugPayloadMap['parallel_group_done'];
        if (currentGroup && currentGroup.groupId === p.groupId) {
          currentGroup.doneRecord = rec as DebugRecord<'parallel_group_done'>;
          currentGroup.longestDurationMs = p.longestDurationMs;
          currentGroup = null;
        }
        // 容错：groupId 不匹配（不该发生但 ndjson 残缺时保护）——直接清空
        else {
          currentGroup = null;
        }
        break;
      }

      case 'tool_call_start':
        pendingToolStart.set(
          (rec.payload as DebugPayloadMap['tool_call_start']).toolCallId,
          rec as DebugRecord<'tool_call_start'>,
        );
        break;

      case 'tool_call_done': {
        const id = (rec.payload as DebugPayloadMap['tool_call_done']).toolCallId;
        const startRec = pendingToolStart.get(id);
        const toolMeta: ToolMeta | undefined = startRec
          ? { name: startRec.payload.name, input: startRec.payload.input }
          : undefined;
        pushEvent({
          kind: 'event',
          record: rec,
          displayType: 'tool_call',
          toolMeta,
          id: `tool-${id}-${rec.seq}`,
          // 同 llm_call：取 start.relMs，跟并发组 startRecord.relMs 对齐
          relMs: startRec ? startRec.relMs : rec.relMs,
        });
        pendingToolStart.delete(id);
        break;
      }

      case 'final_answer':
        // final_answer 是整轮的"最后一帧"——若并发组未关闭，强制关掉，避免最终回答被吞进 group
        currentGroup = null;
        model.finalAnswer = rec as DebugRecord<'final_answer'>;
        pushEvent({
          kind: 'event',
          record: rec,
          displayType: 'final_answer',
          id: `final-${rec.seq}`,
          relMs: rec.relMs,
        });
        break;

      case 'round_done':
        model.roundDone = rec as DebugRecord<'round_done'>;
        // round_done 不放进 nodes——它的字段已被 RoundSummary 消费，时间线视图不重复展示
        break;
    }
  }

  // 收尾：未完成的 LLM / tool / group 作为"卡死"占位节点放进时间线，让用户能看见
  for (const startRec of pendingLlmStart.values()) {
    pushEvent({
      kind: 'event',
      record: startRec,
      displayType: 'llm_call',
      unfinished: true,
      id: `llm-unfinished-${startRec.seq}`,
      relMs: startRec.relMs,
    });
  }
  for (const startRec of pendingToolStart.values()) {
    pushEvent({
      kind: 'event',
      record: startRec,
      displayType: 'tool_call',
      unfinished: true,
      toolMeta: { name: startRec.payload.name, input: startRec.payload.input },
      id: `tool-unfinished-${startRec.seq}`,
      relMs: startRec.relMs,
    });
  }

  return model;
}
