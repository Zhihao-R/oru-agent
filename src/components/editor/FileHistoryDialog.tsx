import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Extension } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MergeView } from '@codemirror/merge';
import { History, Loader2, Trash2 } from 'lucide-react';
import type {
  FileSnapshotKind,
  FileSnapshotRef,
} from '@shared/types';
import type {
  FileHistoryListResultEvent,
  FileHistoryContentEvent,
  MemoryHistoryListResultEvent,
  MemoryHistoryContentEvent,
} from '@shared/protocol';
import type { DocRef } from '@/stores/editorStore';
import { refKey } from '@/stores/editorStore';
import { wsClient } from '@/lib/ws';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { baseTheme } from './mdEditorTheme';

/**
 * 找回旧版「历史时间轴」窗口 —— md / csv 共用（技术设计 §7）。
 *
 * 左列时间轴：每条快照（时间 + 来源），点选在右侧展示「该旧版 → 当前内容」只读 diff。
 * 「恢复此版本」把旧版整篇写回工作文件（main 在锁内先留底当前版再写回）；「清空历史」清隐私中间态。
 * 复用方：md 编辑器、csv 表格、**deck 文稿（.narrative.md）**——都是文本类、走文本 diff。
 * deck 幻灯片（index.html 的 v{N} 版本）是另一套带指针/checkout 的后端，不复用本组件。
 *
 * docRef 为 null 时组件什么也不做（等同原来 projectId/path 为 null 的行为）。
 * docRef.kind === 'memory' 时：list/get 走 memory.history.* 后端，不渲染清空历史按钮。
 */

const mergeFit = EditorView.theme({
  '&': { height: 'auto', fontSize: '12px' },
  '.cm-scroller': { padding: '8px 0' },
  '.cm-content': { padding: '0 12px', maxWidth: 'none', margin: '0' },
});

function readOnlyExtensions(language: Extension[]): Extension[] {
  return [
    ...language,
    EditorView.lineWrapping,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    baseTheme,
    mergeFit,
  ];
}

// 只标 md/csv 编辑器会遇到的 kind；deck 专属 kind（protective/batch/inline/reorder）不在 md 历史窗
// 出现（deck 走 DeckHistoryDialog 读自己的 manifest），故用 Partial + 兜底，不在此处硬编 deck 语义。
// overwrite-guard 被 listForUser 过滤、永不进此窗，故不列——只标会真正出现的可见 kind
// 只标 md/csv 编辑器会遇到的 kind；展示 label 经 editor ns 翻译，t 由调用方绑定传入。
const HISTORY_KINDS: FileSnapshotKind[] = ['periodic', 'manual', 'ai', 'pre-restore', 'initial', 'handoff'];

// memory 档案只用 manual/ai 两种来源，其余兜底
const MEMORY_KINDS: FileSnapshotKind[] = ['manual', 'ai'];

function kindLabel(kind: FileSnapshotKind, t: TFunction, isMemory: boolean): string {
  if (isMemory) {
    if (MEMORY_KINDS.includes(kind)) return t(`history.kindMemory.${kind}`);
    return t('history.kindFallback');
  }
  return HISTORY_KINDS.includes(kind) ? t(`history.kind.${kind}`) : t('history.kindFallback');
}

function formatTime(ts: number, t: TFunction): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return t('history.today', { hm });
  return t('history.date', { month: d.getMonth() + 1, day: d.getDate(), hm });
}

type FileHistoryDialogProps = {
  open: boolean;
  onClose: () => void;
  docRef: DocRef | null;
  /** 当前编辑器内容——作为 diff 右栏「现在」 */
  currentContent: string;
  /** 把某快照恢复回工作文件（由 store 实现：写回 + 更新编辑器） */
  onRestore: (snapshotId: string) => Promise<void>;
  /** 文档语言高亮（md 传 markdown 套件、csv 传 []） */
  languageExtensions?: Extension[];
};

export function FileHistoryDialog({
  open,
  onClose,
  docRef,
  currentContent,
  onRestore,
  languageExtensions = [],
}: FileHistoryDialogProps): JSX.Element {
  const { t } = useTranslation('editor');
  const [snapshots, setSnapshots] = useState<FileSnapshotRef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  // G96：对比对象 B（右栏）——'current'=当前编辑器内容，否则某个快照 id。左栏 A 仍由时间轴点选。
  const [compareId, setCompareId] = useState<string>('current');
  const [compareContent, setCompareContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  const isMemory = docRef?.kind === 'memory';
  // 派生的稳定 key（档案唯一字符串）：CsvEditor/DeckCenter 每次渲染传的是新字面量 docRef，
  // 若把对象直接进依赖数组，effect/callback 会因引用变化白跑一遍（面板打开时多发一次 list）。
  // 用 refKey 派生字符串做依赖 → 同一身份的新对象不再触发重跑；docRef 字段在回调体内读即可。
  const docKey = docRef ? refKey(docRef) : null;

  const refresh = useCallback(async () => {
    if (!docRef) return;
    setLoading(true);
    try {
      if (docRef.kind === 'memory') {
        const res = await wsClient.request<MemoryHistoryListResultEvent>({
          type: 'memory.history.list',
          relPath: docRef.relPath,
        });
        if (res.type !== 'memory.history.list.result') return;
        const sorted = [...res.snapshots].sort((a, b) => b.createdAt - a.createdAt);
        setSnapshots(sorted);
      } else {
        const res = await wsClient.request<FileHistoryListResultEvent>({
          type: 'fileHistory.list',
          projectId: docRef.projectId,
          path: docRef.path,
        });
        if (res.type !== 'fileHistory.list.result') return;
        // 最新在上
        const sorted = [...res.snapshots].sort((a, b) => b.createdAt - a.createdAt);
        setSnapshots(sorted);
      }
    } finally {
      setLoading(false);
    }
    // docRef 字段在体内读；依赖用派生 docKey（稳定字符串），挡同一身份新对象引起的重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // 打开时拉列表；关闭时清选中态与对比对象
  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setSelectedContent(null);
      setCompareId('current');
      setCompareContent(null);
      return;
    }
    void refresh();
  }, [open, refresh]);

  // 拉某快照内容（A/B 共用）——B='current' 直接取编辑器当前内容，不发请求
  const fetchSnapshotContent = useCallback(
    async (id: string): Promise<string | null> => {
      if (!docRef) return null;
      if (docRef.kind === 'memory') {
        const res = await wsClient.request<MemoryHistoryContentEvent>({
          type: 'memory.history.get',
          relPath: docRef.relPath,
          snapshotId: id,
        });
        return res.type === 'memory.history.content' ? res.content : null;
      } else {
        const res = await wsClient.request<FileHistoryContentEvent>({
          type: 'fileHistory.get',
          projectId: docRef.projectId,
          path: docRef.path,
          snapshotId: id,
        });
        return res.type === 'fileHistory.content' ? res.content : null;
      }
    },
    // 同 refresh：读体内 docRef，依赖用派生 docKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docKey],
  );

  // 选中某快照 A → 拉它的内容
  useEffect(() => {
    if (!open || selectedId === null) {
      setSelectedContent(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const content = await fetchSnapshotContent(selectedId);
      if (!cancelled && content !== null) setSelectedContent(content);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selectedId, fetchSnapshotContent]);

  // 对比对象 B → 'current' 用编辑器内容，否则拉该快照内容
  useEffect(() => {
    if (!open) return;
    if (compareId === 'current') {
      setCompareContent(currentContent);
      return;
    }
    let cancelled = false;
    void (async () => {
      const content = await fetchSnapshotContent(compareId);
      if (!cancelled && content !== null) setCompareContent(content);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, compareId, currentContent, fetchSnapshotContent]);

  // A 与 B 撞成同一版（点选 A 恰好是当前 B）→ B 回落当前内容，避免自比自
  useEffect(() => {
    if (compareId !== 'current' && compareId === selectedId) setCompareId('current');
  }, [selectedId, compareId]);

  // 渲染「版本 A → 版本 B」只读 diff（B 默认当前内容，可切任意版）
  useEffect(() => {
    const host = hostRef.current;
    if (!open || !host || selectedContent === null || compareContent === null) return;
    const mv = new MergeView({
      a: { doc: selectedContent, extensions: readOnlyExtensions(languageExtensions) },
      b: { doc: compareContent, extensions: readOnlyExtensions(languageExtensions) },
      parent: host,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    mv.dom.style.maxHeight = '52vh';
    mv.dom.style.overflow = 'auto';
    return () => mv.destroy();
    // languageExtensions 按文档类型固定，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedContent, compareContent]);

  const handleRestore = async (): Promise<void> => {
    if (selectedId === null) return;
    setBusy(true);
    try {
      await onRestore(selectedId);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async (): Promise<void> => {
    if (!docRef || docRef.kind !== 'project') return;
    setBusy(true);
    try {
      await wsClient.request({ type: 'fileHistory.clear', projectId: docRef.projectId, path: docRef.path });
      setSelectedId(null);
      setSelectedContent(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('history.title')}
      description={t('history.description')}
      className="w-[min(960px,calc(100vw-32px))]"
      footer={
        <div className="flex w-full items-center justify-between">
          {/* 只有 project 档案有清空历史；memory 与 docRef===null 都不渲染此按钮 */}
          {docRef?.kind === 'project' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleClear()}
              disabled={busy || snapshots.length === 0}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" strokeWidth={1.5} />
              {t('history.clear')}
            </Button>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('common:close')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleRestore()}
              disabled={busy || selectedId === null}
            >
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" strokeWidth={1.5} /> : null}
              {t('history.restore')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex h-[56vh] gap-3">
        {/* 左：时间轴 */}
        <div className="w-56 shrink-0 overflow-y-auto rounded-lg border border-border bg-sunken">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-text-tertiary">
              {t('common:loading')}
            </div>
          ) : snapshots.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-text-tertiary">
              <History className="h-5 w-5" strokeWidth={1.5} />
              <span>{t('history.empty')}</span>
            </div>
          ) : (
            <ul className="py-1">
              {snapshots.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className={
                      'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors ' +
                      (selectedId === s.id ? 'bg-hover' : 'hover:bg-hover/60')
                    }
                  >
                    <span className="text-xs text-text-primary">{formatTime(s.createdAt, t)}</span>
                    <span className="text-xs text-text-tertiary">
                      {kindLabel(s.kind, t, isMemory)}
                      {s.archived ? ` · ${t('history.archived')}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 右：版本 A → 版本 B 的只读 diff（B 默认当前内容，可切任意版，G96） */}
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border">
          {selectedContent === null ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-text-tertiary">
              {t('history.pickPrompt')}
            </div>
          ) : (
            <>
              <div className="flex items-center border-b border-border bg-sunken text-xs text-text-tertiary">
                <div className="flex-1 border-r border-border px-3 py-1.5">
                  {(() => {
                    const a = snapshots.find((s) => s.id === selectedId);
                    return a ? `${formatTime(a.createdAt, t)} · ${kindLabel(a.kind, t, isMemory)}` : t('history.oldVersion');
                  })()}
                </div>
                <div className="flex flex-1 items-center gap-1.5 px-3 py-1">
                  <span className="shrink-0">{t('history.compareWith')}</span>
                  <select
                    value={compareId}
                    onChange={(e) => setCompareId(e.target.value)}
                    className="min-w-0 flex-1 rounded border border-border bg-canvas px-1.5 py-0.5 text-xs text-text-primary"
                  >
                    <option value="current">{t('history.currentContent')}</option>
                    {snapshots
                      .filter((s) => s.id !== selectedId)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {`${formatTime(s.createdAt, t)} · ${kindLabel(s.kind, t, isMemory)}`}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div ref={hostRef} className="bg-canvas" />
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
