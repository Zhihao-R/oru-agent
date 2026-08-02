import { create } from 'zustand';
import { relocateUnder, basename, isUnder } from '@/lib/paths';

/**
 * 右栏多标签工作区的单一真源（tech design §2.2）。
 *
 * 右栏从「一次只开一个查看器」改成「一组标签、各存自己的状态、切走不卸载」。这里只管
 * 「开了哪些标签 + 哪个活跃」；每个查看器自己的状态（内容/排序/页码/标注）由各查看器 store
 * 按 ref 分桶保留（分阶段接入，见 tech design §三）。
 *
 * 同一文件只可能有一个标签：id = `${kind}:${ref}` 唯一 ⇒「已开则切过去、不重复开」天然成立。
 */
export type TabKind = 'editor' | 'html' | 'table' | 'image' | 'deck' | 'pdf' | 'xlsx';

export type Tab = {
  /** 稳定唯一键 `${kind}:${ref}`：标签栏、keep-mounted 面板、各 store 分桶都用它（或其 ref）。 */
  id: string;
  kind: TabKind;
  projectId: string;
  /** 文件类 = 项目相对 path；deck = artifactId。 */
  ref: string;
  /** 文件名 / deck 名（展示用，随重命名更新）。 */
  title: string;
};

/** 由 kind+ref 派生 id，建标签的唯一入口——避免各处手拼 id 形态不一。 */
export function makeTab(spec: Omit<Tab, 'id'>): Tab {
  return { ...spec, id: `${spec.kind}:${spec.ref}` };
}

/**
 * 标签关闭时如何销毁其查看器状态桶（editor/table 的 per-path flush+close 等）。
 * 各查看器 store 在模块加载时注册自己 kind 的 closer——workspaceStore 不反向 import 任何查看器 store，
 * 「加第二个查看器 kind」零成本（只在那个 store 里加一行注册）。image/xlsx 无桶、不注册。
 */
type TabCloser = (ref: string) => void;
const tabClosers: Partial<Record<TabKind, TabCloser>> = {};
export function registerTabCloser(kind: TabKind, fn: TabCloser): void {
  tabClosers[kind] = fn;
}
function destroyBucket(tab: Tab): void {
  tabClosers[tab.kind]?.(tab.ref);
}

/**
 * 活跃标签变化的副作用钩子，**按 kind 注册**（与 registerTabCloser 同构、同对称——加第二个想监听活跃标签
 * 的 kind 零成本，互不覆盖）。deck 用它把后端 activeDeckId 对齐到「活跃标签是哪个 deck / 不是 deck」
 * （tech design §B 真源方向反转）。workspaceStore 不反向 import 任何查看器 store。
 *
 * 派发规则：活跃身份变化时，对「离开的旧活跃 kind」与「进入的新活跃 kind」各派一次，都传**新的活跃标签**
 * （无则 null）。这样 deck→md 时 deck 的 listener 收到 null（推后端归零）、md 的 listener 收到 md 标签。
 */
type ActiveTabListener = (tab: Tab | null) => void;
const activeTabListeners: Partial<Record<TabKind, ActiveTabListener>> = {};
export function registerActiveTabListener(kind: TabKind, fn: ActiveTabListener): void {
  activeTabListeners[kind] = fn;
}

type WorkspaceState = {
  openTabs: Tab[]; // 有序，顺序 = 打开顺序
  activeTabId: string | null;

  /** 已存在则仅切过去，否则 push 到末尾并激活。 */
  openTab: (tab: Tab) => void;
  activateTab: (id: string) => void;
  /** 移除标签；若关的是活跃标签，切右邻（无则左邻，再无则 null）。 */
  closeTab: (id: string) => void;
  /**
   * 原地替换标签（xlsx 预览转编辑=同位置换成 CSV 表格）：newTab.id 已存在 → 关旧标签+激活既有标签；
   * 否则销毁旧桶、同 index 替换并激活。保持标签位置不变是「原地切换」体感的关键。
   */
  replaceTab: (oldId: string, newTab: Tab) => void;
  /** 文件改名/移动时跟随：命中的标签 ref/title/id 迁移，活跃指针随之。 */
  relocateTab: (oldRef: string, newRef: string) => void;
  /** 文件（或其所在目录）被删时，关掉指向它的文件类标签；活跃被关则切邻。deck 标签按 artifactId 不受路径删除影响。 */
  closeTabsUnder: (path: string) => void;
  /** 切项目：清空（标签按项目相对 ref 组织，跨项目无意义，同既有 viewer 清场）。 */
  reset: () => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  /**
   * 统一提交：写 openTabs/activeTabId，并在「活跃标签身份变了」时通知 activeTabListener
   * （deck 据此把后端 activeDeckId 对齐）。一处收口，避免每个 mutator 各自记得调钩子（系统性）。
   */
  function commit(openTabs: Tab[], activeTabId: string | null): void {
    const prev = get();
    const prevActiveKind = prev.openTabs.find((t) => t.id === prev.activeTabId)?.kind;
    set({ openTabs, activeTabId });
    if (activeTabId === prev.activeTabId) return;
    const nextTab = openTabs.find((t) => t.id === activeTabId) ?? null;
    // 对「离开的旧 kind」与「进入的新 kind」各派一次（去重），都传新的活跃标签。
    const kinds = new Set<TabKind>();
    if (prevActiveKind) kinds.add(prevActiveKind);
    if (nextTab) kinds.add(nextTab.kind);
    kinds.forEach((k) => activeTabListeners[k]?.(nextTab));
  }

  return {
    openTabs: [],
    activeTabId: null,

    openTab(tab) {
      const { openTabs } = get();
      if (openTabs.some((t) => t.id === tab.id)) {
        get().activateTab(tab.id); // 不重复开，直接切过去（现场不丢）
        return;
      }
      commit([...openTabs, tab], tab.id);
    },

    activateTab(id) {
      commit(get().openTabs, id);
    },

    closeTab(id) {
      const { openTabs, activeTabId } = get();
      const idx = openTabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      destroyBucket(openTabs[idx]); // 销毁该标签的查看器状态桶（flush 未落盘内容后销毁）
      const next = openTabs.filter((t) => t.id !== id);
      // 删除后 next[idx] 恰是原右邻；无右邻取左邻；再无则空
      const right = next[idx];
      const left = idx > 0 ? next[idx - 1] : undefined;
      const nextActive = activeTabId === id ? (right?.id ?? left?.id ?? null) : activeTabId;
      commit(next, nextActive);
    },

    replaceTab(oldId, newTab) {
      const { openTabs, activeTabId } = get();
      const idx = openTabs.findIndex((t) => t.id === oldId);
      if (idx < 0) return;
      if (openTabs.some((t) => t.id === newTab.id)) {
        // 目标标签已开（csv 早已是标签）：不能 splice 出重复 id——关旧标签、激活既有目标
        destroyBucket(openTabs[idx]);
        const next = openTabs.filter((t) => t.id !== oldId);
        commit(next, activeTabId === oldId ? newTab.id : activeTabId);
        return;
      }
      destroyBucket(openTabs[idx]);
      const next = [...openTabs];
      next[idx] = newTab;
      commit(next, activeTabId === oldId ? newTab.id : activeTabId);
    },

    relocateTab(oldRef, newRef) {
      const { openTabs, activeTabId } = get();
      let changed = false;
      let nextActive = activeTabId;
      const next = openTabs.map((t) => {
        if (t.kind === 'deck') return t; // deck 的 ref 是 artifactId 非路径，不受文件改名波及（同 closeTabsUnder）
        const movedRef = relocateUnder(t.ref, oldRef, newRef);
        if (movedRef === null) return t;
        changed = true;
        const moved = makeTab({ kind: t.kind, projectId: t.projectId, ref: movedRef, title: basename(movedRef) });
        if (activeTabId === t.id) nextActive = moved.id;
        return moved;
      });
      // 改名只换 ref/id、不切「哪个 deck 活跃」（deck 标签跳过 relocate），故不会触发后端同步——commit 仍按身份判等。
      if (changed) commit(next, nextActive);
    },

    closeTabsUnder(path) {
      const { openTabs, activeTabId } = get();
      const doomed = new Set(
        openTabs.filter((t) => t.kind !== 'deck' && isUnder(t.ref, path)).map((t) => t.id),
      );
      if (doomed.size === 0) return;
      openTabs.forEach((t) => doomed.has(t.id) && destroyBucket(t));
      const next = openTabs.filter((t) => !doomed.has(t.id));
      let nextActive = activeTabId;
      if (activeTabId !== null && doomed.has(activeTabId)) {
        const at = openTabs.findIndex((t) => t.id === activeTabId);
        // 从原活跃位置向右找第一个存活标签，无则向左，再无则空
        nextActive =
          openTabs.slice(at + 1).find((t) => !doomed.has(t.id))?.id ??
          [...openTabs.slice(0, at)].reverse().find((t) => !doomed.has(t.id))?.id ??
          null;
      }
      commit(next, nextActive);
    },

    reset() {
      get().openTabs.forEach(destroyBucket); // 切项目：销毁所有桶（flush 未落盘内容）
      commit([], null);
    },
  };
});
