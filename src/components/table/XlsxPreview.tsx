/**
 * XlsxPreview —— xlsx 只读预览（内存转换、零落盘）。
 *
 * 职责只有一件：让人「看一眼，决定要不要转成可编辑 CSV」。所以——
 * - 数据经 table.previewXlsx 请求-应答拿到（main 侧内存转换，不落盘、不碰 import 任何状态）；
 *   keep-mounted 期间不重读——xlsx 与生成的 CSV 各自独立，预览没有「刷新」语义。
 * - 网格只读：sticky 表头 + 斑马纹 + 虚拟滚动 + 单格选中/⌘C。排序/筛选/列宽拖拽不做，
 *   转成 CSV 后白捡（CsvEditor 全套）。列宽按内容采样一次性估定。
 * - 转编辑两条入口汇聚到 runConvert：顶栏「转为可编辑 CSV」按钮；双击格子/表头弹确认。
 *   确认后走 table.importXlsx（冲突三选一/另存/sheet 改名提醒全是既有编排）：
 *   当前 sheet written/identical → 立即原地 replaceTab 成 CSV 表格标签；
 *   conflict → App 级 ImportConflictDialog 接管，写盘成功经 table.importWritten 广播回来完成切换
 *   （用户取消 = 什么都不发生，预览原样，无挂起 UI 态）。
 * - 不建新 store：预览是无共享、无磁盘账本的纯快照，组件本地 state 足够；
 *   tableStore 的 autosave/syncFromDisk 全是磁盘语义，复用即纠缠。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parseCsv } from '@shared/csv';
import type {
  TableImportResultEvent,
  TableXlsxPreviewEvent,
  TableXlsxPreviewSheet,
} from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { cn } from '@/lib/cn';
import { basename } from '@/lib/paths';
import { makeTab, useWorkspaceStore } from '@/stores/workspaceStore';
import { useTableStore } from '@/stores/tableStore';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { GUTTER_WIDTH, ROW_HEIGHT_COMPACT } from './CsvEditor';

// 行高/行号栏宽与 CsvEditor 同规格（导出单源）；HEADER_H 同 CsvEditor 的「表头恒定紧凑高」
const ROW_H = ROW_HEIGHT_COMPACT;
const HEADER_H = ROW_HEIGHT_COMPACT;
const GUTTER = GUTTER_WIDTH;
const MIN_W = 56;
const MAX_W = 320;

/** 列宽按显示宽度（CJK 计 2）采样前 50 行一次估定，clamp 到 [MIN_W, MAX_W]——预览不做拖拽。 */
function estimateWidths(headers: string[], rows: string[][]): number[] {
  const units = (s: string): number => {
    let n = 0;
    for (const ch of s) n += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    return n;
  };
  return headers.map((h, c) => {
    let u = units(h);
    for (let r = 0; r < Math.min(rows.length, 50); r++) u = Math.max(u, units(rows[r]![c] ?? ''));
    return Math.min(MAX_W, Math.max(MIN_W, 24 + Math.min(u, 40) * 8));
  });
}

export function XlsxPreview({ path, projectId }: { path: string; projectId: string }): JSX.Element {
  const { t } = useTranslation('table');
  const [sheets, setSheets] = useState<TableXlsxPreviewSheet[] | null>(null);
  /** '' = 请求层失败（渲染时取 preview.failed 兜底文案）；非空 = main 给的失败原因 */
  const [failed, setFailed] = useState<string | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  /** 单格选中（r=-1 表头）；双击任意格/表头 = 试图编辑 → 弹确认 */
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 挂载装载一次。预览与磁盘无绑定，keep-mounted 期间不重读。
  useEffect(() => {
    let alive = true;
    wsClient
      .request<TableXlsxPreviewEvent>({ type: 'table.previewXlsx', projectId, path })
      .then((res) => {
        if (!alive) return;
        if (res.sheets) setSheets(res.sheets);
        else setFailed(res.message ?? '');
      })
      .catch(() => {
        if (alive) setFailed('');
      });
    return () => {
      alive = false;
    };
  }, [projectId, path]);

  const activeSheet = sheets?.[sheetIdx] ?? null;
  const table = useMemo(() => (activeSheet ? parseCsv(activeSheet.csv) : null), [activeSheet]);
  const colWidths = useMemo(() => (table ? estimateWidths(table.headers, table.rows) : []), [table]);

  // 原地切换：同标签位置把预览换成 CSV 表格（目标标签已开则关预览+激活既有）
  function switchToCsv(csvPath: string): void {
    useWorkspaceStore
      .getState()
      .replaceTab(`xlsx:${path}`, makeTab({ kind: 'table', projectId, ref: csvPath, title: basename(csvPath) }));
    void useTableStore.getState().open(projectId, csvPath);
  }

  // 冲突路径的完成信号：三选一写盘成功（覆盖/另存）→ 切到产物 CSV。取消则永远等不到——预览原样。
  useEffect(() => {
    return wsClient.subscribe((ev) => {
      if (ev.type === 'table.importWritten' && ev.projectId === projectId && ev.xlsxPath === path) {
        switchToCsv(ev.targetPath);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path]);

  async function runConvert(): Promise<void> {
    setConfirmOpen(false);
    if (converting) return;
    setConverting(true);
    try {
      const res = await wsClient.request<TableImportResultEvent>({ type: 'table.importXlsx', projectId, path });
      if (!res.sheets) return; // 失败文案已由 importFailed/importNotice 广播轻提示覆盖
      const cur = res.sheets.find((s) => s.name === activeSheet?.name) ?? res.sheets[0];
      if (cur && cur.status !== 'conflict') switchToCsv(cur.targetPath);
      // 当前 sheet 是 conflict：ImportConflictDialog 接管；写盘成功经 importWritten 回来切换
    } finally {
      setConverting(false);
    }
  }

  function onKeyDown(e: ReactKeyboardEvent): void {
    if (!table || !selected) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      const v =
        selected.r === -1
          ? (table.headers[selected.c] ?? '')
          : (table.rows[selected.r]?.[selected.c] ?? '');
      void navigator.clipboard.writeText(v);
    }
  }

  const virtualizer = useVirtualizer({
    count: table?.rows.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶栏：预览说明（含超限截断注记）+ 转编辑按钮 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-sunken/50 px-3.5 py-1.5 text-xs text-text-secondary">
        <span className="min-w-0 truncate">
          {t('preview.badge')}
          {activeSheet?.overLimit
            ? ` · ${t('preview.overLimit')} · ${t('csv.totalRows', { count: activeSheet.totalRows.toLocaleString() })}`
            : ''}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto shrink-0"
          disabled={converting || !sheets}
          onClick={() => void runConvert()}
        >
          {converting ? t('preview.converting') : t('preview.convert')}
        </Button>
      </div>

      {/* 多 sheet 切换 */}
      {sheets && sheets.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => {
                setSheetIdx(i);
                setSelected(null);
              }}
              className={cn(
                'shrink-0 rounded-md px-2 py-0.5 text-xs transition-colors',
                i === sheetIdx ? 'bg-accent-soft text-accent' : 'text-text-secondary hover:bg-hover',
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 主体 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {failed !== null ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-text-tertiary">
            {failed || t('preview.failed')}
          </div>
        ) : !table ? (
          <div className="flex h-full items-center justify-center text-xs text-text-tertiary">{t('preview.loading')}</div>
        ) : (
          // tabIndex 同 CsvEditor：键盘事件只从聚焦元素冒泡，焦点收在容器（⌘C 复制选中格）。
          <div ref={scrollRef} tabIndex={-1} onKeyDown={onKeyDown} className="oru-table-scroll h-full overflow-auto outline-none">
            {/* 表头（sticky） */}
            <div
              className="sticky top-0 z-10 flex border-b border-border bg-elevated"
              style={{ width: GUTTER + colWidths.reduce((a, w) => a + w, 0) }}
            >
              <div className="shrink-0 border-r border-border bg-elevated" style={{ width: GUTTER, height: HEADER_H }} />
              {table.headers.map((h, c) => (
                <div
                  key={c}
                  className={cn(
                    'flex shrink-0 items-center overflow-hidden border-r border-border px-2 text-xs font-medium',
                    selected?.r === -1 && selected.c === c ? 'bg-accent-soft text-text-primary' : 'text-text-secondary',
                  )}
                  style={{ width: colWidths[c], height: HEADER_H }}
                  onClick={() => setSelected({ r: -1, c })}
                  onDoubleClick={() => setConfirmOpen(true)}
                >
                  <span className={cn('truncate', h.trim() === '' && 'font-normal text-text-quaternary')}>
                    {h.trim() === '' ? t('csv.colN', { n: c + 1 }) : h}
                  </span>
                </div>
              ))}
            </div>

            {/* 虚拟行 */}
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const row = table.rows[vi.index]!;
                return (
                  <div
                    key={vi.key}
                    className={cn('absolute left-0 flex', vi.index % 2 === 1 && 'bg-sunken/30')}
                    style={{ transform: `translateY(${vi.start}px)`, height: ROW_H }}
                  >
                    <div
                      className="flex shrink-0 items-center justify-end border-b border-r border-border pr-2 text-2xs tabular-nums text-text-tertiary"
                      style={{ width: GUTTER }}
                    >
                      {vi.index + 1}
                    </div>
                    {table.headers.map((_, c) => (
                      <div
                        key={c}
                        className={cn(
                          'flex items-center overflow-hidden border-b border-r border-border px-2 text-xs',
                          selected?.r === vi.index && selected.c === c
                            ? 'bg-accent-soft text-text-primary'
                            : 'text-text-secondary',
                        )}
                        style={{ width: colWidths[c] }}
                        onClick={() => setSelected({ r: vi.index, c })}
                        onDoubleClick={() => setConfirmOpen(true)}
                      >
                        <span className="truncate">{row[c] ?? ''}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 双击试图编辑 → 确认生成 CSV */}
      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('preview.confirmTitle')}
        description={t('preview.confirmDesc')}
        footer={
          <>
            <Button size="sm" onClick={() => setConfirmOpen(false)}>
              {t('common:cancel')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void runConvert()}>
              {t('preview.confirmOk')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  );
}
