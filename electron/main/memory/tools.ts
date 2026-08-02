/**
 * 记忆系统暴露给 LLM 的工具
 *
 * - record_memory：写新记忆（user-basic / user-trait / self / episode）—— 全部走 applyOps op 路径
 * - edit_memory：改/删/覆盖已有记忆（基本情况 update/remove、特质叙述 replace、self/特质叙述整段 write）
 * - grep_memory：跨文件子串搜索
 * - read_memory：读单文件全文
 * - query_episodes：按 type/tag/projectId 结构化筛 episode
 *
 * 所有工具的 inputSchema 用纯 JSON Schema 描述，不依赖任何 SDK 的 schema 库。
 * ClaudeCodeBackend 内部把 inputSchema 转 zod 再喂给 MCP；其它 backend 同理。
 *
 * tools.ts 不导入任何 LLM SDK 包——这是架构原则的硬要求。
 */
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentTool, ToolContext, ToolResult } from '@shared/agent/backend';
import type { MemoryRecordPayload } from '@shared/types';
import type { EpisodeCreatePayload, MemoryOp, OpResult } from '@shared/memory/operations';
import { ensureWithinRoot, parseFrontmatter } from '../fs/frontmatter';
import { recordAccess } from './accessLog';
import { applyOps } from './applyOps';
import { classifyPathInput, resolveToFullRelPath, suggestSimilar } from './compressedPath';
import { editMemoryDocument, writeMemoryDocument, type EditResult } from './documentIo';
import { onEpisodeWritten } from './dreamScheduler';
import { EPISODE_FIELD_POLICY } from './episodeFieldPolicy';
import { memoryRoot, isSkippedMemoryDir, isProfileDocRelPath } from './paths';
import { queryEpisodes } from './queryEpisodes';

// ─── record_memory ────────────────────────────────────────

const recordMemorySchema = {
  type: 'object',
  properties: {
    content: {
      type: 'string',
      description: `${EPISODE_FIELD_POLICY.content}（一段，≤200 字）`,
    },
    scope: {
      type: 'string',
      enum: ['agent', 'project'],
      description: 'agent = Oru 跟用户的事件；project = 项目内事件（需配 projectId）',
    },
    title: {
      type: 'string',
      // 通道一特有：标题在这里还兼任索引行的链接文字
      description: `${EPISODE_FIELD_POLICY.title}——会成为索引行的链接文字`,
    },
    slug: {
      type: 'string',
      description: '文件名 slug（拉丁字符小写、连字符），如 "claude-code-fengha"',
    },
    description: {
      type: 'string',
      description: EPISODE_FIELD_POLICY.description,
    },
    episodeCategory: {
      type: 'string',
      enum: ['user', 'feedback', 'project', 'reference', 'agent'],
      description:
        '给这条事件归档分类，五选一：' +
        'user=用户的事件 / feedback=用户对 Oru 的反馈 / project=项目内事件（配 projectId）/ ' +
        'reference=外部资源参考 / agent=Oru 自己的状态变化',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: EPISODE_FIELD_POLICY.tags,
    },
    projectId: {
      type: 'string',
      // 通道一特有的语境：id 就在自己的 system prompt 里，不必像 capture 那样另行注入
      description:
        `scope=project 时必填。${EPISODE_FIELD_POLICY.projectId}——` +
        '真实 id 就是你 system prompt 里"当前项目 …"那段标题中的那个。',
    },
    userRequested: {
      type: 'boolean',
      description: EPISODE_FIELD_POLICY.userRequested,
    },
    // ─── 冲突处理 ───
    conflictsWith: {
      type: 'string',
      description: '要替换 / 修正的旧事件，填旧路径（compressedPath 或完整 relPath）。不填就只追加，旧的留着。',
    },
    conflictType: {
      type: 'string',
      enum: ['correction', 'evolution'],
      description:
        'correction = 同一对话内用户当场说"记错了 / 应该是 X"（旧事件真删）；' +
        'evolution = 隔几天到几月用户说"现在变了 / 以前 X 现在 Y"（旧事件保留为时间线）。' +
        '不确定填 evolution——它不会真删。',
    },
    evidence: {
      type: 'string',
      description:
        'conflictType=correction 时**必填**：引用「旧的错在哪、依据是什么」的依据（通常是用户当场的原话）——' +
        '无据不纠，旧事件会被移进回收站，纠正必须留下可查的依据。evolution 不需要（旧的当时没错）。',
    },
  },
  // userRequested 必填——可选参数会被模型系统性忽略（capture 的 sources 漏填是现成教训），
  // 必填强迫每次表态，"用户亲口嘱记过"这个痕迹才不会静默丢失（事后无从补记）
  required: ['content', 'userRequested'],
} as const;

type RecordArgs = {
  content: string;
  scope?: 'agent' | 'project';
  title?: string;
  slug?: string;
  description?: string;
  episodeCategory?: 'user' | 'feedback' | 'project' | 'reference' | 'agent';
  tags?: string[];
  projectId?: string;
  userRequested?: boolean;
  conflictsWith?: string;
  conflictType?: 'correction' | 'evolution';
  evidence?: string;
};

function makeRecordMemoryTool(): AgentTool {
  return {
    name: 'record_memory',
    mutatesEnvironment: true,
    // v0.4：record_memory 回执必走 historyAdapter 的白名单去重路径（detail 第一行）。
    // 标 'never' 强制跳过落盘——避免长回执先落盘走 persistedRef 优先级 1，绕过白名单去重。
    persistPolicy: 'never',
    description: `记一次具体**事件**（episode）——带索引、可结构化检索的记录。用户画像 / 你自己（self）这类**稳定认知**不用这个，改用 write_memory / edit_memory 维护自由分章档案。

**视角**：你写下的 content 会被作为未来 Oru 实例召回时读到——读者是未来的你自己，不是用户。**写 prompt，不写日志；写结论，不写过程**。

**写到哪**：
- scope=agent → \`agents/twin/episodes/<YYYY-MM-DD>-<slug>.md\` + 索引行
- scope=project → \`projects/<projectId>/episodes/<YYYY-MM-DD>-<slug>.md\` + 索引行

**什么时候写**：一次具体的事件 / 互动 / 决定（"今天一起搞定了 X""用户说以后 Y 都按 Z 来"）。
**什么时候别写**：用户的稳定属性 / 偏好（"我家在杭州""我做事偏克制"）→ 那是常驻档案，用 write_memory / edit_memory；任务进度 / 临时 TODO / 单次状态；你自己的判断（dream 复盘的活）。

**先验**：疑问时倾向写——错记代价小（用户能撤销 / 你能改），漏记代价大。

**冲突处理**：纠正旧事件用 conflictsWith（填旧路径）+ conflictType；不带就只追加，旧的留着。

**写完之后**：聊天流自动出现"已记下 X"卡片，用户能撤销。你不用再说"我记下了"——卡片本身就是通知。`,
    inputSchema: recordMemorySchema as object,
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as RecordArgs;
      const conflictType: 'correction' | 'evolution' = args.conflictType ?? 'evolution';

      if (args.scope !== 'agent' && args.scope !== 'project') {
        return { isError: true, text: 'record_memory 必须给 scope=agent 或 scope=project' };
      }

      try {
        return await recordEpisode(args, conflictType, ctx);
      } catch (e) {
        return {
          isError: true,
          text: `记忆写入失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

// ─── record_memory：episode 建档实现 ──────────────────────

async function recordEpisode(
  args: RecordArgs,
  conflictType: 'correction' | 'evolution',
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.title) return { isError: true, text: 'episode 必须给 title' };
  if (!args.slug) return { isError: true, text: 'episode 必须给 slug' };
  if (!args.episodeCategory) {
    return {
      isError: true,
      text: 'episode 必须给 episodeCategory（user/feedback/project/reference/agent 五选一）',
    };
  }
  if (!args.description) {
    return {
      isError: true,
      text: 'episode 必须给 description（≤30 字一句话，用于 system prompt 索引行）',
    };
  }
  if (args.scope === 'project' && !args.projectId) {
    return { isError: true, text: 'scope=project 时必须给 projectId' };
  }
  // 对话侧纠正强制附依据（S35·G68）：无据不纠——旧事件会进回收站，纠正必须留可查依据。
  // 取代（evolution）不需要（旧的当时没错，只是过时）。
  if (args.conflictsWith && conflictType === 'correction' && !args.evidence?.trim()) {
    return {
      isError: true,
      text: 'conflictType=correction 需要 evidence（引用依据、通常是用户原话）——无据不纠',
    };
  }

  const payload: EpisodeCreatePayload = {
    scope: args.scope === 'project' ? 'project' : 'agent',
    projectId: args.scope === 'project' ? args.projectId : undefined,
    type: args.episodeCategory,
    title: args.title,
    slug: args.slug,
    description: args.description,
    tags: args.tags ?? [],
    content: args.content,
    sources: ctx.conversationId ? [ctx.conversationId] : [],
    // false 在 applyOps 的继承规则里视同"未表态"（不是抹掉旧条的嘱记痕迹），这里原样透传即可
    userRequested: args.userRequested,
  };

  const ops: MemoryOp[] = args.conflictsWith
    ? conflictType === 'correction'
      ? [{ op: 'correct-episode', oldPath: args.conflictsWith, evidence: args.evidence?.trim(), payload }]
      : [{ op: 'supersede-episode', oldPath: args.conflictsWith, payload }]
    : [{ op: 'create-episode', payload }];

  const result = await applyOps(ctx.ownerId, ops, 'record');
  const err = firstError(result.results);
  if (err) return { isError: true, text: `记忆写入失败：${err}` };

  // applyCreateEpisode 把新 episode 的 compressedPath 放到 detail
  const okResults = result.results.filter((r): r is Extract<OpResult, { ok: true }> => r.ok);
  const compressedNew = okResults[okResults.length - 1]?.detail ?? '';
  const supersededHint = args.conflictsWith
    ? conflictType === 'correction'
      ? `；旧事件 ${args.conflictsWith} 已删（移到回收站，30 天可找回）`
      : `；旧事件 ${args.conflictsWith} 已 supersede（保留为时间线）`
    : '';

  // 卡片 payload 用完整路径：查看（NoteDetailOverlay 精确匹配 episodes 列表）与撤销
  // （memory.undo 直接 join(memoryRoot, relPath) 落盘）两个消费方都按完整路径工作——
  // compressedNew 是给 AI 的 text/structured 用的，别漏进卡片（否则查看开空浮层、撤销假撤销）。
  const cardRelPath = (await resolveToFullRelPath(ctx.ownerId, compressedNew)) ?? compressedNew;
  await ctx.onMemoryRecord?.({
    relPath: cardRelPath,
    preview: args.title,
    scope: args.scope === 'project' ? 'project' : 'agent',
    type: 'episode',
  });

  // 通知 dreamScheduler 累计 episode 计数（20 条阈值触发提前 dream）
  onEpisodeWritten();

  return {
    text: `✓ 已记事件：${args.title} (${compressedNew})${supersededHint}`,
    structured: { relPath: compressedNew },
  };
}

function firstError(results: OpResult[]): string | null {
  for (const r of results) {
    if (!r.ok) return `${r.op}: ${r.error}`;
  }
  return null;
}

// ─── edit_memory ──────────────────────────────────────────

const editMemorySchema = {
  type: 'object',
  properties: {
    relPath: {
      type: 'string',
      description:
        '相对 ~/.oru/<userId>/memory/ 的路径，在它正文里定位一段替换。常见档案：' +
        '\n- user/profile.md （对用户的常驻认知：印象 + 自由分章）' +
        '\n- agents/twin/self.md （你自己的稳定特征）',
    },
    oldText: {
      type: 'string',
      description:
        '要被替换的旧文本，必须在正文中**恰好出现一次**——0 次或多次都会报错，让你先 read_memory 看原文、' +
        '再给一段更长、能唯一定位的上下文重试（与对话 edit_file 同源，杜绝改错段）。',
    },
    newText: {
      type: 'string',
      description: '替换成的新文本；**留空串即删除这段**（删除也要显式传 newText:""）。',
    },
  },
  required: ['relPath', 'oldText', 'newText'],
} as const;

function makeEditMemoryTool(): AgentTool {
  return {
    name: 'edit_memory',
    mutatesEnvironment: true,
    persistPolicy: 'never',
    description: `在一份档案的正文里**定位一段、替换或删除**（与对话的 edit_file 对齐）。和 write_memory 互补——write 整篇覆盖（建档 / 大改），edit 精确改一段（日常小改，安全、不动其它小节）。

**覆盖档案**：\`user/profile.md\`（对用户的常驻认知）、\`agents/twin/self.md\`（你自己）。

**怎么用**：oldText 给一段在正文中**唯一出现**的文本，替换成 newText；要删就把 newText 传空串。oldText 不唯一（0 或多次命中）会报错——先 read_memory 看原文，再给更长、能唯一定位的上下文。

**档案是自由分章文档**：没有"基本情况 / 特质叙述"两区之分——直接在正文里改对应那段文字即可；要新开小节，用 write_memory，或在 edit 里把锚点段替换成"锚点段 + 新的 ## 小节"。

写完聊天流自动出"已记下"卡片。`,
    inputSchema: editMemorySchema as object,
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as { relPath?: string; oldText?: string; newText?: string };
      if (!args.relPath || !args.oldText || args.newText === undefined) {
        return {
          isError: true,
          text: 'edit_memory 需要 relPath / oldText / newText（删除请把 newText 传空串）',
        };
      }
      let res: EditResult;
      try {
        res = await editMemoryDocument(ctx.ownerId, args.relPath, args.oldText, args.newText);
      } catch (e) {
        return { isError: true, text: `修改失败：${e instanceof Error ? e.message : String(e)}` };
      }
      if (!res.replaced) {
        const why =
          res.reason === 'multiple'
            ? `oldText 在 ${args.relPath} 出现多次，给一段更长、能唯一定位的上下文重试`
            : `在 ${args.relPath} 没找到 oldText（要恰好出现一次才替换）——先 read_memory 看原文再试`;
        return { isError: true, text: `edit_memory：${why}` };
      }
      const meta = cardMetaForDoc(args.relPath);
      await ctx.onMemoryRecord?.({
        relPath: args.relPath,
        // 卡片要回答的是「改了什么」而不只是「现在写着什么」——撤回的判断依赖前后对照。
        // 不在这里截到几十字：卡片永久留在对话记录里，差异恰好落在截断点之后时，两行看起来
        // 一模一样（比信息不足更糟——它长得像「什么都没改」）。收视觉是渲染端的事，这里只设
        // 一个防超长段落的粗上限。删除一段时 preview 为空，卡片据此出「删掉了这段」的文案。
        preview: clampCardText(args.newText),
        replaced: clampCardText(args.oldText),
        revertHash: res.afterHash,
        scope: meta.scope,
        type: meta.type,
      });
      return { text: `✓ 已改 ${args.relPath}`, structured: { relPath: args.relPath } };
    },
  };
}

// ─── write_memory ─────────────────────────────────────────

const writeMemorySchema = {
  type: 'object',
  properties: {
    relPath: {
      type: 'string',
      description:
        '相对 ~/.oru/<userId>/memory/ 的路径，整篇覆盖它的正文。档案类常见路径：' +
        '\n- user/profile.md （对用户的常驻认知：印象 + 自由分章）' +
        '\n- agents/twin/self.md （你自己的稳定特征）',
    },
    content: {
      type: 'string',
      description:
        '整篇新正文（markdown，自由分章：开头一段印象 + 若干 ## 小节）。**不要带 frontmatter**，带了也会被剥离。' +
        '建档或大改用这个；日常小改用 edit_memory 定位一段替换，别整篇重写以免误删别的小节。',
    },
  },
  required: ['relPath', 'content'],
} as const;

/** 卡片前后对照的存储上限——防超长段落撑大对话 JSONL，不是排版截断（排版在渲染端 clamp）。 */
function clampCardText(text: string): string {
  return text.trim().slice(0, 1000);
}

/** 档案文件 → 回执卡片的 scope/type（self.md 归 agent，projects/* 归 project，其余 user 档案归 personal）。 */
function cardMetaForDoc(relPath: string): { scope: MemoryRecordPayload['scope']; type: MemoryRecordPayload['type'] } {
  if (relPath.endsWith('self.md')) return { scope: 'agent', type: 'self' };
  if (relPath.startsWith('projects/')) return { scope: 'project', type: 'user-basic' };
  return { scope: 'personal', type: 'user-basic' };
}

function makeWriteMemoryTool(): AgentTool {
  return {
    name: 'write_memory',
    mutatesEnvironment: true,
    persistPolicy: 'never',
    description: `整篇覆盖一份档案的正文（与对话的 write_file 对齐）。档案是自由分章文档——开头一段印象 + 若干 \`## 小节\`（饮食习惯 / 作息 / 思维方式…）。档案只放解释用户是谁的稳定画像；只在特定场景才调用的清单 / 排班（如出行必带物）改用 record_memory 记成 episode，不进常驻档案。有了新理解就**新开一个小节**，别硬塞进既有结构；**绝不丢掉**任何已有小节（要保留就把它一并写回 content）。日常小改优先用 edit_memory（定位一段替换），只有建档或大改才整篇 write。写完聊天流自动出"已记下"卡片。`,
    inputSchema: writeMemorySchema as object,
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as { relPath?: string; content?: string };
      if (!args.relPath || args.content === undefined) {
        return { isError: true, text: 'write_memory 需要 relPath 和 content' };
      }
      let res: Awaited<ReturnType<typeof writeMemoryDocument>>;
      try {
        // AI 调用必须显式传 by:'ai' + mark:'ai'，否则换笔判定漏判（档案历史里 AI 覆盖用户版不可见找回）
        res = await writeMemoryDocument(ctx.ownerId, args.relPath, args.content, { by: 'ai', mark: 'ai' });
      } catch (e) {
        return { isError: true, text: `写入失败：${e instanceof Error ? e.message : String(e)}` };
      }
      const meta = cardMetaForDoc(args.relPath);
      await ctx.onMemoryRecord?.({
        relPath: args.relPath,
        // 整篇覆盖给不出诚实的一句话摘要——改动可能在第五个小节里，贴正文开头等于贴一段与本次
        // 无关的文字。留空，由渲染端出「整篇更新了这份档案」（文案在渲染端才随语言切换走）。
        preview: '',
        sections: res.sections,
        revertHash: res.afterHash,
        scope: meta.scope,
        type: meta.type,
      });
      return { text: `✓ 已整篇写入 ${args.relPath}`, structured: { relPath: args.relPath } };
    },
  };
}

// ─── grep_memory ──────────────────────────────────────────

const grepMemorySchema = {
  type: 'object',
  properties: {
    query: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description:
        '一组搜索词（大小写不敏感的子串匹配，命中任一即返回）。**记忆措辞常和你的问法不同**——' +
        '把问题里的关键词连同它的近义词/上位词都放进来，如问"几点起床"就传 ["起床","清晨","作息","早起"]，' +
        '别只放原词一个。',
    },
    scope: {
      type: 'string',
      enum: ['personal', 'agent', 'project', 'all'],
      description: '限制在哪个作用域下搜（all = 全部，默认）。personal → user/ 目录',
    },
    projectId: {
      type: 'string',
      description: 'scope=project 时可选，限定项目',
    },
  },
  required: ['query'],
} as const;

function makeGrepMemoryTool(): AgentTool {
  return {
    name: 'grep_memory',
    mutatesEnvironment: false,
    description:
      '在记忆系统里搜索（大小写不敏感的子串匹配）。返回匹配文件 + 命中行。' +
      '用户提到"上次 / 那个 / 之前我们聊过 X" 时用。' +
      '记忆措辞常和问法不同——可一次传一组近义词（命中任一即返回），别只搜一个原词。',
    inputSchema: grepMemorySchema as object,
    // grep 类工具属"全文型"返回——落盘后 Twin 拿到的是预览又得 read_file 才能看到完整命中，
    // 形成 grep→persist→read 死循环。'never' 让结果在轮内直接可用。
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as {
        query: string | string[];
        scope?: 'personal' | 'agent' | 'project' | 'all';
        projectId?: string;
      };
      // 归一为去重后的词组（大小写不敏感由 matchLine 处理；这里保留原样用于回显）
      const terms = Array.from(
        new Set((Array.isArray(args.query) ? args.query : [args.query]).map((t) => String(t).trim()).filter(Boolean)),
      );
      if (terms.length === 0) return { isError: true, text: 'grep_memory 需要至少一个非空搜索词' };
      const lowered = terms.map((t) => t.toLowerCase());
      const root = memoryRoot(ctx.ownerId);
      const allowed = scopesToDirs(args.scope ?? 'all', ctx.ownerId, args.projectId);
      // 一行命中任一词即收，记下命中了哪些词（多词时回显，帮模型判断相关性）
      const matches: { file: string; line: number; text: string; hits: string[] }[] = [];

      for (const dir of allowed) {
        await walkMd(dir, async (absPath) => {
          // trash / 点目录的跳过统一收在 walkMd 的目录递归里
          let text: string;
          try {
            text = await fs.readFile(absPath, 'utf-8');
          } catch {
            return;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            const lower = lines[i].toLowerCase();
            const hits = terms.filter((_, k) => lower.includes(lowered[k]));
            if (hits.length > 0) {
              matches.push({ file: relative(root, absPath), line: i + 1, text: lines[i].trim().slice(0, 200), hits });
              if (matches.length >= 30) return;
            }
          }
        });
        if (matches.length >= 30) break;
      }

      const termsLabel = terms.map((t) => `"${t}"`).join(' / ');
      if (matches.length === 0) {
        return { text: `未找到 ${termsLabel} 的匹配` };
      }
      // 顺便记录访问时间（被搜到的文件视为引用）
      const seenFiles = new Set(matches.map((m) => m.file));
      for (const f of seenFiles) {
        await recordAccess(ctx.ownerId, join(root, f));
      }
      const multi = terms.length > 1;
      const out = matches
        .slice(0, 30)
        .map((m) => `${m.file}:${m.line}:${multi ? ` [命中 ${m.hits.join('/')}]` : ''} ${m.text}`)
        .join('\n');
      return {
        text:
          `${termsLabel} 共 ${matches.length} 个匹配${matches.length > 30 ? '（截前 30，想更准就缩小词）' : ''}：\n` + out,
      };
    },
  };
}

function scopesToDirs(
  scope: 'personal' | 'agent' | 'project' | 'all',
  ownerId: string,
  projectId?: string,
): string[] {
  const root = memoryRoot(ownerId);
  if (scope === 'all') return [root];
  if (scope === 'personal') return [join(root, 'user')];
  if (scope === 'agent') return [join(root, 'agents')];
  if (scope === 'project') {
    return [projectId ? join(root, 'projects', projectId) : join(root, 'projects')];
  }
  return [root];
}

async function walkMd(dir: string, visit: (abs: string) => Promise<void>): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const ent of entries) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      // 只遍历"活跃内容"目录：跳过回收站与点目录(迁移备份)。scope=all 时 grep 从 memoryRoot
      // 整棵递归，撞上这些会把旧版重复内容当命中返回。判定收在 paths.isSkippedMemoryDir 共用。
      if (isSkippedMemoryDir(ent.name)) continue;
      await walkMd(abs, visit);
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      await visit(abs);
    }
  }
}

// ─── read_memory ──────────────────────────────────────────

const readMemorySchema = {
  type: 'object',
  properties: {
    relPath: {
      type: 'string',
      description:
        '相对 ~/.oru/<userId>/memory/ 的路径。常见路径：' +
        '\n- user/profile.md （用户画像：基本情况 + 特质叙述）' +
        '\n- agents/twin/self.md （Oru self）' +
        '\n- projects/<projectId>/profile.md （项目基本信息 + 约定 + 进度）' +
        '\n- agents/twin/episodes/<YYYY-MM-DD>-<slug>.md （事件全文）' +
        '\n- projects/<projectId>/episodes/<YYYY-MM-DD>-<slug>.md' +
        '\nsystem prompt 注入的章节标题括号里、grep_memory / query_episodes 输出的路径都可直接传进来。',
    },
  },
  required: ['relPath'],
} as const;

function makeReadMemoryTool(): AgentTool {
  return {
    name: 'read_memory',
    mutatesEnvironment: false,
    description: '读取指定记忆文件全文。grep_memory / query_episodes 看到 hint 后用这个拿完整内容。',
    inputSchema: readMemorySchema as object,
    // read 类工具一律 never——避免 read → persist → 再 read 死循环（tech doc §2.3）
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as { relPath: string };
      const root = memoryRoot(ctx.ownerId);
      const { kind, input: trimmed } = classifyPathInput(args.relPath);
      if (trimmed.length === 0) return { isError: true, text: 'relPath 不能为空' };

      // 接受 full relPath（含 .md）或 compressed episode 路径——compressed expand 失败时用原值，
      // 让下面的 readFile 报 ENOENT 并触发 suggestSimilar 提示
      const rel = (await resolveToFullRelPath(ctx.ownerId, args.relPath)) ?? trimmed;

      let abs: string;
      try {
        abs = ensureWithinRoot(root, rel);
      } catch (e) {
        return { isError: true, text: `路径越界：${e instanceof Error ? e.message : String(e)}` };
      }
      try {
        const text = await fs.readFile(abs, 'utf-8');
        await recordAccess(ctx.ownerId, abs);
        // 档案类（profile/self）只回 body——frontmatter 是系统自管元数据，与 edit/write 操作的 body 同域；
        // episode 保持 raw（sources/convId 是承重内容，read_conversation 取证靠它）。
        return { text: isProfileDocRelPath(rel) ? parseFrontmatter(text).content : text };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          if (kind === 'compressed') {
            const suggestions = await suggestSimilar(ctx.ownerId, args.relPath, 3).catch(() => []);
            const hint = suggestions.length > 0 ? `；最接近的：${suggestions.join(', ')}` : '';
            return { isError: true, text: `文件不存在：${args.relPath}${hint}` };
          }
          return { isError: true, text: `文件不存在：${args.relPath}` };
        }
        throw e;
      }
    },
  };
}

// ─── query_episodes（v2 新增）─────────────────────────────

const queryEpisodesSchema = {
  type: 'object',
  properties: {
    tag: {
      type: 'string',
      description: '按 tag 精确过滤（frontmatter.tags 中存在即命中）',
    },
    type: {
      type: 'string',
      enum: ['user', 'feedback', 'project', 'reference', 'agent'],
      description: '按 episode 类别过滤',
    },
    projectId: {
      type: 'string',
      description: '限定项目（只匹配 projects/<projectId>/episodes/ 下的）',
    },
    sources: {
      type: 'array',
      items: { type: 'string' },
      description: '按来源对话过滤：frontmatter.sources 含其中任一 convId 即命中（OR）',
    },
    includeArchived: {
      type: 'boolean',
      description: '是否包括归档子目录（默认 false）',
    },
  },
} as const;

/** 索引行回执的条数上限——命中更多时截前 N（queryEpisodes 已按最近更新排序）。 */
const MAX_QUERY_LINES = 60;

function makeQueryEpisodesTool(): AgentTool {
  return {
    name: 'query_episodes',
    mutatesEnvironment: false,
    description:
      '按 tag / type / projectId 结构化过滤 episode，返回索引行列表。' +
      '比 grep_memory 精确，适合"看某个领域所有 episode"。',
    inputSchema: queryEpisodesSchema as object,
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const args = input as {
        tag?: string;
        type?: 'user' | 'feedback' | 'project' | 'reference' | 'agent';
        projectId?: string;
        sources?: string[];
        includeArchived?: boolean;
      };
      // 遍历与过滤在 queryEpisodes（与 capture 共用），这里只负责渲染索引行
      const hits = await queryEpisodes(ctx.ownerId, args);
      if (hits.length === 0) {
        return { text: '未找到匹配的 episode' };
      }
      const filterDesc = [
        args.type ? `type=${args.type}` : '',
        args.tag ? `tag=${args.tag}` : '',
        args.projectId ? `project=${args.projectId}` : '',
        args.sources && args.sources.length > 0 ? `sources=${args.sources.join('|')}` : '',
      ].filter(Boolean).join(' ') || '(无过滤)';
      const lines = hits.slice(0, MAX_QUERY_LINES).map((h) => `- ${h.compressedPath}: ${h.title} - ${h.description}`);
      return {
        text:
          `共 ${hits.length} 条命中（过滤：${filterDesc}）${hits.length > MAX_QUERY_LINES ? `，截前 ${MAX_QUERY_LINES}（按最近更新）` : ''}：\n` +
          lines.join('\n'),
      };
    },
  };
}

// ─── 出口 ──────────────────────────────────────────────

export function createMemoryTools(): AgentTool[] {
  return [
    makeRecordMemoryTool(),
    makeEditMemoryTool(),
    makeWriteMemoryTool(),
    makeGrepMemoryTool(),
    makeReadMemoryTool(),
    makeQueryEpisodesTool(),
  ];
}

// 测试导出
export {
  makeRecordMemoryTool as __makeRecordMemoryTool,
  makeEditMemoryTool as __makeEditMemoryTool,
  makeWriteMemoryTool as __makeWriteMemoryTool,
  makeGrepMemoryTool as __makeGrepMemoryTool,
  makeReadMemoryTool as __makeReadMemoryTool,
  makeQueryEpisodesTool as __makeQueryEpisodesTool,
};

// tool context 类型（renderer 不要从 @shared 重导）
export type { ToolContext, ToolResult };
