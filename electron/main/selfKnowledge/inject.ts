/**
 * 自我认知按相关性注入（子系统 C，S35·G05）
 *
 * 常驻锚点（子系统 B，prompts/selfKnowledge.ts）只给「诚实声明 + 各领域一句话线索」，不列具体能力。
 * 具体能力详情由本模块**按当前话题相关性**带进来：每轮读「能力候选简介 + 对话窗口」跑一次廉价小模型
 * 挑相关能力，取其全文注入动态段（runner.dynamicPart）。
 *
 * 与记忆召回的关系（复用而非耦合）：共用同一套通用相关性挑选器（recall/picker 的 runRelevancePick，
 * disableReasoning + cacheSystem），但走**独立的一次调用**——能力候选全静态、缓存前缀极稳，且能力挑选
 * 不受记忆召回 tier1「≤50 全带跳过挑选」影响（能力池数十条无法全带、天然需要挑选）。不并进 MemoryRecaller
 * 接口，保记忆流水线零回归。
 *
 * 防注入边界（同记忆召回）：能力块由编排层拼装。但与记忆块不同，能力是**关于 Oru 自己的当前权威事实**、
 * 不是"过去背景"，故**不打"非当前指令"围栏**——它就是当前事实源。
 */
import type { ChatMessage } from '@shared/types';
import { projectConversationWindow } from '../memory/recall/window';
import { runRelevancePick, type PickCandidate, type PickerBackend } from '../memory/recall/picker';
import { withTimeout } from '../memory/recall/inject';
import { candidateSummaries, getByIds } from './registry';

const DEFAULT_TIMEOUT_MS = 8000;

const CAP_PICKER_INSTRUCTION = `你是 Oru 的能力推送挑选器。下面给你一批「Oru 的能力」的一行简介，和「当前对话」的最近几轮。
判断这段对话此刻是否涉及某项能力（用户在问 Oru 能不能做某事、怎么用某功能，或话题正需要某能力），挑出**确实相关**的几条，只回它们的 id。

规则：
- **高精度优先，宁缺毋滥**：只在这段对话**确实涉及**该能力时才选；泛泛闲聊、只是字面沾边——都不要选。常常一条都不该选。
- **只回简介里出现过的 id**，不要编造；hints 不需要，留空数组即可。`;

const BLOCK_TITLE = '## 你的相关能力（关于 Oru 自己的当前事实，据此回答「你能不能 / 怎么用」，别凭记忆现编）';

export type SelfKnowledgeInjectionArgs = {
  ownerId: string;
  history: ChatMessage[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 测试注入挑选器后端；缺省走 getBackendFor('memoryRecall') */
  pickerBackend?: PickerBackend;
};

/** 一条能力简介行——picker 回 id，行首必须带 id */
function capLine(c: { id: string; summary: string }): PickCandidate {
  return { id: c.id, line: `- ${c.id}：${c.summary}` };
}

export async function buildSelfKnowledgeInjection(args: SelfKnowledgeInjectionArgs): Promise<string> {
  let candidates: PickCandidate[];
  try {
    candidates = candidateSummaries().map(capLine);
  } catch {
    return ''; // registry 未初始化 → 本轮不带能力详情（常驻锚点仍在）
  }
  if (candidates.length === 0) return '';

  const window = projectConversationWindow(args.history);
  if (window.length === 0) return ''; // 无对话上下文可判相关性

  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  args.signal?.addEventListener('abort', onOuterAbort, { once: true });
  let selectedIds: string[];
  try {
    const out = await withTimeout(
      runRelevancePick(
        candidates,
        window,
        { instruction: CAP_PICKER_INSTRUCTION, sectionTitle: '## 候选能力（一行一条）', source: 'self_knowledge' },
        { backend: args.pickerBackend, ownerId: args.ownerId, signal: ctl.signal },
      ),
      timeoutMs,
      () => ctl.abort(),
      'self-knowledge',
    );
    selectedIds = out.selected;
  } catch {
    return ''; // 超时 / abort / 故障 → 本轮不带能力详情，不阻塞回复
  } finally {
    args.signal?.removeEventListener('abort', onOuterAbort);
  }

  return renderCapabilityBlock(selectedIds);
}

/** 取选中能力全文、拼成注入块（无围栏——是当前权威事实）。selectedIds 为空回空串。 */
function renderCapabilityBlock(selectedIds: string[]): string {
  if (selectedIds.length === 0) return '';
  const entries = getByIds(selectedIds); // 确定性序、未知 id 静默跳过
  if (entries.length === 0) return '';
  const out: string[] = [BLOCK_TITLE];
  for (const e of entries) {
    out.push('', `### ${e.title}`, '', e.body);
  }
  return out.join('\n');
}

// 测试导出
export { renderCapabilityBlock as __renderCapabilityBlock, CAP_PICKER_INSTRUCTION as __CAP_PICKER_INSTRUCTION };
