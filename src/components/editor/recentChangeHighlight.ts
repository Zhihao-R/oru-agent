/**
 * 「Oru 刚改过」段落高亮（块②·PRD 场景一·文档，tech §3.2）。
 *
 * editorStore 把 theirs 的改动经 view.dispatch 落入文档时，记录其插入/替换命中的区间，挂一层约 2 秒后
 * 自动消退的淡强调底色 mark decoration——让你一眼看到此处刚被改动，又不长时间停留。区间随后续编辑用
 * mapPos 跟踪；2 秒移除由 dispatch 端（editorStore.dispatchExternal）排 timer 后发 clearHighlight。
 */
import { StateField, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

export const addHighlight = StateEffect.define<Array<{ from: number; to: number }>>();
export const clearHighlight = StateEffect.define<null>();

const mark = Decoration.mark({ class: 'oru-recent-change' });

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes); // 后续编辑移动高亮区间
    for (const e of tr.effects) {
      if (e.is(clearHighlight)) deco = Decoration.none;
      else if (e.is(addHighlight)) {
        const ranges = e.value.filter((r) => r.to > r.from).map((r) => mark.range(r.from, r.to));
        if (ranges.length) deco = deco.update({ add: ranges, sort: true });
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlightTheme = EditorView.baseTheme({
  '.oru-recent-change': {
    backgroundColor: 'var(--accent-soft)',
    borderRadius: '2px',
    animation: 'oru-recent-fade 2s ease-out forwards',
  },
  '@keyframes oru-recent-fade': {
    '0%': { backgroundColor: 'var(--accent-soft)' },
    '70%': { backgroundColor: 'var(--accent-soft)' },
    '100%': { backgroundColor: 'rgba(0, 0, 0, 0)' },
  },
});

/** 编辑器扩展：装上「刚改过」高亮（StateField + 渐隐主题）。 */
export function recentChangeHighlight(): Extension {
  return [highlightField, highlightTheme];
}

/** 高亮停留时长（ms）——dispatch 端据此排移除 timer，与渐隐动画对齐。 */
export const HIGHLIGHT_MS = 2000;
