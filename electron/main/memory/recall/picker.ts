/**
 * 廉价召回挑选器 —— recall 流水线第 2 步「判断相关」（recall tech-design §1.2 / §1.5 / §1.6）
 *
 * 每轮跑一个便宜小模型（usage='memoryRecall'），读「候选简介块 + 洗过的对话窗口」，只回该注入哪几条 id。
 * - 输入布局为缓存切成稳定前缀 + 可变尾部：systemContext = [指令 + 候选简介块]（一段对话内稳定、可缓存），
 *   prompt = [对话窗口]（每轮变）。
 * - 只回 id，不回内容（§1.5）；selected 固定上限、高精度门槛（确定相关才选，宁缺毋滥）。
 * - disableReasoning：挑选是判断不是推理，关思考省 10-20× 耗时（呼应「又便宜、随规模不变慢」）。
 */
import { newMessageId } from '@shared/ids';
import type { AgentBackend } from '@shared/agent/backend';
import type { RoundSource } from '@shared/debug/types';
import type { LlmUsage } from '@shared/types';
import type { RecallTurn } from '@shared/memory/recall';
import { getBackendFor, resolveThinkingDisable } from '../../agent/backends';
import { getSettings } from '../../projects/store';
import { instrumentOneShot } from '../../debug/instrument';
import type { EpisodeBrief } from './briefs';

/** 召回挑选器需要的 backend 能力：发 one-shot + 调试日志要的三个只读字段 */
export type PickerBackend = Pick<AgentBackend, 'runOneShot' | 'backendType' | 'modelId' | 'providerId'>;

/** selected 固定上限（PRD「选中 ≤5 常为 0」） */
export const SELECTED_LIMIT = 5;

export type PickerOutput = { selected: string[]; hints: string[] };

const PICKER_INSTRUCTION = `你是记忆召回挑选器。下面给你一批「候选往事」的一行简介，和「当前对话」的最近几轮。
从候选里挑出**与当前对话此刻在聊的事确实相关**的几条，只回它们的 id。

规则：
- **高精度优先，宁缺毋滥**：只在**确定相关**时才选；拿不准、只是字面沾边、泛泛主题相近——都不要选。常常一条都不该选。
- 最多选 ${SELECTED_LIMIT} 条。
- 另给 hints：阈值正下方、相关度次高但你没选进 selected 的几条 id（near-miss 邻居），供主模型按需自取。
- **只回简介里出现过的 id**，不要编造。`;

const PICKER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    // 约束话术（上限/宁缺毋滥）单点放 instruction，schema description 只说结构语义
    selected: { type: 'array', items: { type: 'string' }, description: '确定相关的候选 id' },
    hints: { type: 'array', items: { type: 'string' }, description: 'near-miss 邻居 id' },
  },
  required: ['selected', 'hints'],
} as const;

/** 通用相关性挑选候选：id + 一行简介。EpisodeBrief 天然满足；能力候选（子系统 C）也复用。 */
export type PickCandidate = { id: string; line: string };

/** 通用挑选器 systemContext：指令 + 候选简介块。挑选任务不同、指令不同，候选块结构相同。 */
export function buildPickSystemContext(instruction: string, sectionTitle: string, candidates: PickCandidate[]): string {
  return [instruction, '', sectionTitle, ...candidates.map((c) => c.line)].join('\n');
}

export function buildPickerSystemContext(briefs: EpisodeBrief[]): string {
  return buildPickSystemContext(PICKER_INSTRUCTION, '## 候选往事（一行一条）', briefs);
}

export function buildPickerPrompt(window: RecallTurn[]): string {
  return ['## 当前对话', ...window.map((t) => `${t.role === 'user' ? '用户' : 'Oru'}：${t.text}`)].join('\n');
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 解析挑选器输出：容忍 markdown 围栏；selected / hints 一律过滤到 validIds、selected 去重截上限、hints 排除 selected。 */
export function parsePickerOutput(raw: string, validIds: Set<string>): PickerOutput {
  let parsed: unknown;
  try {
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw.trim());
    parsed = JSON.parse(fence ? fence[1] : raw.trim());
  } catch {
    return { selected: [], hints: [] };
  }
  const obj = parsed as { selected?: unknown; hints?: unknown };
  const selected: string[] = [];
  for (const id of asStringArray(obj.selected)) {
    if (validIds.has(id) && !selected.includes(id)) selected.push(id);
    if (selected.length >= SELECTED_LIMIT) break;
  }
  const selectedSet = new Set(selected);
  const hints: string[] = [];
  for (const id of asStringArray(obj.hints)) {
    if (validIds.has(id) && !selectedSet.has(id) && !hints.includes(id)) hints.push(id);
  }
  return { selected, hints };
}

/**
 * 通用相关性挑选器：读「候选简介块 + 对话窗口」，回该选哪几条 id。记忆召回与能力推送（子系统 C）
 * 共用同一套廉价小模型调用（disableReasoning + cacheSystem）——同问题同模式，仅指令与候选块不同。
 */
export async function runRelevancePick(
  candidates: PickCandidate[],
  window: RecallTurn[],
  cfg: { instruction: string; sectionTitle: string; source: RoundSource },
  opts?: { backend?: PickerBackend; ownerId?: string; signal?: AbortSignal; usage?: LlmUsage },
): Promise<PickerOutput> {
  if (candidates.length === 0) return { selected: [], hints: [] };
  const usage = opts?.usage ?? 'memoryRecall';
  const backend = opts?.backend ?? (await getBackendFor(usage));
  // 思考三态（Track B）：memoryRecall 默认关（挑选是判断不是推理，省 10-20× 耗时），走中央判据——
  // 用户想给召回开思考也能在设置里调。settings 在 callback 外取好，callback 保持同步。
  const disableReasoning = resolveThinkingDisable(usage, await getSettings());
  const systemContext = buildPickSystemContext(cfg.instruction, cfg.sectionTitle, candidates);
  const prompt = buildPickerPrompt(window);
  // 接调试日志闸门（每次 LLM 调用都看得到，同 capture / loop reviewer 范式）
  const raw = await instrumentOneShot(
    backend,
    {
      roundId: newMessageId(),
      conversationId: `${cfg.source}_${opts?.ownerId ?? 'anon'}`,
      ownerId: opts?.ownerId ?? '',
      source: cfg.source,
      userText: prompt,
    },
    () =>
      backend.runOneShot(
        {
          prompt,
          systemContext,
          outputSchema: PICKER_OUTPUT_SCHEMA as object,
          disableReasoning,
          // 简介块缓存（PRD §5.4 第二支柱）：systemContext=[指令+候选简介块] 一段对话内稳定，缓存它
          // 让每轮只重算对话尾部——延迟不随候选变多而变长。能力简介全静态、缓存命中更稳。
          cacheSystem: true,
        },
        opts?.signal,
      ),
    systemContext,
  );
  return parsePickerOutput(raw, new Set(candidates.map((c) => c.id)));
}

export async function runRecallPicker(
  briefs: EpisodeBrief[],
  window: RecallTurn[],
  opts?: { backend?: PickerBackend; ownerId?: string; signal?: AbortSignal },
): Promise<PickerOutput> {
  return runRelevancePick(
    briefs,
    window,
    { instruction: PICKER_INSTRUCTION, sectionTitle: '## 候选往事（一行一条）', source: 'memory_recall' },
    opts,
  );
}
