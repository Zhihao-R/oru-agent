/**
 * 检索侧评估的执行层（决策 1 / Task 1）
 *
 * 两档口径分开测，定位失效点：
 *   - injectedVisible：把 ≥500 条语料写进临时 ORU_DIR，跑**真实** buildSnapshot，
 *     看 golden 的 compressedPath 有没有出现在注入索引里 —— 测"索引截断"漏召回。
 *   - toolRecalled：**对模型隐藏注入索引、只给 query**，强制它走真实 grep_memory /
 *     query_episodes / read_memory 工具，看 golden 有没有被工具捞回 —— 测"子串/结构化"兜底。
 *     （隐藏注入是承重前提：否则模型靠注入内容直接答会污染 toolRecall。）
 *
 * ⚠ ORU_DIR 范式：本模块不在顶层 import 记忆模块——调用方（run.ts / 测试）必须先
 * `process.env.ORU_DIR = tmp` 再 `await import(...)`，所以这里所有记忆模块都用动态 import。
 */
import type { ToolContext } from '@shared/agent/backend';
import {
  callOpenAICompat,
  type OAIMessage,
  type OAITool,
} from '../openaiClient';
import { type Corpus, type EpisodeFixture, type QueryMode, goldenOf } from './corpus';

export type RetrievalResult = {
  q: string;
  mode: QueryMode;
  golden: string[];
  injectedVisible: string[]; // 注入索引里可见的 golden
  toolRecalled: string[]; // 模型用 grep/query 实际捞回的 golden
};

export type BackendOpts = {
  ownerId: string;
  baseURL: string;
  apiKey: string;
  model: string;
  maxToolRounds?: number; // 单 query 的工具调用轮上限（默认 6）
};

// ─── 语料落盘（用真实 writeEpisode，保证注入/工具看到的是真磁盘结构） ──────────

export async function writeCorpusToDisk(ownerId: string, episodes: EpisodeFixture[]): Promise<void> {
  const { writeEpisode } = await import('../../../electron/main/memory/store');
  const { DEFAULT_AGENT_NAME } = await import('../../../electron/main/memory/paths');
  for (const ep of episodes) {
    const scopeId = ep.scope === 'project' ? (ep.projectId ?? '') : DEFAULT_AGENT_NAME;
    await writeEpisode({
      ownerId,
      scopeName: ep.scope,
      scopeId,
      // 只传裸 slug——writeEpisode 会用 frontmatter.created 自己加日期前缀；
      // 若这里再带日期会变成双重前缀，落盘 compressedPath 跟 goldenOf 对不上，召回全 miss。
      slug: ep.slug,
      frontmatter: {
        scope: ep.scope === 'project' ? `project:${scopeId}` : 'agent',
        tags: ep.tags,
        status: 'active',
        created: ep.date,
        source: 'twin-auto',
        title: ep.title,
        description: ep.description,
        type: ep.type,
        updated: ep.date,
      },
      body: ep.body,
    });
  }
}

// ─── 注入档：纯函数判定 golden 是否在快照里可见 ───────────────────

/**
 * snapshot 文本里出现 golden 的 compressedPath 即可见。索引行格式是 `- <compressedPath>: ...`，
 * 锚定后缀 `:` 匹配——避免 `oru/x-backend` 误命中 `oru/x-backend-multi` 这类前缀关系的假阳性。
 */
export function injectedVisibleFor(snapshot: string, golden: string[]): string[] {
  return golden.filter((g) => snapshot.includes(`${g}:`));
}

// ─── 工具档：驱动被测模型调真实工具 ────────────────────────────

const TOOL_NAMES = ['grep_memory', 'read_memory', 'query_episodes'] as const;

const TOOL_SYSTEM_PROMPT = `你是一个记忆检索助手。用户会问一个问题，你的任务是用提供的工具（grep_memory / query_episodes / read_memory）在记忆库里找出与问题相关的记忆条目。
- 先用 grep_memory 按你从问题里提炼的关键词搜，或用 query_episodes 按类别/标签筛。
- 命中后可用 read_memory 读全文确认。
- 你看不到任何预先注入的记忆索引，必须靠工具去找。
- 尽量找全；找到后简要说明你认为相关的条目路径即可。`;

function toOAITools(tools: { name: string; description: string; inputSchema: object }[]): OAITool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

/** 给 golden 算出"完整 relPath"形态，用于在工具结果文本里做兜底子串匹配（grep 返回 full relPath） */
function relPathForGolden(ep: EpisodeFixture): string {
  const base = `episodes/${ep.date}-${ep.slug}.md`;
  return ep.scope === 'project'
    ? `projects/${ep.projectId}/${base}`
    : `agents/twin/${base}`;
}

export async function runRetrieval(corpus: Corpus, opts: BackendOpts): Promise<RetrievalResult[]> {
  const { ownerId, baseURL, apiKey, model } = opts;
  const maxRounds = opts.maxToolRounds ?? 6;

  // 真实工具（只暴露读侧三件套，不给写工具）
  const { createMemoryTools } = await import('../../../electron/main/memory/tools');
  const allTools = createMemoryTools();
  const tools = allTools.filter((t) => (TOOL_NAMES as readonly string[]).includes(t.name));
  const oaiTools = toOAITools(tools);
  const ctx = makeRetrievalCtx(ownerId);

  // 注入档：一次性建快照（与 currentProjectId 无关——readIndexSection 收全部 active）
  const { buildSnapshot } = await import('../../../electron/main/memory/snapshot');
  const snapshot = await buildSnapshot(ownerId, null);

  // golden → relPath 速查（兜底匹配 grep 的 full-relPath 输出）
  const relByGolden = new Map<string, string>();
  for (const ep of corpus.episodes) relByGolden.set(goldenOf(ep), relPathForGolden(ep));

  const results: RetrievalResult[] = [];
  for (const query of corpus.queries) {
    const injectedVisible = injectedVisibleFor(snapshot, query.golden);

    // 工具档：隐藏注入，强制走工具
    const toolOutput = await runToolLoop({
      baseURL, apiKey, model, maxRounds, tools, oaiTools, ctx, question: query.q,
    });
    const toolRecalled = query.golden.filter((g) => {
      const rel = relByGolden.get(g);
      return toolOutput.includes(g) || (rel ? toolOutput.includes(rel) : false);
    });

    results.push({
      q: query.q,
      mode: query.mode,
      golden: query.golden,
      injectedVisible,
      toolRecalled,
    });
  }
  return results;
}

/** 跑一轮 query 的工具对话循环，返回所有工具结果文本的拼接（用于 golden 兜底匹配） */
async function runToolLoop(args: {
  baseURL: string;
  apiKey: string;
  model: string;
  maxRounds: number;
  tools: { name: string; execute: (input: unknown, ctx: ToolContext) => Promise<{ text?: string }> }[];
  oaiTools: OAITool[];
  ctx: ToolContext;
  question: string;
}): Promise<string> {
  const { baseURL, apiKey, model, maxRounds, tools, oaiTools, ctx, question } = args;
  const messages: OAIMessage[] = [
    { role: 'system', content: TOOL_SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  const collectedToolText: string[] = [];

  for (let round = 0; round < maxRounds; round += 1) {
    const resp = await callOpenAICompat({ baseURL, apiKey, model, messages, tools: oaiTools, temperature: 0 });
    const msg = resp.choices[0]?.message;
    if (!msg) break;
    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) break; // 模型给最终答案，停

    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const tool = tools.find((t) => t.name === tc.function.name);
      let resultText = '';
      if (tool) {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
        try {
          const r = await tool.execute(input, ctx);
          resultText = r.text ?? '';
        } catch (e) {
          resultText = `工具执行出错：${e instanceof Error ? e.message : String(e)}`;
        }
      } else {
        resultText = `未知工具：${tc.function.name}`;
      }
      collectedToolText.push(resultText);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
    }
  }
  return collectedToolText.join('\n');
}

/** 构造最小 ToolContext——grep/read/query 只读 ctx.ownerId，其余字段塞占位值 */
function makeRetrievalCtx(ownerId: string): ToolContext {
  return {
    conversationId: 'retrieval-eval',
    agentId: 'twin',
    ownerId,
    approvalMode: 'work',
    usage: 'twinChat',
    abortSignal: new AbortController().signal,
  } satisfies ToolContext;
}
