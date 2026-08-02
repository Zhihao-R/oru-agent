import type { EditorView } from '@codemirror/view';

/**
 * 打开的 md/txt 编辑器 EditorView 按 path 注册表（半受控迁移，tech §3.2）。
 *
 * 编辑器改为半受控后，content 不再由受控 value 反向驱动 view；外部内容变更（AI 落盘合并、
 * 历史恢复）由 editorStore 经此注册表拿到对应 view、直接 view.dispatch 最小变更集落入——
 * 原地更新、光标/滚动随 changeset 自动映射不被打断。仿 editorSelection.ts 的注册表范式：
 * 模块级 Map、注册返回成对的注销闭包（按实例同一性注销，重挂载不误删新实例）。
 *
 * 单值 Map（path→一个 view），假定「一个 path 至多一个挂载中的 MdEditor」——workspaceStore 按
 * `${kind}:${ref}` 去重 tab，同一文件不会开两个 editor 标签，前提成立。唯一可撞 key 的边角是同一
 * `.narrative.md` 既作 deck 文稿、又被当普通 editor 打开；即便如此也不丢数据：未注册的那个 view 仍由
 * 受控 value 的 reconcile 整篇更新（仅丢光标保持），是优雅降级。故不学 editorSelection 上 Set——
 * 那里要「同时查多个不同 path 的可见编辑器」，与本处「按 path 精确取一个 view」是不同需求。
 */
const views = new Map<string, EditorView>();

export function registerEditorView(path: string, view: EditorView): () => void {
  views.set(path, view);
  return () => {
    if (views.get(path) === view) views.delete(path);
  };
}

export function getEditorView(path: string): EditorView | undefined {
  return views.get(path);
}

/** 测试用：清空注册表，杜绝跨用例 view 泄漏。 */
export function __clearEditorViewsForTest(): void {
  views.clear();
}
