/**
 * 统一的 MemoryOp 应用层
 *
 * record_memory / capture / dream 三条写入路径共用同一套 MemoryOp（见 @shared/memory/operations）。
 * 这里负责：
 *   1. 校验 origin 白名单
 *   2. 按 op 类型分发到对应的实现
 *   3. 失败 op 不影响其他（each-op 独立 try-catch）
 *   4. 返回 ApplyResult
 */
import { join } from 'node:path';
import type {
  ApplyResult,
  EpisodeCreatePayload,
  MemoryOp,
  MemoryOpOrigin,
  OpResult,
} from '@shared/memory/operations';
import { OP_WHITELIST } from '@shared/memory/operations';
import { compressPath, expandPath, resolveToFullRelPath } from './compressedPath';
import { DEFAULT_AGENT_NAME, memoryRoot } from './paths';
import { EPISODE_TYPES, normalizeEpisodeType } from './snapshot';
import {
  markEpisodeRetired,
  markEpisodeSuperseded,
  removeIndexEntry,
  upsertIndexEntry,
  writeEpisode,
} from './store';
import { appendChangeLine, describeOpForChangelog } from './changelog';
import { moveToTrash } from './trash';
import { isRegisteredProject } from '../projects/store';
import { readMarkdownFile, writeMarkdownFile } from '../fs/frontmatter';

/** 应用一批 op。origin 决定白名单 */
export async function applyOps(
  ownerId: string,
  ops: MemoryOp[],
  origin: MemoryOpOrigin,
): Promise<ApplyResult> {
  const whitelist = OP_WHITELIST[origin];
  const results: OpResult[] = [];
  for (const op of ops) {
    if (!whitelist.has(op.op)) {
      results.push({ op: op.op, ok: false, error: `op ${op.op} not allowed for origin ${origin}` });
      continue;
    }
    try {
      const exec = await applyOne(ownerId, op, origin);
      results.push({ op: op.op, ok: true, detail: exec.detail, matched: exec.matched });
      // 变更记录：dream 的全部写动作，加上任何 origin 的纠正/退休（correct/retire）——
      // 纠正附依据、退休记判据，都需要可查的审计留痕（对话侧纠正的依据靠它落盘，S35·G68）。
      // 追加/取代（create/supersede/merge 非 dream）在对话流里已有卡片，不重复记。
      // best-effort：记录失败不影响 op 本身的结果。
      if (origin === 'dream' || op.op === 'correct-episode' || op.op === 'retire-episode') {
        const line = describeOpForChangelog(op, exec.detail);
        if (line) {
          await appendChangeLine(ownerId, line).catch((e) => {
            // 记录失败不影响 op，但"用户可感知"的承诺破了要留痕
            console.warn('[oru.memory] changelog 追加失败：', e);
          });
        }
      }
    } catch (e) {
      results.push({
        op: op.op,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return {
    results,
    okCount: results.filter((r) => r.ok).length,
    errCount: results.filter((r) => !r.ok).length,
  };
}

// ─── 分发器 ───────────────────────────────────────────────

/** 单 op 的执行结果。matched 仅对 update-* / remove-* 类有意义，其它 op 不写。 */
type OpExec = { detail: string; matched?: boolean };

const ok = (detail: string): OpExec => ({ detail });
const matchResult = (matched: boolean, ifTrue: string, miss: string): OpExec => ({
  detail: matched ? ifTrue : miss,
  matched,
});

async function applyOne(ownerId: string, op: MemoryOp, origin: MemoryOpOrigin): Promise<OpExec> {
  switch (op.op) {
    case 'create-episode':
      return ok(await applyCreateEpisode(ownerId, op.payload, origin));
    case 'supersede-episode':
      return ok(await applySupersede(ownerId, op.oldPath, op.payload, origin));
    case 'correct-episode':
      return ok(await applyCorrect(ownerId, op.oldPath, op.payload, origin));
    case 'merge-episodes':
      return ok(await applyMerge(ownerId, op.mergeInto, op.mergeFrom, op.newDescription, op.newBody));
    case 'retire-episode':
      return ok(await applyRetire(ownerId, op.path, op.reason));
  }
  // 档案类 op（user/self/项目画像的定区段增改删覆盖）已退役——profile/self/项目档案统一走文档模型
  // （write_memory / edit_memory + parseProfileDoc）。这里只剩 episode 的结构化 op（建/并/纠/退）。
}

// ─── Episode 类 op ─────────────────────────────────────────

/**
 * projectId 撞 agent scope 名 → 压缩路径**不可逆**，任何 origin 都不许写。
 *
 * compressPath 把 `agents/<X>/episodes/…` 与 `projects/<X>/episodes/…` 压成同一形态
 * `<X>/<slug>`，展开时首段等于 DEFAULT_AGENT_NAME 就恒判 agent scope、只找 agents/ 下。
 * 于是 projects/twin/ 里的 episode 写得进、读不出——dream 每晚在索引里看见它、每晚
 * read_memory 报「文件不存在」，2026-07-26 那次转而读回整个来源对话（单次 12 万字符）
 * 继而跑偏，起点就是这里。
 *
 * 纯校验、不碰盘：既当 applyCreateEpisode 这个唯一写入点的守门，也供 applyCorrect 在
 * moveToTrash **之前**先抛——拒晚了旧条目已经进了回收站，纠错失败＝原条凭空消失。
 */
function assertProjectIdNotCollide(payload: EpisodeCreatePayload): void {
  if (payload.scope !== 'project' || payload.projectId !== DEFAULT_AGENT_NAME) return;
  throw new Error(
    `projectId 不能是 "${DEFAULT_AGENT_NAME}"——它与 agent scope 同名，会让压缩路径不可逆；` +
      `通用记忆请用 scope=agent`,
  );
}

async function applyCreateEpisode(
  ownerId: string,
  payload: EpisodeCreatePayload,
  origin: MemoryOpOrigin,
  extraFrontmatter?: Record<string, string>,
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const scopeId = payload.scope === 'project' ? (payload.projectId ?? '') : DEFAULT_AGENT_NAME;
  if (payload.scope === 'project') {
    if (!scopeId) throw new Error('create-episode: scope=project requires projectId');
    assertProjectIdNotCollide(payload);
    // record / capture 路径：AI 填的 projectId 必须对得上一个已注册项目，否则会在
    // memory/projects/ 下凭空造一个无人认领的"幽灵项目目录"（孤儿记忆）。dream 走
    // merge / correct 搬运既有 episode，projectId 由旧文件继承，不在此重校验。
    if ((origin === 'record' || origin === 'capture') && !(await isRegisteredProject(ownerId, scopeId))) {
      throw new Error(
        `create-episode: projectId "${scopeId}" 不是已注册项目——` +
          `请用 system prompt"当前项目 …"里的真实 id，或改用 scope=agent 归通用记忆`,
      );
    }
  }
  // 决策 2 写入侧：先规则修正（别名表 / 'episode' 按 scope 缩小），修不了再分场景兜底。
  const effectiveType = resolveEpisodeType(payload.type, payload.scope, origin, payload.slug);
  const relPath = await writeEpisode({
    ownerId,
    scopeName: payload.scope,
    scopeId,
    slug: payload.slug,
    frontmatter: {
      scope: payload.scope === 'project' ? `project:${scopeId}` : 'agent',
      tags: payload.tags ?? [],
      status: 'active',
      created: today,
      // 用户明确要求记住的条目带 user-direct——夜间整理据此优先保留它的原话（守则层，非硬护栏）。
      // 严格判 true：模型吐出的字符串 "false" 在真值判断下会把一条自发记的误标成用户嘱记
      // （同文件另一处 user-direct 判定本就是 === true，此处对齐）
      source: payload.userRequested === true ? 'user-direct' : 'twin-auto',
      // v2 扩展字段——writeEpisode 让 frontmatter.type 覆盖兜底 'episode'
      title: payload.title,
      description: payload.description,
      type: effectiveType,
      updated: today,
      sources: payload.sources ?? [],
      ...(extraFrontmatter ?? {}),
    },
    body: payload.content,
  });
  await upsertIndexEntry(ownerId, {
    relPath,
    title: payload.title,
    scope: payload.scope === 'project' ? `project:${scopeId}` : 'agent',
    tags: payload.tags ?? [],
  });
  return compressPath(relPath);
}

async function applySupersede(
  ownerId: string,
  oldPath: string,
  newPayload: EpisodeCreatePayload,
  origin: MemoryOpOrigin,
): Promise<string> {
  // 先解析旧文件并防自我覆盖：supersede 要保留旧的作时间线（标 superseded + 移出索引），
  // 若新旧落到同一文件（同 slug 同日），写入新内容后会立刻把它标成"被自己取代"并移出召回——
  // 静默丢新内容。同路径本就装不下"旧时间线 + 新活跃"两份，故在动手前就拦下、引导换 slug / 改用 correct。
  const oldRel = await resolveOldEpisodePath(ownerId, oldPath);
  if (oldRel) {
    const today = new Date().toISOString().slice(0, 10);
    const newScopeName =
      newPayload.scope === 'project' ? (newPayload.projectId ?? '') : DEFAULT_AGENT_NAME;
    const newCompressed = `${newScopeName}/${today}-${newPayload.slug}`;
    let oldCompressed = '';
    try { oldCompressed = compressPath(oldRel); } catch { /* 非 episode 路径，忽略 */ }
    if (oldCompressed && oldCompressed === newCompressed) {
      throw new Error(
        `supersede 新旧 episode 路径相同（同 slug 同日：${newCompressed}）——请给新事件换一个 slug，或用 correct 修正`,
      );
    }
  }
  // 继承用户意愿标记：旧条是 user-direct 且新 payload 未显式表态 → 新条照样 user-direct，
  // 否则用户亲手记的条目被一次 supersede 后保护静默丢失
  const payload = await inheritUserDirect(ownerId, oldRel, newPayload);
  const newPath = await applyCreateEpisode(ownerId, payload, origin);
  if (oldRel) {
    const newRelFull = await expandPath(ownerId, newPath);
    await markEpisodeSuperseded(ownerId, oldRel, newRelFull);
  }
  return newPath;
}

async function applyCorrect(
  ownerId: string,
  oldPath: string,
  newPayload: EpisodeCreatePayload,
  origin: MemoryOpOrigin,
): Promise<string> {
  const oldRel = await resolveOldEpisodePath(ownerId, oldPath);
  if (!oldRel) {
    // correction 语义是"旧内容应被清除"——找不到旧文件就报错，避免新旧并存
    throw new Error(
      `correct-episode: 旧 episode 不存在 oldPath="${oldPath}"——请改用 create-episode（不带 conflictsWith）`,
    );
  }
  // 先删旧再写新：correct 语义要求旧内容清除，且新旧若同 slug+同日（同会话当场纠错的常态）
  // 路径相同——必须先把旧文件挪走，再写新文件，否则 writeEpisode 原地覆盖后 moveToTrash 会把
  // 新内容也一起扔进回收站。
  // 但 record 非法分类要在动旧文件**之前**就抛——避免删了旧的又写不进新的丢数据。
  if (origin === 'record' && normalizeEpisodeType(newPayload.type, newPayload.scope).type === null) {
    throw illegalTypeError(newPayload.type);
  }
  // 同理，撞名的 projectId 在 applyCreateEpisode 里必被拒——赶在移走旧文件前先抛
  assertProjectIdNotCollide(newPayload);
  // 旧 frontmatter 只读一次：标记继承 + created 保留都从这里取
  const oldFm = (await readMarkdownFile(join(memoryRoot(ownerId), oldRel)).catch(() => null))
    ?.data as { source?: string; created?: string } | undefined;
  const payload =
    newPayload.userRequested !== true && oldFm?.source === 'user-direct'
      ? { ...newPayload, userRequested: true }
      : newPayload;
  await moveToTrash(ownerId, join(memoryRoot(ownerId), oldRel));
  const extra: Record<string, string> = {};
  // 纠错不改变事件的发生时间——created（连同文件名日期）保留原条的，列表里日期不跳变
  if (oldFm?.created) extra.created = oldFm.created;
  // dream 的纠错产物打 corrected-at——守则要求带此标记的条目再纠之前先查 changelog 上次依据
  if (origin === 'dream') extra['corrected-at'] = new Date().toISOString().slice(0, 10);
  const newPath = await applyCreateEpisode(
    ownerId,
    payload,
    origin,
    Object.keys(extra).length > 0 ? extra : undefined,
  );
  return newPath;
}

/** 读 episode 的 source 字段；文件读不到返回 undefined */
async function readEpisodeSource(ownerId: string, rel: string): Promise<string | undefined> {
  const f = await readMarkdownFile(join(memoryRoot(ownerId), rel)).catch(() => null);
  return (f?.data as { source?: string } | undefined)?.source;
}

/**
 * 旧条是 user-direct 且新 payload 未声明 true → 继承标记。
 * false 视同"未表态"——模型填 false 意思是"这次不是用户要求"，不是"抹掉这个痕迹"。
 *
 * 标记只是痕迹、不再是护栏：曾据它禁止 dream 校对/淘汰/并入/改写的硬护栏 2026-07-28 已拆
 * （它保护的是承载事实的文件而非事实本身，实测把合并方向逼反）。别再加回来——
 * 论证见 docs/plans/2026-07-28-长会话质量盘点与修复-plan.md 的「记忆合并护栏把方向逼反」。
 */
async function inheritUserDirect(
  ownerId: string,
  oldRel: string | null,
  payload: EpisodeCreatePayload,
): Promise<EpisodeCreatePayload> {
  if (!oldRel || payload.userRequested === true) return payload;
  const oldSource = await readEpisodeSource(ownerId, oldRel);
  return oldSource === 'user-direct' ? { ...payload, userRequested: true } : payload;
}

async function applyRetire(ownerId: string, path: string, reason: string): Promise<string> {
  if (!reason || reason.trim().length === 0) {
    throw new Error('retire-episode: reason 必填——按哪条判据淘汰要写明');
  }
  const rel = await resolveOldEpisodePath(ownerId, path);
  if (!rel) {
    throw new Error(`retire-episode: episode 不存在 path="${path}"`);
  }
  const r = await markEpisodeRetired(ownerId, rel, reason.trim());
  if (!r.ok) throw new Error(`retire-episode: 标记失败 ${rel}`);
  try {
    return compressPath(rel);
  } catch {
    return rel;
  }
}

/**
 * 把 episode 分类归一到落盘值（决策 2 写入侧）：
 * - 合法 / 可规则修正 → 返回修正后的值
 * - record（对话内、唯一能当场免费重填的来源）非法 → throw，让工具回错误、模型重写，不落脏数据
 * - 其余来源（capture/dream/ui，无对话内重试）非法 → 不丢：原样返回 + warn，
 *   由 listInvalidEpisodes 让它可被发现，留待下次 dream 或人工收拾
 *   （实际只有 capture 白名单含 create-episode；dream/ui 走到这里属防御，语义同样是"不阻断、不丢"）
 */
function resolveEpisodeType(
  rawType: string,
  scope: 'agent' | 'project',
  origin: MemoryOpOrigin,
  slug: string,
): string {
  const norm = normalizeEpisodeType(rawType, scope);
  if (norm.type) return norm.type;
  if (origin === 'record') throw illegalTypeError(rawType);
  console.warn(`[oru.memory] ${origin} episode 分类非法 type="${rawType}"，原样保留待收拾：${slug}`);
  return String(rawType);
}

function illegalTypeError(rawType: string): Error {
  return new Error(
    `episode 分类只能是 ${EPISODE_TYPES.join(' / ')}，你填的是 "${rawType}"——请用合法分类重写`,
  );
}

async function applyMerge(
  ownerId: string,
  mergeIntoCompressed: string,
  mergeFromCompressed: string[],
  newDescription: string | undefined,
  newBody: string | undefined,
): Promise<string> {
  // 把 mergeFrom 中每条标 superseded 链向 mergeInto，再可选更新 mergeInto 的 description / 正文。
  const intoRel = await expandPath(ownerId, mergeIntoCompressed);
  const fromRels = (
    await Promise.all(mergeFromCompressed.map((c) => expandPath(ownerId, c).catch(() => '')))
  ).filter((r) => r !== '');
  // 先重写 mergeInto（newBody 把 mergeFrom 的互补内容捏进幸存者正文），再 supersede mergeFrom——
  // 顺序承重：崩溃/写失败的窗口里，宁可"新正文已落地但旧条还在活跃"（重复、可下次再收），
  // 也不能"旧条已移出但新正文没写进去"（互补内容永久丢）。信息不丢 > 去重干净。
  if (newDescription || newBody) {
    const abs = join(memoryRoot(ownerId), intoRel);
    const f = await readMarkdownFile(abs);
    // 读不到就中止：此时还没 supersede 任何 mergeFrom，抛错让整条 op 失败、旧条原样留存，不丢信息
    if (!f) throw new Error(`merge-episodes: mergeInto 读取失败，newBody/描述写入中止 ${intoRel}`);
    const data: Record<string, unknown> = {
      ...f.data,
      ...(newDescription ? { description: newDescription } : {}),
      updated: new Date().toISOString().slice(0, 10),
    };
    await writeMarkdownFile(abs, data, newBody ?? f.content);
    await upsertIndexEntry(ownerId, {
      relPath: intoRel,
      title: (data.title as string) ?? '',
      scope: (data.scope as string) ?? '',
      tags: (data.tags as string[]) ?? [],
    });
  }
  for (const fromRel of fromRels) {
    await markEpisodeSuperseded(ownerId, fromRel, intoRel);
  }
  return `merged ${mergeFromCompressed.length} into ${mergeIntoCompressed}`;
}

/**
 * 把 oldPath 输入归一到完整相对路径——找不到返回空字符串。
 * supersede 容错（找不到只是不标）/ correct 由上层 throw（要求旧文件必须在）。
 */
async function resolveOldEpisodePath(ownerId: string, input: string): Promise<string> {
  return (await resolveToFullRelPath(ownerId, input, true)) ?? '';
}



