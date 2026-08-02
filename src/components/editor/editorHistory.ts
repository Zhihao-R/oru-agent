/**
 * 编辑器撤销栈（history）的 compartment 化（S27 · G94）。
 *
 * 把 CodeMirror 的 history 扩展装进一个 Compartment，才能在运行时**清空**某个 view 的撤销栈——
 * 外部换入（AI 合并 / 历史恢复）命中用户已记录的编辑区间时，重映射会把旧输入/旧回退重放到已被
 * 改动的文本上，拼出双方都没写过的脏内容；CM 无内建「作废受影响历史项」钩子，故保守清空整条
 * history（宁可多清、不留脏项，tech §5）。清空 = 用一份全新的 history() 重配这个 compartment。
 *
 * 单一 Compartment 实例跨所有 md 编辑器 view 复用（Compartment 只是配置键）。MdEditor 关掉 basicSetup
 * 内建 history、改由本扩展提供；换入本身经 Transaction.addToHistory.of(false) 隔离出栈（在 editorStore）。
 */
import { Compartment } from '@codemirror/state';
import { history } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';

const historyCompartment = new Compartment();

/** 装进 MdEditor extensions；取代 basicSetup 的内建 history（后者需 history:false 关掉）。 */
export function editorHistoryExtension() {
  return historyCompartment.of(history());
}

/**
 * 清空该 view 的撤销栈（换入命中重叠区间时作废受影响的 undo/redo）。未装本扩展的裸 view（测试）→ 跳过。
 * 两步重配：先把 history 撤下（historyField 随扩展移除而丢弃），再装回全新 history()——单纯 history()→history()
 * 重配不清栈，因 historyField 是模块单例、跨 reconfigure 存活；必须让它先消失再重建才是空栈。
 */
export function clearEditorHistory(view: EditorView): void {
  if (historyCompartment.get(view.state) === undefined) return;
  view.dispatch({ effects: historyCompartment.reconfigure([]) });
  view.dispatch({ effects: historyCompartment.reconfigure(history()) });
}
