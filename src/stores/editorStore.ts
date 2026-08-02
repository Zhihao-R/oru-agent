import { create } from 'zustand';
import { ExternalChange } from '@uiw/react-codemirror';
import { diff } from '@codemirror/merge';
import { Transaction } from '@codemirror/state';
import { undoDepth, redoDepth } from '@codemirror/commands';
import { clearEditorHistory } from '@/components/editor/editorHistory';
import { diff3 } from '@shared/diff3';
import { addConflicts, clearAllConflicts, type ConflictSpec, type ConflictAction } from '@/components/editor/conflictCard';
import { addHighlight, clearHighlight, HIGHLIGHT_MS } from '@/components/editor/recentChangeHighlight';
import type {
  FsMdContentEvent,
  FsMdSavedEvent,
  FileHistoryRestoredEvent,
  MemoryDocLiveEvent,
  MemoryHistoryRestoredEvent,
  ConflictOpenedResult,
  ConflictOutcome,
  ServerEvent,
} from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { relocateUnder, isUnder } from '@/lib/paths';
import { getEditorView } from '@/components/editor/editorViewRegistry';
import { registerTabCloser } from '@/stores/workspaceStore';

/**
 * 文档身份标识——支持项目文件与档案两种后端。
 *  - project：桶 key 即 path（项目相对路径，与改动前逐字节不变）。
 *  - memory：桶 key 为 `mem:${relPath}`，IO 本任务用占位空函数。
 */
export type DocRef =
  | { kind: 'project'; projectId: string; path: string }
  | { kind: 'memory'; relPath: string };

/** 桶 key：project → path；memory → `mem:${relPath}`。 */
export function refKey(r: DocRef): string {
  return r.kind === 'project' ? r.path : `mem:${r.relPath}`;
}

/**
 * 完整身份（await 后重检守卫用）：项目含 projectId 维度，memory 用 relPath。桶键仍用 refKey（=path），
 * 此函数只用于「还是不是我这个文档」的等价判定，恢复重构前 projectId 比对的鉴别力
 * （挡「同 path 但在 await 期间换了项目」的跨项目竞态）。
 */
function docId(r: DocRef): string {
  return r.kind === 'project' ? `${r.projectId}:${r.path}` : `mem:${r.relPath}`;
}

/**
 * md/txt 编辑器 store —— 实时自动落盘（草稿机制下线）。
 *
 * 多标签（右栏标签工作区）下**按 path 分桶**：每个打开的 md 各存一份内容态，切走不卸载、互不串改。
 * 模块级 debounce 也按 path 各一份（`pendings`/`timers`），A 的待写不会被 B 覆盖。
 *
 * 模型反转（详 docs/prd/2026-06-16-realtime-save-history）：磁盘从「上次⌘S确认版」变成「你随手最新版」。
 *  - 停手约 0.8s 自动落盘 + 失焦/切文件/隐藏/退出立即落 → 磁盘=屏幕、Oru 读磁盘即最新。
 *  - 不丢由 main 侧统一临界区（overwrite-guard）保证，渲染端不再做「写前查磁盘→进冲突」那套。
 *  - 没有「未保存」状态：savedContent/isDirty/小圆点/保存按钮/冲突六件套全部退场。
 *  - ⌘Z 走 CodeMirror 自带会话内撤销；跨度更大的「找回旧版」走 FileHistory（历史窗口）。
 *
 * lastSyncedContent = 该文件最近一次读到/写到磁盘的内容。只用于一处判断：切回编辑器时，
 * 若磁盘被外部/AI 改过（disk ≠ lastSynced）且本地无未落盘编辑（content === lastSynced），
 * 就刷新成磁盘版；若本地有编辑，则本地优先（external 被 overwrite-guard 兜进历史）。
 */
export type EditorFileState = {
  ref: DocRef; // 文档身份（取代原 projectId 字段）
  content: string;
  /** 最近一次与磁盘同步过的内容——判断「外部改过 vs 我本地改过」用 */
  lastSyncedContent: string;
  loading: boolean;
};

type EditorState = {
  files: Record<string, EditorFileState>; // 按 refKey 分桶（project → path；memory → mem:relPath）
  open: (projectId: string, path: string) => Promise<void>; // 兼容 API：内部构造 {kind:'project',...}
  openRef: (ref: DocRef) => Promise<void>; // 泛化入口
  setContent: (path: string, content: string) => void;
  flush: (path: string) => Promise<void>; // 立即落盘某 path 的 pending（失焦/切文件/退出）
  flushAll: () => Promise<void>; // 落盘所有打开编辑器的 pending（AI 动手 / 改名前）
  manualSnapshot: (path: string) => Promise<void>; // ⌘S：立刻落盘 + 打一条 manual 留底
  syncFromDisk: (path: string) => Promise<void>; // 切回编辑器：本地无改动则刷新成磁盘版
  noteCompositionEnd: (path: string) => void; // IME 组合结束：排掉组合期攒下的 pending + 补跑被推迟的同步
  restoreFromHistory: (path: string, snapshotId: string) => Promise<void>; // 历史窗口：恢复某旧版
  // 打开的文件被改名/移动 → 分桶 key 跟随。newContent 仅在「改名联动回写引用」时携带（只针对被改名那个文件）：
  // 内存与磁盘内容分叉，必须用它原子重置内存态 + 清 pending，杜绝 stale autosave 盖回写（§十一 C-1）。
  relocate: (oldRel: string, newRel: string, newContent?: string) => void;
  closeIfUnder: (path: string) => void; // 打开的文件被删 → 关闭对应标签桶
  close: (path: string) => void;
};

async function readDisk(ref: DocRef, path: string): Promise<string> {
  if (ref.kind === 'memory') {
    // 档案后端：读 body-only（不解析 ProfileDoc，编辑器直接用）
    const res = await wsClient.request<MemoryDocLiveEvent>({ type: 'memory.doc.readLive', relPath: ref.relPath });
    return res.content;
  }
  const res = await wsClient.request<FsMdContentEvent>({ type: 'fs.readMd', projectId: ref.projectId, path });
  if (res.type !== 'fs.md.content') throw new Error('unexpected readMd response');
  return res.content;
}

/**
 * 落盘一个 md。S27：带 baseline+mergeOnStale 时基线过期走锁内机械合并——返回 fs.md.saved
 * （result：written / merged（携合并产物 content）/ discarded（撞同段弃写、磁盘未动））。
 */
async function writeDisk(
  ref: DocRef,
  path: string,
  content: string,
  opts?: { mark?: 'manual'; baseline?: { content: string }; mergeOnStale?: boolean },
): Promise<FsMdSavedEvent> {
  if (ref.kind === 'memory') {
    // 档案后端：三方合并写（baseline+mergeOnStale），把 MemoryDocLiveEvent 映射成 FsMdSavedEvent 形状
    // 复用 flushMergeInner 的 written/merged/discarded 分支处理，无需额外路径
    const r = await wsClient.request<MemoryDocLiveEvent>({
      type: 'memory.doc.writeLive',
      relPath: ref.relPath,
      content,
      baseline: opts?.baseline?.content,
      mergeOnStale: opts?.mergeOnStale,
      mark: opts?.mark,
    });
    // 映射成 FsMdSavedEvent 形状复用 flushMergeInner 的 status 处理；flushMergeInner 只读 result/content，projectId/path 两字段在本调用链不被消费（memory discarded 早 return，不走读 res.path 的降级路径）。别在别处依赖此处 path=relPath（非桶 key）。
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return { type: 'fs.md.saved', projectId: '', path: ref.relPath, result: r.status, content: r.content } satisfies FsMdSavedEvent;
  }
  const res = await wsClient.request<FsMdSavedEvent>({
    type: 'fs.writeMd',
    projectId: ref.projectId,
    path,
    content,
    mark: opts?.mark,
    baseline: opts?.baseline,
    mergeOnStale: opts?.mergeOnStale,
  });
  if (res.type !== 'fs.md.saved') throw new Error('unexpected writeMd response');
  return res;
}

function setSampling(ref: DocRef, path: string, on: boolean): void {
  // memory 后端本任务占位：无采样接口
  if (ref.kind !== 'project') return;
  void wsClient.request({ type: 'fs.history.sample', projectId: ref.projectId, path, on }).catch(() => {});
}

// ── 自动落盘 debounce：计时器与待写内容按 key 各一份（ref 绑进 pending） ──
const pendings = new Map<string, { ref: DocRef; content: string }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTOSAVE_DEBOUNCE_MS = 800;

/**
 * 开桶代际：每次真正读盘建桶（open / 改名回写）自增一个序号。flush 落盘成功后据此判断
 * 「写盘 await 期间是否换了**逻辑文件**」——用户继续打字不换代际（应把 base 推进到已写版本）、
 * 关掉重开同 path 会 bump 代际（过期写不该把内容盖到新会话的 base 上）。
 *
 * 取代原来的「桶对象同一性」守卫：后者把「打字换出新桶对象」和「重开换了文件」当成同一个 `!==` 信号，
 * 于是用户在自动落盘窗口里随手多打一个字，base 就拒绝推进、自写回声被 diff3 误判成外部改动而弹冲突卡。
 * 代际号能区分这两者（open 不在 per-path 串行队列里，但单调代际能**检测**到它发生过，无需把 open 入队）。
 */
const openGen = new Map<string, number>();
let genSeq = 0;

// IME 组合期间被推迟的 syncFromDisk（compositionend 后由 noteCompositionEnd 补跑）。
const composingSyncDeferred = new Set<string>();

/**
 * per-path 串行队列（§6）：收口所有「读 / 推进 base（lastSyncedContent）」的操作——
 * autosave flush、三方合并 syncFromDisk、restore、manualSnapshot——串行执行，杜绝 §6 的 base 竞态
 * （典型：合并的两个 await 之间 flush 把 base 推进到含你输入的版本，合并仍用旧 base 算 diff3 偏移）。
 * ⚠ 自死锁纪律（[[feedback_no_self_enqueue_in_lock]]）：队列内的 op 只能调 *Inner 工作函数，
 * 绝不能再 enqueue 同 path（会等自己）。公共入口 enqueue 一次，内层直调 flushPlainInner。
 *
 * 与主进程 electron/main/fs/runExclusive.ts 是同一「按 key 串行化」范式的渲染端孪生（各跑各进程，
 * 不能跨进程 import）。统一成一份共享内核（提到 src/lib 共用）是后续治理项，波及主进程数十处调用，单列。
 */
const chains = new Map<string, Promise<unknown>>();
function enqueue<T>(path: string, op: () => Promise<T>): Promise<T> {
  const prev = chains.get(path) ?? Promise.resolve();
  const run = prev.then(op, op); // 前一个成败都接着跑（隔离失败，不卡死后续）
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(path, tail);
  void tail.finally(() => {
    if (chains.get(path) === tail) chains.delete(path); // 链尾自清，无后续接上时删条目防泄漏
  });
  return run;
}

function clearTimerFor(path: string): void {
  const t = timers.get(path);
  if (t) {
    clearTimeout(t);
    timers.delete(path);
  }
}

function armAutosave(path: string): void {
  clearTimerFor(path);
  timers.set(
    path,
    setTimeout(() => void enqueue(path, () => flushMergeInner(path)), AUTOSAVE_DEBOUNCE_MS),
  );
}

function scheduleAutosave(ref: DocRef, key: string, content: string): void {
  pendings.set(key, { ref, content });
  // IME 组合中：只记 pending、不起计时器，避免把未上屏的候选拼音落盘（Oru 读盘会读到半成品）。
  // compositionend 由 noteCompositionEnd 把 pending 正式排盘。view.composing 的语义正是「组合中且已有改动」。
  // getEditorView 注册时 key 与桶 key 一致（project: path；memory: mem:relPath）。
  if (getEditorView(key)?.composing) {
    clearTimerFor(key);
    return;
  }
  armAutosave(key);
}

/**
 * base（lastSyncedContent）能否推进到刚写出磁盘的内容：桶仍在、且开桶代际与写前捕获的一致（见 openGen）。
 * flushPlainInner 与 manualSnapshot 共用此一处规则，杜绝两处守卫漂移。
 */
function canAdvanceBase(path: string, gen: number | undefined): boolean {
  return openGen.get(path) === gen && !!useEditorStore.getState().files[path];
}

/** 应用一个 patch 到某 path 的桶（桶不在则忽略——已被关/迁移）。 */
function patchFile(path: string, patch: Partial<EditorFileState>): void {
  const files = useEditorStore.getState().files;
  const f = files[path];
  if (!f) return;
  useEditorStore.setState({ files: { ...files, [path]: { ...f, ...patch } } });
}

/**
 * 把外部内容（AI 落盘合并 / 历史恢复 / 改名回写）落入半受控编辑器（tech §3.2）。
 *
 * 有注册 view（标签已挂载）→ 按当前 view 内容到 newContent 的最小变更集 dispatch：原地更新、
 * 光标/滚动随 changeset 自动映射不被打断（这是「可见·不打断」的关键，区别于受控 value 整篇替换）。
 * 标 ExternalChange annotation——@uiw 的 updateListener 据此跳过 onChange，不回声成环（store 在此显式
 * 推进 content/base，不靠 onChange 二次写、不排冗余 autosave）。无 view（非活跃标签未挂载 / 测试）→
 * 仅更新桶，下次挂载由 MdEditor 以 content 作初始 doc 落地。content 与 base 一并推进，原子一致。
 *
 * ⚠ 承重不变量：view.dispatch 与 patchFile 必须**同步成对**、value 永不先于 doc。受控 value 仍在，
 * @uiw 的 reconcile（value≠doc 时整篇替换）之所以不冲掉本次事务，正因为 dispatch 先把 doc 改成
 * newContent、patchFile 紧接着把 value 也改成 newContent，二者间无 React render——reconcile 跑时
 * value===doc 恒成立、空转。任何未来改动若把 patchFile 拆成异步、或在不 dispatch view 的情况下单独推
 * content（「无 view 退化」那条除外），就重新打开了 tech §3.2 警告的「受控值冲掉事务结果」窗口。
 */
/**
 * 换入是否可能命中撤销栈已记录的区域（G94 作废判定）。判据：外部改动**破坏性**地替换/删除了既有文档
 * 内容（存在 toA > fromA 的段）——被替换掉的文本可能正是某条 undo/redo 项要还原的落点，重映射会拼出脏内容。
 * 纯插入（所有段 fromA===toA，如 AI 在别处追加）不动既有文本、CM 能干净重映射，撤销栈原样保留。
 *
 * 为何不按「base→cur 净改动区间」精确判：那只覆盖**未落盘**的本地编辑，抓不到已 flush 但仍在 CM 撤销栈里
 * 的历史项（restore/场景一 换入常替换到这些区域）。破坏性判据对两者一视同仁，保守但不漏（宁可多清，tech §5）。
 */
function isDestructiveExternal(extDiff: ReturnType<typeof diff>): boolean {
  return extDiff.some((c) => c.toA > c.fromA);
}

function dispatchExternal(path: string, newContent: string): void {
  const view = getEditorView(path);
  if (!view) return;
  const cur = view.state.doc.toString();
  if (cur === newContent) return;
  const d = diff(cur, newContent);
  const changes = d.map((c) => ({ from: c.fromA, to: c.toA, insert: newContent.slice(c.fromB, c.toB) }));
  // theirs 命中区间（newContent 坐标 = 应用后文档坐标）挂「刚改过」高亮，约 2s 后自动消退（场景一·文档）
  const highlights = d.filter((c) => c.toB > c.fromB).map((c) => ({ from: c.fromB, to: c.toB }));
  view.dispatch({
    changes,
    effects: highlights.length ? addHighlight.of(highlights) : [],
    // G94：换入是「外部事务」，Transaction.addToHistory.of(false) 隔离出撤销栈——Ctrl+Z 撤的仍是用户
    // 自己敲的字，不是这次换入（与 ExternalChange 正交：一个跳 onChange 回声、一个隔离栈）。
    annotations: [ExternalChange.of(true), Transaction.addToHistory.of(false)],
  });
  // G94：破坏性换入可能命中撤销栈已记录区域 → 重映射会把旧输入/旧回退拼到已改动文本上产出脏内容，作废
  // 受影响的 undo/redo。CM 无「作废单项」钩子，保守清空该 view 的整条 history（宁可多清、不留脏项，tech §5）。
  // undoDepth+redoDepth 为 0 时无可作废，跳过（避免无谓 reconfigure）。
  if (isDestructiveExternal(d) && undoDepth(view.state) + redoDepth(view.state) > 0) {
    clearEditorHistory(view);
  }
  if (highlights.length) {
    setTimeout(() => {
      try {
        view.dispatch({ effects: clearHighlight.of(null) });
      } catch {
        /* view 已卸载 */
      }
    }, HIGHLIGHT_MS);
  }
}

function applyExternalContent(path: string, newContent: string): void {
  dispatchExternal(path, newContent);
  // 同步成对推 content+base（承重不变量见上）。base 推进到 newContent 仅当 newContent 已是磁盘版
  // （场景一直接同步、合并后已落盘的情形）；合并未落盘时只推 content、base 由 flush 写成功后推进。
  patchFile(path, { content: newContent, lastSyncedContent: newContent });
}

/**
 * 把某 path 的 pending 落盘；成功后推进其 lastSyncedContent（base）到刚写出的内容。
 *
 * pending 在 await 之前就同步取出（`p`），所以即便调用方（close）随后同步销了桶，这次写仍会落盘——不丢内容。
 *
 * base 推进的守卫用**开桶代际**而非桶对象同一性（见 openGen 注释）：写盘成功后磁盘就是 p.content，base 该
 * 反映这份「已知磁盘态」，自写回声据此 `disk === base` 判 no-op、不再被当外部改动弹卡。仅当桶仍在、且开桶
 * 代际与写前一致才推进——用户在 await 期间继续打字不换代际（应推进）；关掉重开同 path 会换代际（过期写不污染
 * 新会话的 base，CLAUDE.md「await 后重检」）。
 */
async function flushPlainInner(path: string, mark?: 'manual'): Promise<boolean> {
  clearTimerFor(path);
  const p = pendings.get(path);
  if (!p) return true; // 无 pending 视作已落盘（成功）
  pendings.delete(path);
  const gen = openGen.get(path);
  try {
    await writeDisk(p.ref, path, p.content, { mark });
  } catch {
    return false; // 落盘失败（磁盘满等）——不更新基线，调用方据此重排
  }
  if (canAdvanceBase(path, gen)) patchFile(path, { lastSyncedContent: p.content });
  return true;
}

/**
 * 合并感知的落盘（S27 · G87，取代此前 autosave 的裸 last-writer-wins flush）——收口所有「用户侧笔进锁」：
 * 带 baseline+mergeOnStale，磁盘现状 !== baseline 时由**锁内**机械合并，渲染端不再赌自己读到的磁盘是最新。
 *  - written：磁盘 = 我写的（AI 没抢在前）→ 推进 base；
 *  - merged：锁内合并了 AI 刚落版 → 磁盘 = 合并产物，view+base 换入（第二张图 Apply）；
 *  - discarded：撞同段 → 磁盘一字未动（= AI 版），开冲突卡（第二张图 Card）。
 * baseline 缺省取当前 lastSyncedContent；syncFromDisk 的「已按磁盘 disk 合并」路径传 baseline=disk，
 * 让锁内对同一 disk 不重复合并（cur===baseline → 普通写），仅当 AI 二次抢写才真三方合并。
 */
async function flushMergeInner(path: string, opts?: { mark?: 'manual'; baseline?: string }): Promise<boolean> {
  // 冲突卡展开期间不落盘：编辑冻结、base 冻结，写会与用户正在裁决的卡内容打架（收尾由 resolveOneConflict 接）。
  if (conflictState.has(path)) return true;
  clearTimerFor(path);
  const p = pendings.get(path);
  if (!p) return true;
  const base = opts?.baseline ?? useEditorStore.getState().files[path]?.lastSyncedContent;
  if (base === undefined) {
    // 桶已销（关标签收尾等）——无处合并/开卡，退化为普通落盘保住 pending（不丢），不推进不存在的 base
    return flushPlainInner(path, opts?.mark);
  }
  pendings.delete(path);
  const gen = openGen.get(path);
  let res: FsMdSavedEvent;
  try {
    res = await writeDisk(p.ref, path, p.content, {
      mark: opts?.mark,
      baseline: { content: base },
      mergeOnStale: true,
    });
  } catch {
    return false; // 落盘失败——不更新基线，调用方据此重排
  }
  const kind = res.result ?? 'written';
  if (kind === 'written') {
    if (canAdvanceBase(path, gen)) patchFile(path, { lastSyncedContent: p.content });
    return true;
  }
  if (kind === 'merged') {
    // 磁盘 = 合并产物（含 AI 刚落版 + 我的改动）；view+base 换入。写盘 await 期间用户又打字则 gen 不变、
    // applyExternalContent 以最小 diff 换入保光标（与既有 场景二 同范式，残余竞态口径一致）。
    // merged 契约必携 content（protocol/handler 保证）；万一缺省则不换入（base 不推进，下次广播自愈）——
    // 不回退成 p.content（那是合并前版、会把 AI 改动丢掉）。
    if (canAdvanceBase(path, gen) && res.content !== undefined) applyExternalContent(path, res.content);
    return true;
  }
  // discarded：撞同段——磁盘 = AI 版（锁一字未写）。
  // memory 后端无冲突卡界面：不动用户本地 content（保住不丢），把 base 重定到 Oru 版（res.content），
  // 重排 autosave——下轮 base==Oru 版，mergeOnStale 再合，用户编辑最终落地（符合「discarded 不静默丢」）。
  // 档案无冲突卡限频：Oru 持续抢写同段时，本地每 800ms（autosave 去抖）重试一次三方合并，直到一方停手——
  // 自愈、非紧循环（1 写/800ms），且给 discarded-then-idle 一个崩溃前落地窗口。故意不加退避计数（克制）。
  if (p.ref.kind === 'memory') {
    if (canAdvanceBase(path, gen) && res.content !== undefined) {
      patchFile(path, { lastSyncedContent: res.content }); // 只推 base，不碰 content（保住用户本地）
      const cur = useEditorStore.getState().files[path];
      if (cur) scheduleAutosave(p.ref, path, cur.content); // 用当前本地内容再合一轮
    }
    return true;
  }
  // ↓ 以下是项目后端 discarded 逻辑，memory 分支在上方 return，不会触达
  // 有 view → 开冲突卡让用户裁决；
  // 无 view（非活跃标签/关标签收尾）→ S29·G90⑤ 弃写降级：没有消费者开不了卡，但字不能跟着没——把在途内容
  // 降级写进历史打 discarded 标（可找回、发「可找回」信号），磁盘保留 AI 版（不 last-writer-wins 盖掉它）。
  // 随后读回磁盘 AI 版推进 base（best-effort），避免 base 停在旧版下次再撞同段。
  if (!getEditorView(path)) {
    void wsClient
      .request({ type: 'fileHistory.recordDiscarded', projectId: p.ref.kind === 'project' ? p.ref.projectId : '', path, content: p.content })
      .catch(() => {});
    try {
      const disk = await readDisk(p.ref, path);
      if (canAdvanceBase(path, gen)) patchFile(path, { lastSyncedContent: disk, content: disk });
    } catch {
      /* 读盘失败：base 不推进，下次广播自愈 */
    }
    return true;
  }
  await openConflictCard(path, base, p.content);
  return true; // 弃写不算落盘失败：base 未过期变化前重排会拿旧 base 再撞一次，无益
}

/**
 * 切回 / 收到命中广播时的同步与三方合并（§3.2/§3.3）——必在 per-path 队列内跑（直调 flushPlainInner，不再 enqueue）。
 *  - 无本地编辑 → 场景一：磁盘最新原地落入、保光标。
 *  - 有本地编辑 + 磁盘=base（外部没真变）→ flush 本地。
 *  - 有本地编辑 + 外部也改 → diff3(base, mine, theirs)：不同段自动合并（场景二，写盘+推 base）；
 *    同段冲突 → 本期本地优先兜底（对照卡块②续作，theirs 由 overwrite-guard 进历史）。
 */
// 展开冲突对照卡期间的 per-path 状态：未解决段数 + 期间是否又收到 Oru 改动（解决后重合一次）；
// S29·G90 加：projectId + 开卡时双方版本入历史回的两版 id（收起补标用）+ 各段裁决动作（聚合出口）。
type ConflictEntry = {
  remaining: number;
  pendingTheirs: boolean;
  projectId: string;
  mineId: string;
  theirsId: string;
  actions: ConflictAction[];
};
const conflictState = new Map<string, ConflictEntry>();
let conflictSeq = 0;

/**
 * S29·G90 通知主进程冲突卡收起：撤登记 + 按出口补标（落选补 conflict-losing）+ 起新轮交回被挂起的 AI 写入。
 * fire-and-forget——历史簿记/交回不阻塞本地已完成的裁决；簿记失败无害（本地内容已落定）。
 */
function notifyConflictResolved(path: string, st: ConflictEntry, outcome: ConflictOutcome): void {
  void wsClient
    .request({
      type: 'conflictCard.resolved',
      projectId: st.projectId,
      path,
      outcome,
      mineId: st.mineId,
      theirsId: st.theirsId,
    })
    .catch(() => {});
}

/** 该 path 是否正展开冲突对照卡（供 syncFromDisk 排队判定）。 */
export function hasOpenConflict(path: string): boolean {
  return conflictState.has(path);
}

async function syncFromDiskInner(path: string): Promise<void> {
  const f = useEditorStore.getState().files[path];
  if (!f) return;
  // 冲突卡展开期间再收到命中（§4.3）：只标记 pendingTheirs，不替换卡内容、不起新冲突——解决后重合一次。
  if (conflictState.has(path)) {
    conflictState.get(path)!.pendingTheirs = true;
    return;
  }
  // IME 组合中：推迟同步，避免 dispatchExternal 改 view doc 打断候选词（compositionend 后由 noteCompositionEnd 补跑）。
  if (getEditorView(path)?.composing) {
    composingSyncDeferred.add(path);
    return;
  }
  const base = f.lastSyncedContent;
  const mine = f.content;
  if (!pendings.has(path) && mine === base) {
    // 场景一：无本地编辑 → 读盘、外部改过则原地换入保光标
    let disk: string;
    try {
      disk = await readDisk(f.ref, path);
    } catch {
      return; // 文件被删/读失败——保留当前 content
    }
    // await（读盘）后重检（CLAUDE.md/§6）：桶可能被关/换文档（含同 path 换项目，靠 docId 挡）
    const cur = useEditorStore.getState().files[path];
    if (!cur || docId(cur.ref) !== docId(f.ref)) return;
    if (!pendings.has(path) && cur.content === cur.lastSyncedContent) {
      // 读盘期间没打字 → 纯显示刷新；否则（下面）落到合并支，让用户输入不被磁盘版盖掉
      if (disk !== cur.content) applyExternalContent(path, disk);
      return;
    }
    // 读盘期间用户开始打字（出现 pending）→ 落到合并支（await 后重检回归，用户输入不丢）
  }
  // 有本地编辑（pending 或 content≠base，如冲突解决后）→ 走**锁内**机械合并（§4）：不在渲染端赌
  // 「我读到的磁盘是最新」，把 base+mine 交给锁，磁盘现状为 theirs 一次算完（写/合并换入/弃写开卡）。
  const cur2 = useEditorStore.getState().files[path];
  if (!cur2) return;
  if (!pendings.has(path)) pendings.set(path, { ref: cur2.ref, content: cur2.content });
  const ok = await flushMergeInner(path);
  if (!ok) scheduleAutosave(cur2.ref, path, cur2.content); // 落盘失败：重排重试，避免 base 与磁盘错位
}

/**
 * 撞同段（锁内判 discarded）后开冲突对照卡（第二张图 Card）：磁盘 = AI 版（锁一字未写），renderer 读盘
 * 重算 diff3 取冲突段落卡。view 原地落入 merged（非冲突段自动并、冲突段留 mine 版）、base 冻结不推进，
 * 直到所有段解决——保证下次合并仍以正确 base 计算。无 view（关标签收尾弃写）→ S27 未接弃写降级（归 S29）。
 */
async function openConflictCard(path: string, base: string, mine: string): Promise<void> {
  const f = useEditorStore.getState().files[path];
  if (!f) return;
  let disk: string;
  try {
    disk = await readDisk(f.ref, path);
  } catch {
    return;
  }
  const cur = useEditorStore.getState().files[path];
  if (!cur || docId(cur.ref) !== docId(f.ref)) return;
  const { merged, conflicts } = diff3(base, mine, disk);
  const view = getEditorView(path);
  if (!view) return; // 无处展卡（关标签收尾）→ 弃写降级归 S29，S27 不接
  if (conflicts.length === 0) {
    // 读盘重算已无冲突（AI 在锁返回与本次读盘间又改成不撞了）→ 重排一次，让合并支重跑落盘。
    // 用 cur.content（读盘 await 期间用户可能又打字）而非传入的旧 mine，否则会用旧内容盖掉新输入。
    scheduleAutosave(cur.ref, path, cur.content);
    return;
  }
  // S29·G90①③ 开卡即把双方版本入历史（打 conflict-version，防收起前崩溃丢从未落盘的 mine）+ 登记未决冲突
  // （AI 后续写入据此并行 defer）。await 拿回两版 id 供收起补标；簿记失败仍开卡——本地裁决不阻塞，补标/交回会
  // 因空 id 静默降级（历史里仍有 discarded/ai 兜底可找回）。
  let ids = { mineId: '', theirsId: '' };
  try {
    const res = await wsClient.request<ConflictOpenedResult>({
      type: 'conflictCard.opened',
      projectId: cur.ref.kind === 'project' ? cur.ref.projectId : '',
      path,
      mine,
      theirs: disk,
    });
    ids = { mineId: res.mineId, theirsId: res.theirsId };
  } catch {
    /* 簿记失败：仍开卡 */
  }
  // await 后重检（§6）：开卡簿记的 WS 往返含主进程磁盘 IO，期间用户可能关标签/改名把桶销掉——此时 close/
  // relocate 因 conflictState 尚无本 path 入口，跳过了撤登记。若不在这里补救，主进程 openConflicts 会永久
  // 泄漏该文件（AI 写入永久 defer）、且下面会写出一个绑在已销桶上的孤儿 conflictState（编辑器冻结）。
  const fresh = useEditorStore.getState().files[path];
  if (!fresh || docId(fresh.ref) !== docId(cur.ref)) {
    void wsClient
      .request({ type: 'conflictCard.resolved', projectId: cur.ref.kind === 'project' ? cur.ref.projectId : '', path, outcome: 'cancelled', ...ids })
      .catch(() => {});
    return;
  }
  dispatchExternal(path, merged);
  patchFile(path, { content: merged });
  conflictState.set(path, {
    remaining: conflicts.length,
    pendingTheirs: false,
    projectId: cur.ref.kind === 'project' ? cur.ref.projectId : '',
    mineId: ids.mineId,
    theirsId: ids.theirsId,
    actions: [],
  });
  const batch = conflictSeq++;
  const specs: ConflictSpec[] = conflicts.map((c, i) => ({
    id: `conflict-${batch}-${i}`,
    from: c.range.from,
    to: c.range.to,
    mineText: c.mineText,
    theirsText: c.theirsText,
    onResolve: (action) => resolveOneConflict(path, action),
  }));
  view.dispatch({ effects: addConflicts.of(specs) });
}

/**
 * 一个冲突段落定后的收尾（conflictField 的按钮回调触达）：解决事务已同步改了 view doc。
 * 还有未解决段则仅记账；全部解决 → 落盘落定结果：
 *  - 无新改动 → 普通写（权威落定用户的选择、推 base=resolved）；
 *  - 期间 Oru 又改过（pendingTheirs）→ 以冻结旧 base 走锁内合并，若 Oru 又改了刚解决的同段 → 锁判 discarded
 *    再起一张卡让你决定（绝不静默用磁盘版盖掉你的选择），改别处则自动并。
 */
function resolveOneConflict(path: string, action: ConflictAction): void {
  const st = conflictState.get(path);
  if (!st) return;
  st.actions.push(action);
  st.remaining -= 1;
  if (st.remaining > 0) return;
  conflictState.delete(path);
  // S29·G90② 聚合出口：全选我的 → mine（theirs 整份落选、补 conflict-losing）；全选 Oru 的 → theirs（mine 落选）；
  // 其余 → both。both 承载两种「无单一落选方」的情形：真手动拼合、以及跨段混选（一段选我一段选它）——都没有一个
  // 整体落选的版本可补标，故双方都留 conflict-version。收起即通知主进程补标 + 起新轮交回 AI。
  const outcome = st.actions.every((a) => a === 'mine')
    ? 'mine'
    : st.actions.every((a) => a === 'theirs')
      ? 'theirs'
      : 'both';
  notifyConflictResolved(path, st, outcome);
  void enqueue(path, async () => {
    const view = getEditorView(path);
    const cur = useEditorStore.getState().files[path];
    if (!cur) return;
    const resolved = view ? view.state.doc.toString() : cur.content; // 落定结果取 view 当前 doc（同步、不等 onChange 回填）
    patchFile(path, { content: resolved });
    pendings.set(path, { ref: cur.ref, content: resolved });
    if (st.pendingTheirs) {
      await flushMergeInner(path); // 冻结旧 base 走锁内合并：同段再撞 → discarded 重开卡，改别处自动并
    } else {
      await flushPlainInner(path); // 无新改动：权威落定结果写盘 + 推 base=resolved
    }
  });
}

export const useEditorStore = create<EditorState>((set, get) => ({
  files: {},

  async open(projectId, path) {
    // 兼容 API：构造 project DocRef 委托 openRef
    return this.openRef({ kind: 'project', projectId, path });
  },

  async openRef(ref) {
    const key = refKey(ref);
    const path = ref.kind === 'project' ? ref.path : ref.relPath;
    const existing = get().files[key];
    // 已有同文档的桶（已加载）→ 重开即切过去，保留现场，不重读不重置
    if (existing && refKey(existing.ref) === key && !existing.loading) return;

    set({ files: { ...get().files, [key]: { ref, content: '', lastSyncedContent: '', loading: true } } });
    openGen.set(key, ++genSeq); // 新会话开桶：代际自增，让在途的过期 flush 据此放弃推进 base（见 flushPlainInner）
    let disk: string;
    try {
      disk = await readDisk(ref, path);
    } catch {
      patchFile(key, { loading: false });
      return;
    }
    // await 间该桶可能被关/改名/换文档
    const cur = get().files[key];
    if (!cur || refKey(cur.ref) !== key) return;
    patchFile(key, { content: disk, lastSyncedContent: disk, loading: false });
    setSampling(ref, path, true);
  },

  setContent(key, content) {
    const f = get().files[key];
    if (!f) return;
    patchFile(key, { content });
    scheduleAutosave(f.ref, key, content);
  },

  async flush(path) {
    await enqueue(path, () => flushMergeInner(path)); // 失焦/切文件立即落 → 走锁内合并，别 last-writer-wins 盖掉 AI
  },

  async flushAll() {
    // AI 动手 / 改名前：把所有打开编辑器的 pending 落盘，保证主进程读盘即最新（各 path 各自串行）
    await Promise.all([...pendings.keys()].map((p) => enqueue(p, () => flushMergeInner(p))));
  },

  async manualSnapshot(key) {
    // ⌘S 此刻的版本要留底——在入队**前**同步捕获快照，不依赖 op 执行时桶仍在
    // （否则「⌘S 后立即关标签」时 close 已同步删桶、op 读不到桶 → manual 留底静默丢失）。
    const f = get().files[key];
    if (!f) return;
    const { ref, content } = f;
    const path = ref.kind === 'project' ? ref.path : ref.relPath;
    const gen = openGen.get(key); // 与 content 同点捕获：⌘S 后若关重开同 key，代际变 → 不推进（与 flushPlainInner 同守卫）
    // 入队串行：⌘S 留底与 autosave/合并争用 base，必须排队（§6）
    await enqueue(key, async () => {
      clearTimerFor(key);
      pendings.delete(key);
      try {
        await writeDisk(ref, path, content, { mark: 'manual' });
      } catch {
        return;
      }
      if (canAdvanceBase(key, gen)) patchFile(key, { lastSyncedContent: content });
    });
  },

  async syncFromDisk(path) {
    await enqueue(path, () => syncFromDiskInner(path));
  },

  noteCompositionEnd(path) {
    // IME 组合结束：组合期 scheduleAutosave 只记了 pending 没计时——这里正式排盘；并补跑被推迟的同步。
    if (pendings.has(path) && !timers.has(path)) armAutosave(path);
    if (composingSyncDeferred.delete(path)) void get().syncFromDisk(path);
  },

  async restoreFromHistory(key, snapshotId) {
    await enqueue(key, async () => {
      const f = useEditorStore.getState().files[key];
      if (!f) return;
      const path = f.ref.kind === 'project' ? f.ref.path : f.ref.relPath;
      // 先把未落盘的本地编辑落盘——否则它既没进磁盘、也没被 main 侧 pre-restore 兜进历史，会静默丢（不丢承诺）
      await flushPlainInner(key);
      clearTimerFor(key);
      pendings.delete(key);
      if (f.ref.kind === 'memory') {
        // 档案后端：走 memory.history.restore（后端落盘回退 + 广播 memory.doc.changed）
        const r = await wsClient.request<MemoryHistoryRestoredEvent>({
          type: 'memory.history.restore',
          relPath: f.ref.relPath,
          snapshotId,
        });
        if (r.type !== 'memory.history.restored') return;
        const cur = useEditorStore.getState().files[key];
        if (!cur || refKey(cur.ref) !== refKey(f.ref)) return;
        applyExternalContent(key, r.content); // content+lastSynced 同步推进（与项目分支同款收尾）
        return;
      }
      // 项目后端：走既有 fileHistory.restore
      const res = await wsClient.request<FileHistoryRestoredEvent>({
        type: 'fileHistory.restore',
        projectId: f.ref.projectId,
        path,
        snapshotId,
      });
      if (res.type !== 'fileHistory.restored') return;
      const cur = useEditorStore.getState().files[key];
      if (!cur || refKey(cur.ref) !== refKey(f.ref)) return;
      applyExternalContent(key, res.content); // 半受控：恢复版经 view dispatch 落入（光标随 diff 映射，大改时落点可能偏移）
    });
  },

  relocate(oldRel, newRel, newContent) {
    const files = get().files;
    const nextFiles: Record<string, EditorFileState> = {};
    let changed = false;
    for (const [path, f] of Object.entries(files)) {
      const next = relocateUnder(path, oldRel, newRel);
      if (next === null) {
        nextFiles[path] = f;
        continue;
      }
      changed = true;
      // 正展开冲突卡时改名：清掉本 view 的卡 + conflictState（其 onResolve 闭包捕获旧 path、迁移后会失效）。
      // 卡内容（merged，冲突段留 mine 版）仍在文档里，下次命中广播会以新 path 正确重新起卡。
      const stc = conflictState.get(path);
      if (stc) {
        const view = getEditorView(path);
        if (view) view.dispatch({ effects: clearAllConflicts.of(null) });
        conflictState.delete(path);
        notifyConflictResolved(path, stc, 'cancelled'); // 撤主进程登记，别让该文件 AI 写入永久 defer
      }
      // 迁移 pending 的 key（否则 pending 会落回旧路径）。timer 闭包捕获的是旧 path，
      // 不能直接搬句柄（搬了触发也是 flushPath(旧path) no-op）——清掉旧 timer，按 next 重排一个新 timer。
      const pend = pendings.get(path);
      const hadTimer = timers.has(path);
      clearTimerFor(path);
      if (pend) {
        pendings.delete(path);
        pendings.set(next, pend);
        if (hadTimer) scheduleAutosave(pend.ref, next, pend.content);
      }
      // openGen 只删旧键即可：迁移后新 path 的 reopen 防护由 flushPlainInner 的 `files[path]` 守卫提供
      // （旧 path 的在途过期写在那里就被判死，够不到新 path）；故无需迁移代际值或重新发号。
      // composingSyncDeferred 则随 key 迁移（与 pending 同范式），不丢被推迟的那次同步。
      openGen.delete(path);
      if (composingSyncDeferred.delete(path)) composingSyncDeferred.add(next);
      // project ref 的 path 随桶键迁移到 next，保持 ref.path 与桶键一致（memory ref 无 path 维度，原样搬）
      const movedRef: DocRef = f.ref.kind === 'project' ? { ...f.ref, path: next } : f.ref;
      if (newContent !== undefined && path === oldRel) {
        // 改名联动回写：磁盘已是回写版，内存旧引用（含未落盘 pending）一律作废，路径迁移 + 内容替换原子完成
        clearTimerFor(next);
        pendings.delete(next);
        nextFiles[next] = { ...f, ref: movedRef, content: newContent, lastSyncedContent: newContent };
      } else {
        nextFiles[next] = { ...f, ref: movedRef };
      }
    }
    if (changed) set({ files: nextFiles });
  },

  closeIfUnder(path) {
    for (const p of Object.keys(get().files)) {
      if (isUnder(p, path)) get().close(p);
    }
  },

  close(path) {
    const stc = conflictState.get(path);
    if (stc) notifyConflictResolved(path, stc, 'cancelled'); // 关标签未裁决就撤卡：撤主进程登记 + 交回被挂起的 AI 写入
    conflictState.delete(path); // 清协同冲突态——否则重开同 path 后 syncFromDisk 永久排队、外部改动不可见
    composingSyncDeferred.delete(path);
    openGen.delete(path); // 在途的过期 flush 仍安全：flushPlainInner 的 `&& files[path]` 守门（桶已销→不推 base）
    void enqueue(path, () => flushMergeInner(path)); // 关闭前把 pending 落盘（hot exit）：桶已销时 flushMergeInner 退化为普通写保住内容
    const f = get().files[path];
    if (f) setSampling(f.ref, f.ref.kind === 'project' ? f.ref.path : f.ref.relPath, false);
    clearTimerFor(path);
    const { [path]: _removed, ...rest } = get().files;
    void _removed;
    set({ files: rest });
  },
}));

// 标签关闭 → 销毁该 md 的桶（flush 未落盘内容后销毁）。见 workspaceStore.registerTabCloser。
registerTabCloser('editor', (ref) => useEditorStore.getState().close(ref));

/**
 * 订阅统一变更广播（块①）：命中 filePath 的打开文档桶 → syncFromDisk，让「AI 落盘即时可见」成立
 * （tech §2.1，替代原来只在失焦/切回时才同步）。只认文件级 filePath（树操作无此字段、不误触）；
 * 本地无改动则 applyExternalContent 原地更新保光标，本地有改动则本地优先（merge 见块②）。
 * 自己保存回声（writeMd 也带 filePath）落到「content===lastSynced」→ 读盘一致 → no-op，无害。
 */
let editorSyncUnsub: (() => void) | null = null;
export function bindEditorAutoSync(): void {
  if (editorSyncUnsub) return;
  editorSyncUnsub = wsClient.subscribe((ev: ServerEvent) => {
    if (ev.type !== 'fs.changed' || !ev.filePath) return;
    const f = useEditorStore.getState().files[ev.filePath];
    // project 文件 key===path，且 projectId 需匹配；memory 文件 key 以 'mem:' 开头，ev.filePath 不会命中
    if (f && f.ref.kind === 'project' && f.ref.projectId === ev.projectId) {
      void useEditorStore.getState().syncFromDisk(ev.filePath);
    }
  });
}

/** 测试用：解订阅 + 清模块级 guard，让下个用例能重新 bind（与 projects/store 的 __clearCacheForTest 同范式）。 */
export function __resetEditorAutoSyncForTest(): void {
  editorSyncUnsub?.();
  editorSyncUnsub = null;
}

/** 测试用：清协同冲突态，杜绝跨用例泄漏（conflictState 是模块级）。 */
export function __resetConflictStateForTest(): void {
  conflictState.clear();
}
