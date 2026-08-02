/**
 * episode 结构化整理工具
 *
 * 两组受众（S35·G102）：
 *   - dream 专属（需全局视角，仅夜间整理可见）：
 *       read_conversation：按 convId 反查 episode 来源对话原文（读）
 *       merge_episodes：把讲同一件事的 episode 合并、旧的标 superseded（写）
 *   - 对话 + dream 共享（用户当场纠正须即时生效，2026-07-09 PM 拍板）：
 *       correct_episode：纠正与来源原文不符的 episode，evidence 必填（写）
 *       retire_episode：按守则两类判据出清 episode，状态标 retired（写）
 *     origin 按 ctx.usage 推导（memoryDream→'dream'，其余对话侧→'record'）：dream 的纠错产物
 *     打 corrected-at 标记（守则要求再纠之前先查 changelog），对话侧不打。
 *
 * 这些 episode 结构化工具走 applyOps(ownerId, ops, origin)。
 * 档案升格（用户 / self / 项目）改用主对话同款 read / grep / query / write_memory / edit_memory
 *（复用 tools.ts，在 agentTools/index.ts 注册到 memoryDream usage）——一个文档模型、一套工具，
 * 沙箱(ensureWithinRoot)取代旧 upgrade_memory 的 op 白名单隔离。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool, ToolResult, ToolContext } from '@shared/agent/backend';
import type { MemoryOp, MemoryOpOrigin, OpResult } from '@shared/memory/operations';
import type { EpisodeType } from '@shared/types';
import { applyOps } from './applyOps';
import { readHistoryForOwner } from '../conversations/store';
import { convDir } from '../runtime/paths';

// ─── read_conversation ─────────────────────────────────────

const readConversationSchema = {
  type: 'object',
  properties: {
    convId: {
      type: 'string',
      description: '对话 id（取自 episode frontmatter 的 sources）',
    },
    sinceMs: {
      type: 'number',
      description: '只取 createdAt ≥ 此毫秒时间戳的消息（可选）',
    },
    limit: {
      type: 'number',
      description: '最多返回多少条，取最近的（可选，默认不限）',
    },
  },
  required: ['convId'],
} as const;

function makeReadConversationTool(): AgentTool {
  return {
    name: 'read_conversation',
    mutatesEnvironment: false,
    description:
      '按 convId 读回该对话的 user / assistant 文本，供复盘时反查 episode 的来源原文、确认是否同一件事。',
    inputSchema: readConversationSchema as object,
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as { convId: string; sinceMs?: number; limit?: number };
      const base = convDir(ctx.ownerId);

      let agentDirs: import('node:fs').Dirent[];
      try {
        agentDirs = await fs.readdir(base, { withFileTypes: true });
      } catch {
        return { text: `未找到对话 ${args.convId}` };
      }

      for (const ad of agentDirs) {
        if (!ad.isDirectory()) continue;
        const file = join(base, ad.name, `${args.convId}.jsonl`);
        try {
          await fs.access(file);
        } catch {
          continue; // 这个 agent 名下没有该对话
        }
        const msgs = await readHistoryForOwner(ctx.ownerId, ad.name, args.convId);
        let texts = msgs
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .filter((m) => args.sinceMs == null || m.createdAt >= args.sinceMs)
          .map((m) => ({ role: m.role, text: (m.text ?? '').trim() }))
          .filter((m) => m.text.length > 0)
          .map((m) => `[${m.role}] ${m.text}`);
        if (args.limit != null && args.limit > 0 && texts.length > args.limit) {
          texts = texts.slice(-args.limit);
        }
        if (texts.length === 0) {
          return { text: `对话 ${args.convId} 无可读的 user / assistant 文本` };
        }
        return { text: `对话 ${args.convId}（${texts.length} 条）：\n${texts.join('\n')}` };
      }

      return { text: `未找到对话 ${args.convId}` };
    },
  };
}

/**
 * 按调用方用途推导写入 origin（S35·G102）：夜间整理走 'dream'（纠错产物打 corrected-at），
 * 其余（对话主/后台/子 agent）走 'record'——非法分类当场抛错让模型重填（对话内能免费重试）。
 */
function originForUsage(ctx: ToolContext): MemoryOpOrigin {
  return ctx.usage === 'memoryDream' ? 'dream' : 'record';
}

/** 第一条失败 op 的错误信息；全成功返回 null。把 OpResult 判别联合 narrow 收在这里。 */
function firstOpError(results: OpResult[]): string | null {
  for (const r of results) {
    if (!r.ok) return r.error;
  }
  return null;
}

// ─── merge_episodes ────────────────────────────────────────

const mergeEpisodesSchema = {
  type: 'object',
  properties: {
    mergeInto: {
      type: 'string',
      description: '保留的目标 episode 压缩路径（query_episodes 输出那种，如 twin/2026-06-02-x）',
    },
    mergeFrom: {
      type: 'array',
      items: { type: 'string' },
      description: '被并入、将标 superseded 的 episode 压缩路径列表',
    },
    newDescription: {
      type: 'string',
      description: '可选：合并后给 mergeInto 的新描述（≤30 字）',
    },
    newBody: {
      type: 'string',
      description:
        '可选但强烈建议：合并后 mergeInto 的综合正文。mergeFrom 各条一旦并入即移出召回，' +
        '它们的内容只剩 mergeInto 这一份——若几条是"同主题、内容互补"（非字面重复），' +
        '必须在这里把各条要点捏成一段完整正文写回，否则会丢信息。字面重复的去重才可不传。',
    },
  },
  required: ['mergeInto', 'mergeFrom'],
} as const;

function makeMergeEpisodesTool(): AgentTool {
  return {
    name: 'merge_episodes',
    mutatesEnvironment: false,
    description:
      '把同主题的多条 episode 合并成一条：mergeFrom 各条标 superseded 链向 mergeInto（可回溯，不真删）。' +
      '几条内容互补（各讲一个侧面）时用 newBody 把它们捏成一份综合正文写进 mergeInto——' +
      '这样"合并互补内容"才不丢信息，不必因为"怕丢正文"而放着不合并。' +
      '拿不准是否该并一起就不要合并——先用 read_conversation 反查来源对话确认。',
    inputSchema: mergeEpisodesSchema as object,
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as {
        mergeInto: string;
        mergeFrom: string[];
        newDescription?: string;
        newBody?: string;
      };
      if (!args.mergeInto || !args.mergeFrom?.length) {
        return { isError: true, text: 'merge_episodes 需要 mergeInto 和非空 mergeFrom' };
      }
      const result = await applyOps(
        ctx.ownerId,
        [
          {
            op: 'merge-episodes',
            mergeInto: args.mergeInto,
            mergeFrom: args.mergeFrom,
            newDescription: args.newDescription,
            newBody: args.newBody,
          },
        ],
        originForUsage(ctx),
      );
      const err = firstOpError(result.results);
      if (err) return { isError: true, text: `合并失败：${err}` };
      return { text: `✓ 合并 ${args.mergeFrom.length} 条 → ${args.mergeInto}` };
    },
  };
}


// ─── correct_episode / retire_episode（dream 纠错与淘汰）────────

const correctEpisodeSchema = {
  type: 'object',
  properties: {
    oldPath: { type: 'string', description: '要纠正的 episode 压缩路径（如 twin/2026-06-10-foo）' },
    evidence: {
      type: 'string',
      description: '必填：引用来源对话**原文**作为佐证（先 read_conversation 取证），不是转述',
    },
    scope: { type: 'string', enum: ['agent', 'project'] },
    projectId: { type: 'string', description: 'scope=project 时必填' },
    type: { type: 'string', description: 'episode 类别（user/feedback/project/reference/agent）' },
    title: { type: 'string', description: '改正后的标题（≤30 字）' },
    slug: { type: 'string', description: '拉丁字符小写连字符' },
    description: { type: 'string', description: '改正后的一句话描述（≤30 字）' },
    tags: { type: 'array', items: { type: 'string' } },
    content: { type: 'string', description: '改正后的正文' },
    sources: { type: 'array', items: { type: 'string' }, description: '来源对话 convId' },
  },
  required: ['oldPath', 'evidence', 'scope', 'type', 'title', 'slug', 'description', 'content'],
} as const;

type CorrectEpisodeArgs = {
  oldPath?: string;
  evidence?: string;
  scope?: 'agent' | 'project';
  projectId?: string;
  type?: string;
  title?: string;
  slug?: string;
  description?: string;
  tags?: string[];
  content?: string;
  sources?: string[];
};

function makeCorrectEpisodeTool(): AgentTool {
  return {
    name: 'correct_episode',
    mutatesEnvironment: false,
    description:
      '纠正记错了的 episode（旧内容与事实/来源不符）。**必须附 evidence 引用依据——无据不纠**：' +
      '对话中当场纠正就引用用户原话，复盘纠正先用 read_conversation 回读来源原文再引用。' +
      '改前版本进 30 天回收站（可找回）。已带 corrected-at 标记的条目再纠之前，先 grep changelog 查上次依据。',
    inputSchema: correctEpisodeSchema as object,
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const a = input as CorrectEpisodeArgs;
      if (!a.oldPath || !a.evidence?.trim()) {
        return { isError: true, text: 'correct_episode 需要 oldPath 和 evidence（引用依据，无据不纠）' };
      }
      if (!a.scope || !a.type || !a.title || !a.slug || !a.description || !a.content) {
        return {
          isError: true,
          text: 'correct_episode 需要完整的新内容：scope/type/title/slug/description/content',
        };
      }
      const result = await applyOps(
        ctx.ownerId,
        [
          {
            op: 'correct-episode',
            oldPath: a.oldPath,
            evidence: a.evidence.trim(),
            payload: {
              scope: a.scope,
              projectId: a.projectId,
              // 分类合法性由 applyOps 的 resolveEpisodeType 归一/兜底，这里只透传
              type: a.type as EpisodeType,
              title: a.title,
              slug: a.slug,
              description: a.description,
              tags: a.tags,
              content: a.content,
              sources: a.sources,
            },
          },
        ],
        originForUsage(ctx),
      );
      const err = firstOpError(result.results);
      if (err) return { isError: true, text: `纠错失败：${err}` };
      return { text: `✓ 已校对 ${a.oldPath}` };
    },
  };
}

const retireEpisodeSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要淘汰的 episode 压缩路径' },
    reason: {
      type: 'string',
      description: '必填：按哪条判据淘汰——三类合法：违反现行"不保存清单"；进行中状态已有证据表明结束/过期；或信号已升格进画像、且该 episode 除此之外无独立回忆价值',
    },
  },
  required: ['path', 'reason'],
} as const;

function makeRetireEpisodeTool(): AgentTool {
  return {
    name: 'retire_episode',
    mutatesEnvironment: false,
    description:
      '把不该留在活跃记忆里的 episode 移出召回（状态标记，可逆，不物理删除）。' +
      '仅限三类判据：违反现行"不保存清单"的存量条目；进行中状态已有证据表明结束或过期；' +
      '信号已升格进画像、且该 episode 除此之外无独立回忆价值。' +
      '"我觉得没用"不是理由——不做冗余/质量判断。',
    inputSchema: retireEpisodeSchema as object,
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const a = input as { path?: string; reason?: string };
      if (!a.path || !a.reason?.trim()) {
        return { isError: true, text: 'retire_episode 需要 path 和 reason（淘汰判据）' };
      }
      const result = await applyOps(
        ctx.ownerId,
        [{ op: 'retire-episode', path: a.path, reason: a.reason.trim() }],
        originForUsage(ctx),
      );
      const err = firstOpError(result.results);
      if (err) return { isError: true, text: `淘汰失败：${err}` };
      return { text: `✓ 已收起 ${a.path}` };
    },
  };
}

// ─── 出口 ──────────────────────────────────────────────────

export function createDreamReadTools(): AgentTool[] {
  return [makeReadConversationTool()];
}

export function createDreamWriteTools(): AgentTool[] {
  // dream 专属写工具：只有 merge（归并需通读后的全局视角，仅夜间整理有）。
  // correct/retire 已拆到 createEpisodeCorrectionTools（对话 + dream 共享，S35·G102）。
  // 档案升格改用主对话同款 write_memory / edit_memory，不在此。
  return [makeMergeEpisodesTool()];
}

/**
 * 事件纠正/退休工具（对话 + dream 共享，S35·G102）。
 * 在 agentTools/index.ts 注册到 [twinMain, memoryDream]：对话侧用户当场纠正即时生效，
 * dream 侧复盘纠错同一套工具；origin 由各工具按 ctx.usage 推导。
 */
export function createEpisodeCorrectionTools(): AgentTool[] {
  return [makeCorrectEpisodeTool(), makeRetireEpisodeTool()];
}

// 测试导出
export {
  makeReadConversationTool as __makeReadConversationTool,
  makeMergeEpisodesTool as __makeMergeEpisodesTool,
  makeCorrectEpisodeTool as __makeCorrectEpisodeTool,
  makeRetireEpisodeTool as __makeRetireEpisodeTool,
};
