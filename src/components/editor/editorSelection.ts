/**
 * 编辑器当前选区的注册表——随手评点（aside）解析"编辑器里选中、⌥点编辑器外"用：
 * 焦点移走后 window.getSelection() 未必还能读到 CodeMirror 内部选区，由 MdEditor
 * 挂载时注册 getter（与选段「加入对话」同一来源：view.state.selection.main）。
 *
 * 用 Set 而非单 getter：EditorPane 与 deck 文稿页（NarrativeTab）各渲染一个 MdEditor，
 * 单槽位会在卸载顺序交错时把活着的那个注销掉。
 */
const getters = new Set<() => string>();

/** 注册一个选区 getter；返回注销函数（与注册同处可见，useEffect cleanup 直接 return 它） */
export function registerEditorSelectionGetter(getter: () => string): () => void {
  getters.add(getter);
  return () => {
    getters.delete(getter);
  };
}

/** 取首个非空的编辑器选区；没有编辑器在场或都没选中则返回空串 */
export function getEditorSelectionText(): string {
  for (const getter of getters) {
    const text = getter();
    if (text.trim()) return text;
  }
  return '';
}
