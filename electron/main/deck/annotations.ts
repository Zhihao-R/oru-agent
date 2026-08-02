/**
 * `.annotations.json` 读写（v2 框选 region）
 *
 * 落盘格式：`AnnotationsFile`（详见 shared/types.ts）。文件不存在视为空 annotations（不抛错）。
 *
 * 存储**按 AnnotationLocation 落盘、不绑 artifactId**（项目B 第三期 Task10）：增删改查 + crop
 * 读写 + mutate 锁是单一出处（`*At(loc, ...)` 核心），deck/html 各自解析 location。
 * - deck 适配：`artifactId → resolveDeckPath → deckAnnotationLocation`（旧落点、旧行为不变）。
 * - html：`htmlAnnotationLocation(htmlPath)`（文件旁 sidecar，同目录多 HTML 互不覆盖）。
 *
 * 所有 mutate 通过 `mutateAt` helper 走"读→改→写"——并按 location.lockKey 分链 Promise 写锁
 * 串行化，避免并发 addAnnotation 丢更新（详 CLAUDE.md memory `feedback_atomic_rmw_must_be_in_lock`）。
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Annotation, AnnotationsFile } from '@shared/types';
import { newAnnotationId } from '@shared/ids';
import { resolveDeckPath } from './store';
import { safeWriteAsync } from '../fs/safeWrite';
import { deckAnnotationLocation, type AnnotationLocation } from '../annotations/location';

async function readFileAt(loc: AnnotationLocation): Promise<AnnotationsFile> {
  try {
    const raw = await fs.readFile(loc.jsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; annotations?: unknown };
    // v1（旧页级注释）一律丢弃——存量极小、提交后即清空的临时草稿，不值得迁移（设计 §3.5）
    if (parsed && parsed.version === 2 && Array.isArray(parsed.annotations)) {
      return {
        version: 2,
        artifactId: loc.lockKey,
        annotations: parsed.annotations
          .map(normalizeAnnotation)
          .filter((a): a is Annotation => a !== null),
      };
    }
  } catch {
    // 不存在 / 损坏 → 视为空
  }
  // artifactId 是 AnnotationsFile 的 vestigial 字段（全仓零回读，readFileAt 即此处覆盖）——
  // 填 location 的规范化身份 lockKey 占位，不再单设 ownerId。
  return { version: 2, artifactId: loc.lockKey, annotations: [] };
}

/**
 * 把 v2 落盘数据归一化成 Annotation。字段缺失/类型不符的整条丢弃（返回 null）。
 * v1 在 readFileAt 里已整体丢弃，不会走到这里。
 */
function normalizeAnnotation(raw: unknown): Annotation | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== 'string' || typeof a.comment !== 'string') return null;

  const loc = (a.locator ?? {}) as Record<string, unknown>;
  const rect = (loc.rect ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

  const status: Annotation['status'] =
    a.status === 'submitted' ? 'submitted' : a.status === 'failed' ? 'failed' : 'pending';

  return {
    id: a.id,
    comment: a.comment,
    cropPath: typeof a.cropPath === 'string' ? a.cropPath : '',
    htmlSnippet: typeof a.htmlSnippet === 'string' ? a.htmlSnippet : '',
    text: typeof a.text === 'string' ? a.text : '',
    locator: {
      scrollY: num(loc.scrollY),
      rect: { x: num(rect.x), y: num(rect.y), w: num(rect.w), h: num(rect.h) },
      ...(typeof loc.pageIndex === 'number' ? { pageIndex: loc.pageIndex } : {}),
      ...(typeof loc.selector === 'string' ? { selector: loc.selector } : {}),
    },
    status,
    ...(typeof a.groupId === 'string' ? { groupId: a.groupId } : {}),
    ...(typeof a.failureMessage === 'string' ? { failureMessage: a.failureMessage } : {}),
    // 缺失一律归 0（而非 Date.now()）——批注列表按 createdAt 排序，用读盘时刻补值会让
    // 旧数据每次进 deck 顺序乱跳。归 0 让无时间戳的存量批注稳定沉到最前、组内按文件序兜底。
    createdAt: typeof a.createdAt === 'number' ? a.createdAt : 0,
    updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : 0,
  };
}

async function writeFileAt(loc: AnnotationLocation, f: AnnotationsFile): Promise<void> {
  await safeWriteAsync(loc.jsonPath, JSON.stringify(f, null, 2));
}

/**
 * 写锁——按 location.lockKey 分链串行化所有 mutateAt 调用，避免并发 RMW 丢更新。
 * 同构 store.ts 的 mutateDecks（详 memory `feedback_atomic_rmw_must_be_in_lock`）。
 *
 * 锁内不得再 enqueue 同 chain（自死锁，memory `feedback_no_self_enqueue_in_lock`）——故各
 * export 都直接调 mutateAt、互不嵌套。
 */
const writeChains = new Map<string, Promise<unknown>>();

async function mutateAt<T>(
  loc: AnnotationLocation,
  fn: (f: AnnotationsFile) => Promise<T> | T,
): Promise<T> {
  const prev = writeChains.get(loc.lockKey) ?? Promise.resolve();
  const next = prev.then(async () => {
    const f = await readFileAt(loc);
    const r = await fn(f);
    await writeFileAt(loc, f);
    return r;
  });
  // chain 错误不能拖垮下个调用——swallow rejection in chain，但 caller 仍能拿到原 error
  writeChains.set(loc.lockKey, next.catch(() => undefined));
  return next;
}

function cropRelPath(loc: AnnotationLocation, annotationId: string): string {
  return `${loc.cropRelPrefix}/${annotationId}.png`;
}
/** crop 绝对路径——cropRelPrefix 相对 dirname(jsonPath) 解析（crops 目录不单设字段，由此推得）。 */
function cropAbsPath(loc: AnnotationLocation, annotationId: string): string {
  return join(dirname(loc.jsonPath), cropRelPath(loc, annotationId));
}

/** 删一条注释的 crop 文件（不存在静默） */
async function deleteCropAt(loc: AnnotationLocation, annotationId: string): Promise<void> {
  try {
    await fs.unlink(cropAbsPath(loc, annotationId));
  } catch {
    // 不存在 → 忽略
  }
}

/** addAnnotation 入参：comment + 捕获快照；locator 可选（html 完全不存定位）；cropPng 可选。 */
export type AddAnnotationInput = Pick<Annotation, 'comment' | 'htmlSnippet' | 'text'> & {
  /** 框选定位，deck 用；html 省略 → 归零 locator（PRD：点卡片不跳，不存定位） */
  locator?: Annotation['locator'];
  /** crop 截图 bytes（base64 PNG 字符串 或 Buffer）；不传则 cropPath='' */
  cropPng?: string | Buffer;
};

const ZERO_LOCATOR: Annotation['locator'] = { scrollY: 0, rect: { x: 0, y: 0, w: 0, h: 0 } };

// ── location 核心（deck/html 共用单一出处）─────────────────────────────────────

export async function readAnnotationsAt(loc: AnnotationLocation): Promise<Annotation[]> {
  return (await readFileAt(loc)).annotations;
}

export async function writeAnnotationsAt(loc: AnnotationLocation, annotations: Annotation[]): Promise<void> {
  await mutateAt(loc, (f) => {
    f.annotations = annotations;
  });
}

/**
 * 加一条框选 region 注释。框选可多条独立——不再按 pageIndex 唯一覆盖。
 * 若带 cropPng，落盘到 location 的 crops 目录并把相对路径写进 cropPath。
 */
export async function addAnnotationAt(loc: AnnotationLocation, input: AddAnnotationInput): Promise<Annotation> {
  return mutateAt(loc, async (f) => {
    const now = Date.now();
    const id = newAnnotationId();
    let cropPath = '';
    if (input.cropPng !== undefined) {
      const bytes = typeof input.cropPng === 'string' ? Buffer.from(input.cropPng, 'base64') : input.cropPng;
      const abs = cropAbsPath(loc, id);
      await fs.mkdir(dirname(abs), { recursive: true });
      // Buffer（PNG）写入：safeWriteAsync 只收 string（utf-8 + 换行处理），二进制不适用；
      // crop 是派生数据（半写坏可重截），直接写不走原子内核。
      await fs.writeFile(abs, bytes);
      cropPath = cropRelPath(loc, id);
    }
    const annotation: Annotation = {
      id,
      comment: input.comment,
      cropPath,
      htmlSnippet: input.htmlSnippet,
      text: input.text,
      locator: input.locator ?? ZERO_LOCATOR,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    f.annotations.push(annotation);
    return annotation;
  });
}

/**
 * 改注释字段子集；找不到抛 DECK_ANNOTATION_NOT_FOUND。
 *
 * 当 patch 改变了 comment 时自动重置 status='pending' + 清 failureMessage——
 * "用户改了内容" = "重新交给 AI 试"。不这么做的话 failed annotation 改完
 * status 仍是 failed，commit 流程过滤 pending 不会重跑它。
 */
export async function updateAnnotationAt(
  loc: AnnotationLocation,
  annotationId: string,
  patch: Partial<Pick<Annotation, 'comment' | 'status' | 'failureMessage' | 'groupId'>>,
): Promise<Annotation> {
  return mutateAt(loc, (f) => {
    const idx = f.annotations.findIndex((a) => a.id === annotationId);
    if (idx < 0) {
      const err = new Error(`annotation not found: ${annotationId}`) as Error & { code?: string };
      err.code = 'DECK_ANNOTATION_NOT_FOUND';
      throw err;
    }
    const prev = f.annotations[idx];
    const commentChanged = patch.comment !== undefined && patch.comment !== prev.comment;
    const updated: Annotation = {
      ...prev,
      ...patch,
      ...(commentChanged ? { status: 'pending' as const, failureMessage: undefined } : {}),
      updatedAt: Date.now(),
    };
    f.annotations[idx] = updated;
    return updated;
  });
}

/** 删注释 + 连带删其 crop 截图；找不到静默成功（幂等） */
export async function removeAnnotationAt(loc: AnnotationLocation, annotationId: string): Promise<void> {
  await mutateAt(loc, async (f) => {
    f.annotations = f.annotations.filter((a) => a.id !== annotationId);
    await deleteCropAt(loc, annotationId);
  });
}

/** 批量提交后调：清空 pending 项 + 连带删其 crop，保留 failed/submitted */
export async function clearPendingAt(loc: AnnotationLocation): Promise<void> {
  await mutateAt(loc, async (f) => {
    const pending = f.annotations.filter((a) => a.status === 'pending');
    f.annotations = f.annotations.filter((a) => a.status !== 'pending');
    for (const a of pending) await deleteCropAt(loc, a.id);
  });
}

/** 读某条标注的 crop 字节（提交 payload 用，renderer 在 Vite dev 拿不到 file://）；无图/读不到返 null。 */
export async function readCropBytesAt(loc: AnnotationLocation, annotationId: string): Promise<Buffer | null> {
  return fs.readFile(cropAbsPath(loc, annotationId)).catch(() => null);
}

// ── deck 适配器（artifactId → deckAnnotationLocation，旧签名/行为不变）────────────

async function deckLoc(artifactId: string): Promise<AnnotationLocation> {
  return deckAnnotationLocation(await resolveDeckPath(artifactId));
}

export async function readAnnotations(artifactId: string): Promise<Annotation[]> {
  return readAnnotationsAt(await deckLoc(artifactId));
}

export async function writeAnnotations(artifactId: string, annotations: Annotation[]): Promise<void> {
  await writeAnnotationsAt(await deckLoc(artifactId), annotations);
}

export async function addAnnotation(artifactId: string, input: AddAnnotationInput): Promise<Annotation> {
  return addAnnotationAt(await deckLoc(artifactId), input);
}

export async function updateAnnotation(
  artifactId: string,
  annotationId: string,
  patch: Partial<Pick<Annotation, 'comment' | 'status' | 'failureMessage' | 'groupId'>>,
): Promise<Annotation> {
  return updateAnnotationAt(await deckLoc(artifactId), annotationId, patch);
}

export async function removeAnnotation(artifactId: string, annotationId: string): Promise<void> {
  await removeAnnotationAt(await deckLoc(artifactId), annotationId);
}

export async function clearPendingAnnotations(artifactId: string): Promise<void> {
  await clearPendingAt(await deckLoc(artifactId));
}
