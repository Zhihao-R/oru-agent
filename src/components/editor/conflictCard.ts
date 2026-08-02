/**
 * 冲突对照卡（块②·PRD 场景二「改到同一处」，tech §4）。
 *
 * 你和 Oru 改了同一段时，该段在编辑器内**原地**展开为一张上下对照卡（CM block widget 替换冲突区间）：
 * 上「你的改动」、下「Oru 的改动」，三动作「用我的 / 用 Oru 的 / 两个都留」。
 *  - 冻结：transactionFilter 拒绝落在冲突区间内的改动（区间外照常编辑、照常 autosave）。
 *  - 定位：持创建时的 range，随后续编辑用 CM 的 mapPos 跟踪（不靠 posAtDOM——block widget 内子元素
 *    posAtDOM 会坍缩到 widget 起点，见记忆《CM block widget posAtDOM 坍缩》）。三动作回调直接用跟踪到的 range 生成 changeset。
 *  - 解决：替换冲突区间为所选文本 + 移除 widget + 解冻；onResolve 回调通知 editorStore 推进 base / 处理排队的 theirs。
 */
import { StateField, StateEffect, EditorState, Annotation, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { ExternalChange } from '@uiw/react-codemirror';
// 非 React 的 CM widget：拿不到 useTranslation hook，直调 i18n 单例（toDOM 渲染时取当前语言）。
// 代价：切语言不 live 重渲染，随 widget 下次重建（编辑/装饰变化）才更新——低频动作，可接受。
import i18n from '@/lib/i18n';
import { addHighlight, clearHighlight, HIGHLIGHT_MS } from './recentChangeHighlight';

export type ConflictAction = 'mine' | 'theirs' | 'both';

export type ConflictSpec = {
  /** 同一文档内唯一；用于映射后定位与移除。 */
  id: string;
  /** 冲突区间（merged 坐标 = 应用 merged 后的 view 坐标），随后续编辑由 StateField 用 mapPos 跟踪。 */
  from: number;
  to: number;
  mineText: string;
  theirsText: string;
  /** 解决后通知上层（editorStore：推进 base、处理 pendingTheirs）。 */
  onResolve: (action: ConflictAction) => void;
};

// 标记「冲突解决」事务——绕过冻结 filter（解决本身要改冲突区间）。
const conflictResolveAnnotation = Annotation.define<boolean>();

export const addConflicts = StateEffect.define<ConflictSpec[]>();
const removeConflictEffect = StateEffect.define<string>();
/** 清掉本 view 的全部冲突卡（改名等场景：editorStore 同步清 conflictState，避免孤立卡 + 死按钮）。 */
export const clearAllConflicts = StateEffect.define<null>();

/** 三动作的落定文本：用我的=mine、用 Oru 的=theirs、两个都留=mine 顺次接 theirs。 */
export function resolvedText(spec: Pick<ConflictSpec, 'mineText' | 'theirsText'>, action: ConflictAction): string {
  if (action === 'mine') return spec.mineText;
  if (action === 'theirs') return spec.theirsText;
  return spec.mineText + spec.theirsText;
}

// 按 id 查 field 里**当前**（已被后续编辑 mapPos 跟踪过）的 spec 再生成 changeset——
// 不用 widget 捕获时的旧坐标（widget 的 eq 忽略 from/to，CM 会复用旧 DOM，捕获坐标已过期）。
function applyResolution(view: EditorView, id: string, action: ConflictAction): void {
  const cur = view.state.field(conflictField, false)?.specs.find((s) => s.id === id);
  if (!cur) return;
  const insert = resolvedText(cur, action);
  // 解决后：替换冲突区间为所选文本 + 移除卡 + 给落定区间挂「最近修改」accent 淡底（与 Oru 落盘同一套 2s 渐隐）。
  view.dispatch({
    changes: { from: cur.from, to: cur.to, insert },
    effects: [removeConflictEffect.of(id), addHighlight.of([{ from: cur.from, to: cur.from + insert.length }])],
    annotations: conflictResolveAnnotation.of(true),
  });
  // 2s 后清高亮（与渐隐动画对齐）——view 已卸载则 dispatch 静默失败。
  setTimeout(() => {
    try {
      view.dispatch({ effects: clearHighlight.of(null) });
    } catch {
      /* view 已销毁 */
    }
  }, HIGHLIGHT_MS);
  cur.onResolve(action);
}

class ConflictWidget extends WidgetType {
  constructor(readonly spec: ConflictSpec) {
    super();
  }
  eq(other: ConflictWidget): boolean {
    return (
      other.spec.id === this.spec.id &&
      other.spec.mineText === this.spec.mineText &&
      other.spec.theirsText === this.spec.theirsText
    );
  }
  ignoreEvent(): boolean {
    return true; // 卡内按钮/选择事件不冒泡给 CM（否则点按钮被当编辑器交互）
  }
  get estimatedHeight(): number {
    return -1;
  }
  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement('div');
    card.className = 'oru-conflict-card';

    // 左侧琥珀竖标（并行修改的告警语义，非破坏、非 accent）
    const bar = document.createElement('span');
    bar.className = 'oru-conflict-bar';
    card.appendChild(bar);

    // 头行：eyebrow「编辑冲突」+ 冻结说明
    const head = document.createElement('div');
    head.className = 'oru-conflict-head';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'oru-conflict-eyebrow';
    eyebrow.textContent = i18n.t('editor:conflict.title');
    const note = document.createElement('span');
    note.className = 'oru-conflict-note';
    note.textContent = i18n.t('editor:conflict.freezeNote');
    head.append(eyebrow, note);
    card.appendChild(head);

    const cols = document.createElement('div');
    cols.className = 'oru-conflict-cols';
    cols.appendChild(side(i18n.t('editor:conflict.mineLabel'), this.spec.mineText, 'mine'));
    cols.appendChild(side(i18n.t('editor:conflict.theirsLabel'), this.spec.theirsText, 'theirs'));
    card.appendChild(cols);

    const actions = document.createElement('div');
    actions.className = 'oru-conflict-actions';
    actions.appendChild(actionBtn(i18n.t('editor:conflict.useMine'), () => applyResolution(view, this.spec.id, 'mine'), false));
    // 「用 Oru 的」为默认建议动作：accent-deep + ac-line 下划线
    actions.appendChild(actionBtn(i18n.t('editor:conflict.useTheirs'), () => applyResolution(view, this.spec.id, 'theirs'), true));
    actions.appendChild(actionBtn(i18n.t('editor:conflict.keepBoth'), () => applyResolution(view, this.spec.id, 'both'), false));
    const hint = document.createElement('span');
    hint.className = 'oru-conflict-hint';
    hint.textContent = i18n.t('editor:conflict.freezeHint');
    actions.appendChild(hint);
    card.appendChild(actions);

    return card;
  }
}

function side(label: string, text: string, kind: 'mine' | 'theirs'): HTMLElement {
  const row = document.createElement('div');
  row.className = `oru-conflict-side oru-conflict-${kind}`;
  const head = document.createElement('span');
  head.className = 'oru-conflict-label';
  head.textContent = label;
  const body = document.createElement('pre');
  body.className = 'oru-conflict-text';
  body.textContent = text;
  row.appendChild(head);
  row.appendChild(body);
  return row;
}

function actionBtn(label: string, onClick: () => void, isDefault: boolean): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = isDefault ? 'oru-conflict-btn oru-conflict-btn-default' : 'oru-conflict-btn';
  b.textContent = label;
  b.onmousedown = (e) => e.preventDefault(); // 不抢编辑器焦点
  b.onclick = onClick;
  return b;
}

type ConflictState = { specs: ConflictSpec[]; deco: DecorationSet };

const conflictField = StateField.define<ConflictState>({
  create: () => ({ specs: [], deco: Decoration.none }),
  update(value, tr) {
    let specs = value.specs;
    // 后续编辑（仅区间外，区间内被 filter 冻结）移动冲突区间——用 mapPos 跟踪，不缓存裸 offset。
    if (tr.docChanged && specs.length) {
      specs = specs.map((s) => ({
        ...s,
        from: tr.changes.mapPos(s.from, 1),
        to: tr.changes.mapPos(s.to, -1),
      }));
    }
    for (const e of tr.effects) {
      if (e.is(addConflicts)) specs = [...specs, ...e.value];
      else if (e.is(removeConflictEffect)) specs = specs.filter((s) => s.id !== e.value);
      else if (e.is(clearAllConflicts)) specs = [];
    }
    if (specs === value.specs) return value;
    const deco = Decoration.set(
      specs
        .filter((s) => s.from < s.to)
        .map((s) => Decoration.replace({ widget: new ConflictWidget(s), block: true }).range(s.from, s.to)),
      true,
    );
    return { specs, deco };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// 冻结：拒绝落在任一冲突区间内的**用户编辑**（解决事务、外部权威内容 ExternalChange、非 docChanged 放行；
// 区间外照常编辑）。放行 ExternalChange：合并 / 历史恢复等外部内容是权威的、不该被冻结挡掉致 view/store 分叉。
const freezeFilter = EditorState.transactionFilter.of((tr) => {
  if (tr.annotation(conflictResolveAnnotation) || tr.annotation(ExternalChange) || !tr.docChanged) return tr;
  const field = tr.startState.field(conflictField, false);
  if (!field || !field.specs.length) return tr;
  let blocked = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    for (const s of field.specs) {
      if (fromA < s.to && toA > s.from) blocked = true; // 与某冲突区间重叠
    }
  });
  return blocked ? [] : tr;
});

const conflictTheme = EditorView.baseTheme({
  '.oru-conflict-card': {
    position: 'relative',
    margin: '4px 0',
    border: '1px solid var(--border-default)',
    borderRadius: '4px',
    overflow: 'hidden',
    background: 'var(--bg-elevated)',
    boxShadow: '0 1px 4px rgba(20,40,48,0.05)',
    fontFamily: 'inherit',
  },
  // 左侧琥珀竖标：并行修改的告警语义（区别于 accent 与 danger）
  '.oru-conflict-bar': {
    position: 'absolute',
    left: '0',
    top: '12px',
    bottom: '12px',
    width: '2px',
    borderRadius: '1px',
    background: 'var(--warn)',
  },
  '.oru-conflict-head': { display: 'flex', alignItems: 'baseline', gap: '10px', padding: '12px 16px 0' },
  '.oru-conflict-eyebrow': { fontSize: '11px', fontWeight: '600', letterSpacing: '0.08em', color: 'var(--warn-deep)' },
  '.oru-conflict-note': { fontSize: '11px', color: 'var(--text-quaternary)' },
  '.oru-conflict-cols': { display: 'flex', flexDirection: 'column', padding: '4px 16px 0' },
  // 每侧一行：64px 标签列 + 正文，两侧对齐；Oru 侧顶一道分隔线
  '.oru-conflict-side': { display: 'flex', gap: '14px', padding: '8px 0', minWidth: '0' },
  '.oru-conflict-theirs': { borderTop: '1px solid var(--border-default)' },
  '.oru-conflict-label': { flex: '0 0 64px', fontSize: '11px', paddingTop: '2px' },
  '.oru-conflict-mine .oru-conflict-label': { color: 'var(--text-quaternary)' },
  '.oru-conflict-theirs .oru-conflict-label': { color: 'var(--accent-deep)' },
  '.oru-conflict-text': {
    flex: '1',
    margin: '0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: '13px',
    lineHeight: '1.6',
    color: 'var(--text-primary)',
  },
  '.oru-conflict-actions': {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '4px 16px 12px',
  },
  // 动作为文字链（非按钮）：常态 tx2、hover 加下划线；「用 Oru 的」是默认建议动作，accent-deep + ac-line 下划线
  '.oru-conflict-btn': {
    fontSize: '12px',
    padding: '0',
    border: 'none',
    background: 'none',
    color: 'var(--text-secondary)',
    borderBottom: '1px solid transparent',
    cursor: 'pointer',
  },
  '.oru-conflict-btn:hover': { color: 'var(--text-primary)', borderBottomColor: 'var(--border-heavy)' },
  '.oru-conflict-btn-default': { color: 'var(--accent-deep)', fontWeight: '600', borderBottomColor: 'var(--accent-line)' },
  '.oru-conflict-btn-default:hover': { color: 'var(--accent-deep)', borderBottomColor: 'var(--accent-deep)' },
  '.oru-conflict-hint': { marginLeft: 'auto', fontSize: '11px', color: 'var(--text-quaternary)' },
});

/** 编辑器扩展：装上冲突对照卡（StateField + 冻结 filter + 主题）。 */
export function conflictCards(): Extension {
  return [conflictField, freezeFilter, conflictTheme];
}

/** 该 view 当前是否有未解决的冲突段。 */
export function activeConflictCount(view: EditorView): number {
  return view.state.field(conflictField, false)?.specs.length ?? 0;
}
