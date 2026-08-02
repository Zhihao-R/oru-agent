import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import type { ViewUpdate } from '@uiw/react-codemirror';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import {
  markdown,
  markdownLanguage,
  insertNewlineContinueMarkupCommand,
  deleteMarkupBackward,
} from '@codemirror/lang-markdown';
import { lezerDialect } from '@/lib/markdownDialect';
import { livePreview, type CropRequest, type DocIdentity } from './livePreview';
import { syntaxHighlighting } from '@codemirror/language';
import { MessageSquarePlus } from 'lucide-react';
import { registerEditorSelectionGetter } from './editorSelection';
import { registerEditorView } from './editorViewRegistry';
import { conflictCards } from './conflictCard';
import { editorHistoryExtension } from './editorHistory';
import { recentChangeHighlight } from './recentChangeHighlight';
import { baseTheme, mdHighlight } from './mdEditorTheme';
import type { Extension } from '@codemirror/state';
import type { HighlightStyle } from '@codemirror/language';

/** 选区末尾浮层的位置（相对编辑器容器） */
type PopAnchor = { top: number; left: number };

// basicSetup 对象也在 @uiw 的 reconfigure effect 依赖里（defaultBasicSetup）——内联字面量
// 每渲染新引用会同样触发整编辑器重配，故提成模块常量。
const BASIC_SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  bracketMatching: true,
  autocompletion: false,
  history: false, // 改由 editorHistoryExtension 提供（compartment 化，G94 可运行时清空）
} as const;

type AddToChatSelection = { quote: string; line?: number };

type MdEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  /**
   * 选段「加入对话」：选区稳定后浮层点击时回调（MdEditor 自身不碰 chatStore，由父组件
   * 补 sourcePath 后转交）。不传则不显浮层。
   */
  onAddToChat?: (sel: AddToChatSelection) => void;
  /**
   * 粘贴 / 拖入图片落盘：父组件持 projectId+openPath，把图落进 assets 后回相对引用，
   * MdEditor 据此在光标/落点插 `![](ref)`。不传则不接管粘贴/拖入。
   */
  uploadImage?: (file: File) => Promise<string | null>;
  /**
   * 图片裁剪请求：CM widget 工具条点「裁剪」→ 经此回调让父组件开裁剪对话框。
   * 绑到本 view 实例（多 md 编辑器并存不互相覆盖）。不传则裁剪按钮无动作。
   */
  onCropRequest?: (req: CropRequest) => void;
  /**
   * 文档身份（项目 + 项目相对文档 path）：本地图缩略图据此把「是哪个文档」编进 oru-doc-img:// URL，
   * 主进程不再靠全局 activeDoc 定位（§4.1 多标签去全局态）。不传则本地图渲染缺失占位。
   * 其 docPath 亦作半受控 view 注册表的 key（见下方 registerEditorView）——改 docIdentity 语义时勿漏这个消费方。
   */
  docIdentity?: DocIdentity | null;
  /**
   * 覆盖编辑器主题（EditorView.theme）。默认走全局共享的 baseTheme（工作区文档编辑器）；
   * 档案编辑（ProfileDocView）传 profileEditorTheme，令读/写排版一致、点编辑不骤变。
   */
  themeExtension?: Extension;
  /**
   * 覆盖语法高亮。默认 mdHighlight；档案传 profileHighlight（衬线标题 + 灰正文，与读态对齐）。
   */
  highlightStyle?: HighlightStyle;
};

/** 把上传成功的图引用插到 pos 处（多张换行分隔）。pos 在 await 后兜底钳进文档范围。 */
async function insertUploadedImages(
  uploadFn: (file: File) => Promise<string | null>,
  files: File[],
  pos: number,
  view: EditorView,
): Promise<void> {
  const refs = (await Promise.all(files.map(uploadFn))).filter((r): r is string => !!r);
  if (!refs.length) return;
  const text = refs.map((r) => `![](${r})`).join('\n');
  const at = Math.min(pos, view.state.doc.length);
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
}

export function MdEditor({
  value,
  onChange,
  onSave,
  readOnly = false,
  onAddToChat,
  uploadImage,
  onCropRequest,
  docIdentity,
  themeExtension,
  highlightStyle,
}: MdEditorProps): JSX.Element {
  const { t } = useTranslation('editor');
  const viewRef = useRef<EditorView | null>(null);
  // view 也存 state——注册 effect 要等 @uiw 异步建好 view（onCreateEditor）后才能注册；
  // 只靠 ref 的话注册 effect 早于 onCreateEditor 跑、读到 null 且不再重跑 → 永远注册不上（playtest 抓到）。
  const [view, setView] = useState<EditorView | null>(null);
  // uploadImage 走 ref：paste/drop handler 在 extensions 闭包里读 ref.current，
  // 不把回调塞进 useMemo 依赖（否则切文档每次重配 editor）。
  const uploadImageRef = useRef(uploadImage);
  uploadImageRef.current = uploadImage;
  // onCropRequest 同理走 ref：facet 里塞一个稳定的转发器读 ref.current，避免回调变化重配 editor。
  const onCropRef = useRef(onCropRequest);
  onCropRef.current = onCropRequest;
  // onSave/onChange/onAddToChat 同走 ref。父组件（EditorPane）订阅 content、每击键必重渲染，
  // 这三个内联回调每次都是新引用；而 @uiw 的 reconfigure effect 把 extensions/onChange/onUpdate
  // 都放在依赖里——任一引用变化就整编辑器 reconfigure，全文档装饰推倒重建（全版面闪烁的根因）。
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onAddToChatRef = useRef(onAddToChat);
  onAddToChatRef.current = onAddToChat;
  // 转发器引用稳定（直接进 @uiw 的 reconfigure 依赖，不能每渲染新建）
  const handleChange = useCallback((v: string) => onChangeRef.current(v), []);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 鼠标是否按下中——区分"拖选途中"（按下）与"键盘选区/选择完成"（抬起）。
  const pointerDownRef = useRef(false);
  // 选区稳定后浮层的锚点；null = 不显。仅在 pointerup（选择完成）后计算，拖选过程中不显。
  const [anchor, setAnchor] = useState<PopAnchor | null>(null);
  // 浮层点击时要交出去的选区内容——与 anchor 同生命周期。
  const selRef = useRef<AddToChatSelection | null>(null);

  // 按当前选区算浮层锚点（相对 wrap 容器）。空选区 → 收起浮层。
  const refreshAnchor = useCallback(() => {
    const view = viewRef.current;
    const wrap = wrapRef.current;
    if (!view || !wrap || !onAddToChatRef.current) {
      setAnchor(null);
      return;
    }
    const range = view.state.selection.main;
    if (range.empty) {
      setAnchor(null);
      selRef.current = null;
      return;
    }
    // 选区末尾坐标（视口绝对），减去容器 rect 转成容器内偏移
    const coords = view.coordsAtPos(range.to);
    if (!coords) {
      setAnchor(null);
      selRef.current = null;
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    selRef.current = {
      quote: view.state.sliceDoc(range.from, range.to),
      line: view.state.doc.lineAt(range.from).number,
    };
    setAnchor({
      top: coords.bottom - wrapRect.top + 4,
      left: coords.right - wrapRect.left + 4,
    });
  }, []);

  const extensions = useMemo(
    () => [
      // base 默认 commonmark，删除线/任务列表/表格节点要 GFM（实时预览依赖）。
      // addKeymap:false 关掉自带 keymap，由下方完整重列——否则我们的 Enter 覆盖与自带 keymap
      // 同为 Prec.high，靠数组顺序竞争，自带在前会先 return true 把覆盖架空。
      markdown({ base: markdownLanguage, addKeymap: false, extensions: lezerDialect }),
      // 接管 markdown 编辑键。Enter 用 nonTightLists:false——空列表行回车不插空行变松散列表，
      // 而是退回上一层级（嵌套补父层 bullet，顶层删 bullet 成普通行）；Backspace 仍删一层标记。
      Prec.high(
        keymap.of([
          { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
          { key: 'Backspace', run: deleteMarkupBackward },
        ]),
      ),
      livePreview((req) => onCropRef.current?.(req), docIdentity),
      editorHistoryExtension(), // 撤销栈 compartment 化（G94）：取代 basicSetup 内建 history，让换入命中重叠时可清空
      conflictCards(), // 协同冲突对照卡（块②）：冲突段渲染并排卡 + 冻结，editorStore 经 addConflicts effect 驱动
      recentChangeHighlight(), // 「Oru 刚改过」段落 2s 淡高亮（场景一·文档），editorStore.dispatchExternal 驱动
      EditorView.lineWrapping,
      syntaxHighlighting(highlightStyle ?? mdHighlight),
      EditorView.domEventHandlers({
        keydown(event) {
          const isSave =
            (event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S');
          if (isSave) {
            event.preventDefault();
            onSaveRef.current?.();
            return true;
          }
          return false;
        },
        mousedown() {
          // 进入拖选：先收起旧浮层，拖选途中靠 pointerDownRef 抑制 onUpdate 显示。
          // 选择完成（mouseup）在 document 级监听里收尾——拖选可能在编辑器外松开，
          // CM 的 domEventHandlers.mouseup 只在编辑器 DOM 内触发、会漏掉那一次。
          pointerDownRef.current = true;
          setAnchor(null);
          selRef.current = null;
          return false;
        },
        paste(event, view) {
          const fn = uploadImageRef.current;
          if (!fn) return false;
          const imgs = Array.from(event.clipboardData?.files ?? []).filter((f) =>
            f.type.startsWith('image/'),
          );
          if (!imgs.length) return false; // 非图（文本等）→ 走默认粘贴
          event.preventDefault();
          void insertUploadedImages(fn, imgs, view.state.selection.main.head, view);
          return true;
        },
        drop(event, view) {
          // 落点互斥：编辑器只接管「落在正文 + 是图片文件」的拖放；否则不拦，让外层
          // （文件树「移动」/ 对话框「引用」）按各自落点处理（PRD §2.2）。
          const fn = uploadImageRef.current;
          if (!fn) return false;
          const imgs = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
            f.type.startsWith('image/'),
          );
          if (!imgs.length) return false;
          event.preventDefault();
          const pos =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.head;
          void insertUploadedImages(fn, imgs, pos, view);
          return true;
        },
      }),
    ],
    // 文档身份变化（改名联动）需重配 livePreview 的 facet → 依赖其原始字段（对象每渲染新建，不直接进 deps）
    // highlightStyle 由调用方一次性传入（模块常量，引用稳定），改高亮套件要重配 → 进 deps
    [docIdentity?.projectId, docIdentity?.docPath, highlightStyle],
  );

  // 半受控协同（tech §3.2）：把本 view 按文档 path 注册，editorStore 的外部内容变更（AI 落盘合并、
  // 历史恢复）据此拿到 view、dispatch 最小变更集原地更新、保光标。docPath 变化（改名联动）时
  // 注销旧 key、注册新 key（同一 view 实例）；卸载时成对注销。仅 editorStore 后端的文档（带 docIdentity）注册。
  useEffect(() => {
    const key = docIdentity?.docPath;
    if (!view || !key) return;
    return registerEditorView(key, view);
  }, [view, docIdentity?.docPath]);

  // 随手评点（aside）：注册编辑器选区 getter——"编辑器里选中、⌥点编辑器外"时
  // resolver 经它读到 CodeMirror 内部选区（与「加入对话」同一来源）。卸载时注销成对。
  useEffect(() => {
    return registerEditorSelectionGetter(() => {
      const view = viewRef.current;
      if (!view) return '';
      // 指认的语义是"用户此刻看得见的选区"。deck 的文稿/预览标签常驻挂载、靠
      // display:none 切换——切到预览后本编辑器仍活着，CodeMirror 失焦/隐藏都不清
      // selection.main；若残留选区参与解析，⌥点任意处都会被一段不可见文本劫持。
      // DOM 不可见即当没有选区（checkVisibility 覆盖自身与祖先的 display:none 等）。
      if (view.dom.checkVisibility && !view.dom.checkVisibility()) return '';
      const range = view.state.selection.main;
      return range.empty ? '' : view.state.sliceDoc(range.from, range.to);
    });
  }, []);

  // 拖选完成（mouseup）走 document 级监听：鼠标可能在编辑器外松开，
  // CM domEventHandlers.mouseup 漏触发会让 pointerDownRef 滞留 true、浮层永不出现。
  // 有没有 onAddToChat 用布尔量参与依赖：回调本体每渲染新引用（父组件内联），拿引用当依赖
  // 会让监听/回调每击键重挂；布尔量只在「配没配」翻转时变。
  const hasAddToChat = !!onAddToChat;
  useEffect(() => {
    if (!hasAddToChat) return;
    const onDocMouseUp = () => {
      if (!pointerDownRef.current) return;
      pointerDownRef.current = false;
      requestAnimationFrame(refreshAnchor); // 下一帧：selection 已更新、布局更稳
    };
    document.addEventListener('mouseup', onDocMouseUp);
    return () => document.removeEventListener('mouseup', onDocMouseUp);
  }, [hasAddToChat, refreshAnchor]);

  // 键盘选区 / 文档变化时同步浮层：
  // - 文档变化（打字）或选区清空 → 收起（用户在编辑，不是在选段）
  // - 键盘扩选（Shift+方向，pointer 未按下）→ 重算锚点（键盘选择无"拖选途中"歧义，可即时显）
  // - 鼠标拖选途中也会狂发 selectionSet，但 pointerDownRef=true 时跳过，留给 mouseup
  // 引用稳定（直接进 @uiw 的 reconfigure 依赖）——onAddToChat 经 ref 读最新值
  const onUpdate = useCallback(
    (vu: ViewUpdate) => {
      if (!onAddToChatRef.current) return;
      if (vu.docChanged || vu.state.selection.main.empty) {
        setAnchor(null);
        selRef.current = null;
        return;
      }
      if (vu.selectionSet && !pointerDownRef.current) refreshAnchor();
    },
    [refreshAnchor],
  );

  const handleAdd = () => {
    const sel = selRef.current;
    if (sel && sel.quote.trim()) onAddToChat?.(sel);
    // 点完收起浮层 + 清掉选区，给即时反馈
    setAnchor(null);
    selRef.current = null;
    viewRef.current?.dispatch({ selection: { anchor: viewRef.current.state.selection.main.to } });
  };

  return (
    <div ref={wrapRef} className="relative h-full">
      <CodeMirror
        value={value}
        onChange={handleChange}
        onCreateEditor={(v) => {
          viewRef.current = v;
          setView(v); // 触发注册 effect 重跑（此刻 view 才真正建好）
        }}
        onUpdate={onUpdate}
        extensions={extensions}
        theme={themeExtension ?? baseTheme}
        readOnly={readOnly}
        basicSetup={BASIC_SETUP}
        className="h-full"
        style={{ height: '100%' }}
      />

      {anchor && onAddToChat ? (
        <button
          type="button"
          // mousedown 阻止默认：避免点浮层时编辑器把选区清掉、抢焦点
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleAdd}
          style={{ top: anchor.top, left: anchor.left }}
          // 深墨小按钮（设计稿：选段浮层与图片工具条同一套 --pop-* 反色悬浮小件）
          className="absolute z-10 flex items-center gap-1.5 whitespace-nowrap rounded-xs bg-pop-bg px-2.5 py-1 text-xs font-medium text-pop-fg shadow-[0_8px_20px_-8px_rgba(16,28,34,0.5)]"
        >
          <MessageSquarePlus size={12} strokeWidth={1.8} />
          {t('addToChat')}
        </button>
      ) : null}
    </div>
  );
}
