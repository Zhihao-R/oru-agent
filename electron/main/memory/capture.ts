/**
 * Capture subagent 执行入口
 *
 * 触发：captureScheduler 满 N 轮即时调 runCapture(ownerId, convId, sinceMs)。
 *
 * 流程：
 *   1. 读取游标（sinceMs）之后新增的对话——增量抽取，不重读全量
 *   2. 读取一周内更新过的相关 episode 索引
 *   3. 调 LLM backend 得到 operations JSON
 *   4. 走 applyOps 写入（origin=capture 白名单）
 *
 * 失败不抛——best-effort，错了下次再来。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getBackendFor } from '../agent/backends';
import { instrumentOneShot } from '../debug/instrument';
import { newMessageId } from '@shared/ids';
import { readHistory } from '../conversations/store';
import { listAgents } from '../agent/store/agents';
import { convDir } from '../runtime/paths';
import { applyOps } from './applyOps';
import { CAPTURE_OUTPUT_SCHEMA, CAPTURE_SYSTEM_PROMPT, buildCapturePrompt, type CaptureOutput } from './capturePrompt';
import { compressPath } from './compressedPath';
import { memoryRoot, isSkippedMemoryDir } from './paths';
import { queryEpisodes } from './queryEpisodes';
import { readMarkdownFile } from '../fs/frontmatter';
import { onEpisodeWritten } from './dreamScheduler';

export type CaptureOutcome =
  // coveredUntil：本次实际看过的最后一条消息 createdAt，供调用方推进游标；
  // null = 没看到新消息或失败，游标不前进（下次重抽，保证不丢）
  | { kind: 'ok'; opsApplied: number; opsFailed: number; coveredUntil: number | null }
  | { kind: 'skipped'; reason: string; coveredUntil: number | null }
  | { kind: 'failed'; error: string; coveredUntil: null };

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// prompt 装配预算：按消息粒度累计，超出即停——游标只覆盖实际进入 prompt 的消息
const PROMPT_BUDGET_CHARS = 20000;
/**
 * 「本对话已记下的 episode」正文总量上界（约占 PROMPT_BUDGET_CHARS 两成）。
 * 必须有上界：sources 集合随对话单调增长，实测正文中位 419 字符 / p90 675，30 条就吃满全部预算，
 * 而对话默认 168 小时才自动归档。超出部分降级成索引行，不整条消失。
 */
const SAME_CONV_BODY_BUDGET_CHARS = 4000;

export async function runCapture(
  ownerId: string,
  convId: string,
  sinceMs = 0,
  /** 这段对话所属项目（null=通用记忆）。由调用方在触发瞬间定住，本函数不读全局活跃项目——
   *  中间多个 await 期间用户可能已切走，届时再读会把记忆挂到别的项目下 */
  projectId: string | null = null,
): Promise<CaptureOutcome> {
  try {
    // 1. 找到 convId 对应的 agent（线性扫，单用户场景 OK）
    const agent = await findAgentForConversation(ownerId, convId);
    if (!agent) {
      console.log(`[oru.capture] (${convId}) skipped: conversation-not-found`);
      return { kind: 'skipped', reason: 'conversation-not-found', coveredUntil: null };
    }
    const agentId = agent.id;

    // 2. 读对话历史，只取游标之后新增的部分——增量抽取，长对话不重读全量。
    //    游标用绝对 createdAt：capture 在途时对话仍在涨，按时间点切才不会漏中间轮次。
    const messages = await readHistory(agentId, convId).catch(() => []);
    // 排序后按前缀截断才有意义——不依赖历史本身按时间单调
    const fresh = messages
      .filter((m) => m.createdAt > sinceMs)
      .sort((a, b) => a.createdAt - b.createdAt);
    // 按消息粒度装配 prompt、预算封顶（至少含一条）；游标只覆盖**实际进入 prompt** 的消息——
    // 否则增量超长时模型没见过的尾部被标记为已覆盖，失败累积重抽的恢复路径上会重演永久丢失。
    // 超预算的尾部留给下次触发接着抽。
    const lines: string[] = [];
    let used = 0;
    let coveredUntil: number | null = null;
    for (const m of fresh) {
      const body = m.role === 'user' || m.role === 'assistant' ? (m.text ?? '').trim() : '';
      let line = body.length > 0 ? `[${m.role}] ${body}` : null;
      if (line && lines.length > 0 && used + line.length > PROMPT_BUDGET_CHARS) {
        // 同 createdAt 的消息必须同进同出：游标精度是毫秒，在同毫秒组中间截断会让
        // 被截走的那条永远落在下次 `> sinceMs` 之外——宁可软超预算也不能丢
        if (coveredUntil === null || m.createdAt > coveredUntil) break;
      }
      if (line) {
        // 首条就超预算的巨型消息（如粘贴的大 HTML）取前缀，保住预算硬顶；
        // 游标照常覆盖该条——模型看过前缀，按已抽取处理，不为一条消息反复重试
        if (lines.length === 0 && line.length > PROMPT_BUDGET_CHARS) {
          line = line.slice(0, PROMPT_BUDGET_CHARS);
        }
        lines.push(line);
        used += line.length + 2; // +2 ≈ '\n\n' 连接符
      }
      coveredUntil = m.createdAt;
    }
    const text = lines.join('\n\n');
    if (text.length === 0) {
      console.log(`[oru.capture] (${convId}) skipped: no-conversation-text`);
      return { kind: 'skipped', reason: 'no-conversation-text', coveredUntil };
    }

    // 3. 读最近一周更新过的 episode 索引，外加本对话已产出的 episode 全文——
    //    「跳过」的判据是"已有 episode 覆盖同一件事"，判覆盖关系只看索引行看不出来
    //    （"学历为硕士，非仅本科" 与 "学历为代尔夫特理工硕士加重庆大学本科" 从标题看像两件事）。
    //    冗余最高发的场景就是同一个对话被抽十几次，所以正文只给这个对话的那批。
    const recentIndex = await buildRecentEpisodeIndex(ownerId);
    const sameConvEpisodes = await buildSameConversationEpisodes(ownerId, convId);

    // 4. 调 LLM
    const backend = await getBackendFor('memoryDream'); // 复用 dream backend 的能力
    // 项目由调用方给：模型没有别的合法 projectId 来源，不给就只能编，编出来的会被 applyOps 拒收
    const prompt = buildCapturePrompt({
      conversationText: text,
      recentEpisodesIndex: recentIndex,
      sameConversationEpisodes: sameConvEpisodes,
      convId,
      currentProjectId: projectId,
    });
    const raw = await instrumentOneShot(
      backend,
      {
        roundId: newMessageId(),
        conversationId: `capture_${convId}`,
        ownerId,
        agentId,
        agentName: agent.name,
        source: 'capture',
        userText: prompt,
      },
      () =>
        backend.runOneShot({
          prompt,
          systemContext: CAPTURE_SYSTEM_PROMPT,
          outputSchema: CAPTURE_OUTPUT_SCHEMA,
        }),
      CAPTURE_SYSTEM_PROMPT,
    );

    const parsed = parseCaptureOutput(raw);
    if (!parsed) {
      // 空正文 / 坏 JSON 是故障不是"无可记"——游标不动，下次满 3 轮重抽同一段。
      // 此路径直接 return 不经 catch，必须自带日志，否则空输出故障复发时 console 全静默。
      console.warn(`[oru.capture] (${convId}) failed: unparseable-output`);
      return { kind: 'failed', error: 'unparseable-output', coveredUntil: null };
    }
    if (parsed.operations.length === 0) {
      // 模型的显式决策（不是故障）——游标照常推进
      console.log(
        `[oru.capture] (${convId}) skipped: no-operations${parsed.reason ? ` — ${parsed.reason}` : ''}`,
      );
      return { kind: 'skipped', reason: 'no-operations', coveredUntil };
    }

    // 5. 应用 ops——origin=capture，白名单只允许 create-episode（通道二只追加，S35·G67）。
    // 后台抽取无当场语境也无全局视角，无权纠正/取代旧事件：即便模型仍吐 supersede/correct，
    // 一律落成追加（不丢内容），归并/纠错交给对话侧或 dream。sources 兜底注入当前 convId：
    // 模型漏填则该条永不可被 dream 按原文纠错——纠错覆盖率的地基。
    //
    // 落盘必需字段兜底校验（2026-08-03 修复配套）：applyCreateEpisode 用 slug 拼文件名、
    // content 写正文、title 进索引——缺了会写坏文件（`<date>-undefined.md`）或索引挂空 title，
    // 比"该条失败"更糟（静默污染）。模型若吐空壳（缺字段），判为故障而不是"无可记"：
    // 返回 failed + 游标不动，schema/模型修好后同段对话重抽即自愈。project scope 另需 projectId，
    // 缺了 applyCreateEpisode 会 throw（算进 errCount），但那已是"记了却没落成"，这里一并拦下。
    const malformed = parsed.operations.filter(
      (o) =>
        !o.payload.title ||
        !o.payload.slug ||
        !o.payload.description ||
        !o.payload.content ||
        (o.payload.scope === 'project' && !o.payload.projectId),
    );
    if (malformed.length > 0) {
      console.warn(
        `[oru.capture] (${convId}) failed: ${malformed.length}/${parsed.operations.length} op 缺落盘必需字段`,
      );
      return { kind: 'failed', error: 'malformed-operations', coveredUntil: null };
    }
    const ops = parsed.operations.map((o) => {
      const payload =
        o.payload.sources && o.payload.sources.length > 0
          ? o.payload
          : { ...o.payload, sources: [convId] };
      return { op: 'create-episode' as const, payload };
    });
    const result = await applyOps(ownerId, ops, 'capture');
    // 通知 dreamScheduler 累计 episode 计数——否则纯 capture 用户 newEpisodeCount 恒 0，
    // 每日 dream 与 20 条阈值都永不触发，记忆整理几乎不运行
    for (let i = 0; i < result.okCount; i += 1) onEpisodeWritten();
    console.log(
      `[oru.capture] (${convId}) ok=${result.okCount} err=${result.errCount}${parsed.reason ? ` — ${parsed.reason}` : ''}`,
    );
    return { kind: 'ok', opsApplied: result.okCount, opsFailed: result.errCount, coveredUntil };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[oru.capture] (${convId}) failed:`, error);
    return { kind: 'failed', error, coveredUntil: null };
  }
}

/** 解析 capture 输出 JSON——容忍 markdown 围栏 */
export function parseCaptureOutput(raw: string): CaptureOutput | null {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const jsonText = fence ? fence[1] : trimmed;
  try {
    const parsed = JSON.parse(jsonText) as CaptureOutput;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!Array.isArray(parsed.operations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── helpers ───────────────────────────────────────────

async function findAgentForConversation(
  ownerId: string,
  convId: string,
): Promise<{ id: string; name: string } | null> {
  const { agents } = await listAgents();
  for (const a of agents) {
    if (a.ownerId !== ownerId) continue;
    const filePath = join(convDir(ownerId), a.id, `${convId}.jsonl`);
    try {
      await fs.access(filePath);
      return { id: a.id, name: a.name };
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * 本对话（sources 含 convId）已产出的 episode——带正文，供判"是否已覆盖同一件事"。
 * 按最近更新倒序给，正文总量到 SAME_CONV_BODY_BUDGET_CHARS 为止；之后的降级成索引行
 * （最近产生的那批一定有正文，早期条目至少还在索引里可见）。
 */
export async function buildSameConversationEpisodes(
  ownerId: string,
  convId: string,
): Promise<string> {
  const hits = await queryEpisodes(ownerId, { sources: [convId] });
  const blocks: string[] = [];
  let used = 0;
  for (const h of hits) {
    const head = `- ${h.compressedPath}: ${h.title} - ${h.description}`;
    if (h.body.length === 0 || used + h.body.length > SAME_CONV_BODY_BUDGET_CHARS) {
      blocks.push(head);
      continue;
    }
    used += h.body.length;
    blocks.push(`${head}\n${h.body.split('\n').map((l) => `  ${l}`).join('\n')}`);
  }
  return blocks.join('\n');
}

async function buildRecentEpisodeIndex(ownerId: string): Promise<string> {
  const cutoff = Date.now() - ONE_WEEK_MS;
  const lines: string[] = [];
  const root = memoryRoot(ownerId);

  async function visitDir(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'archived') continue;
        if (isSkippedMemoryDir(e.name)) continue;
        await visitDir(abs);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || stat.mtimeMs < cutoff) continue;
        const f = await readMarkdownFile(abs).catch(() => null);
        if (!f) continue;
        const data = f.data as Record<string, unknown>;
        if (data.status && data.status !== 'active') continue;
        const rel = abs.slice(root.length + 1).split(/[\\/]/).join('/');
        let compressed: string;
        try {
          compressed = compressPath(rel);
        } catch {
          continue;
        }
        const title = (data.title as string) ?? '';
        const desc = (data.description as string) ?? '';
        // tags 同行给出，格式对齐 store.ts 的索引行——模型据此复用已有 tag 而非造新词
        const tags = (data.tags as string[] | undefined) ?? [];
        const tagsPart = tags.length > 0 ? ` — tags:[${tags.join(',')}]` : '';
        lines.push(`- ${compressed}: ${title} - ${desc}${tagsPart}`);
        if (lines.length >= 100) return;
      }
    }
  }

  await visitDir(join(root, 'agents'));
  await visitDir(join(root, 'projects'));
  return lines.join('\n');
}
