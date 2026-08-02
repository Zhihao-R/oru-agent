import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ZoomIn, ZoomOut, MoveHorizontal, Search } from 'lucide-react';
import { SearchBar } from '@/components/workspace/SearchBar';
import type { PDFDocumentProxy, TextContent } from 'pdfjs-dist/types/src/display/api';
import { pdfjs } from '@/lib/pdfjs';
import { cn } from '@/lib/cn';
import { usePdfStore, type PdfSearchMatch } from '@/stores/pdfStore';
import { buildPdfUrl, loadPdf, pageText, findOffsets, type PdfLoadError } from './pdfDoc';

/**
 * 自绘 PDF 查看器（PDF tech design §五）——工具栏 + 连续滚动占位渲染 + 文字层选字 + 搜索。
 * 视觉复用既有查看器设计语言（工具栏壳同 EditorPane/CsvEditor，按钮就地复刻 CsvEditor.ToolbarButton）。
 * 只读、纯前端：无 WS、无落盘。视图态（缩放/搜索）收在 pdfStore 桶里、切走保留。
 */
const PAGE_GAP = 12; // 页间窄间隙（px）
const FIT_PADDING = 32; // 适配宽度时容器左右留白（px）
const OVERSCAN = '800px'; // IntersectionObserver 上下 overscan——滚到哪渲染到哪、附近预渲染

export function PdfViewer({
  path,
  projectId,
  isActive,
}: {
  path: string;
  projectId: string;
  isActive: boolean;
}): JSX.Element {
  const { t } = useTranslation('pdf');
  const bucket = usePdfStore((s) => s.byRef[path]);
  const patch = usePdfStore((s) => s.patch);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [viewports, setViewports] = useState<{ width: number; height: number }[]>([]); // scale=1 原始尺寸
  const [loadError, setLoadError] = useState<PdfLoadError | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);

  const zoom = bucket?.zoom ?? 1;
  const fitWidth = bucket?.fitWidth ?? true;
  const search = bucket?.search ?? { open: false, query: '', matches: [], activeIndex: -1 };

  // textContent 缓存（搜索 + 文字层共用，避免重复抽取）——按页号 memo。
  const tcCache = useRef<Map<number, Promise<TextContent>>>(new Map());
  const getTextContent = useCallback(
    (pageNum: number): Promise<TextContent> => {
      if (!pdf) return Promise.reject(new Error('no pdf'));
      let p = tcCache.current.get(pageNum);
      if (!p) {
        p = pdf.getPage(pageNum).then((pg) => pg.getTextContent());
        tcCache.current.set(pageNum, p);
      }
      return p;
    },
    [pdf],
  );

  // ── 加载文档 + 批量取全部页 viewport（一次性精确总高，见 §5.1）──
  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    setPdf(null);
    setViewports([]);
    setLoadError(null);
    tcCache.current.clear();
    (async () => {
      try {
        doc = await loadPdf(buildPdfUrl(projectId, path));
        if (cancelled) {
          void doc.destroy();
          return;
        }
        const vps = await Promise.all(
          Array.from({ length: doc.numPages }, (_, i) =>
            doc!.getPage(i + 1).then((pg) => {
              const v = pg.getViewport({ scale: 1 });
              return { width: v.width, height: v.height };
            }),
          ),
        );
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPdf(doc);
        setViewports(vps);
      } catch (err) {
        if (!cancelled) setLoadError(err as PdfLoadError);
      }
    })();
    return () => {
      cancelled = true;
      void doc?.destroy();
    };
  }, [projectId, path]);

  // ── 容器宽度（适配宽度用）：ResizeObserver 跟随窗格/侧栏变化 ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // 有效缩放：适配宽度 = 可用宽 ÷ 最宽页原始宽；否则 = zoom。
  const maxPageWidth = useMemo(
    () => (viewports.length ? Math.max(...viewports.map((v) => v.width)) : 1),
    [viewports],
  );
  const scale = useMemo(() => {
    if (fitWidth && containerWidth > 0) return (containerWidth - FIT_PADDING) / maxPageWidth;
    return zoom;
  }, [fitWidth, containerWidth, maxPageWidth, zoom]);

  // 每页缩放后高度 + 累计偏移（页码反推、跳页定位用）。
  const pageOffsets = useMemo(() => {
    const offs: number[] = [];
    let acc = 0;
    for (const v of viewports) {
      offs.push(acc);
      acc += v.height * scale + PAGE_GAP;
    }
    return offs;
  }, [viewports, scale]);

  // ── 恢复滚动位置（切回如初 / 改名重挂）──
  useEffect(() => {
    if (pdf && scrollRef.current && bucket) scrollRef.current.scrollTop = bucket.scrollTop;
    // 仅在文档就绪时恢复一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf]);

  // ── 滚动：持久化 scrollTop + 反推当前页 ──
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    patch(path, { scrollTop: top });
    // 当前页 = 视口顶部落在哪页（最后一个 offset <= top+一点）
    const mid = top + 40;
    let cur = 1;
    for (let i = 0; i < pageOffsets.length; i++) {
      if (pageOffsets[i] <= mid) cur = i + 1;
      else break;
    }
    setCurrentPage(cur);
  }, [patch, path, pageOffsets]);

  // ── IntersectionObserver：可视页窗口（滚到哪渲染到哪 + overscan）──
  const pageEls = useRef<Map<number, HTMLElement>>(new Map());
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || viewports.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        });
      },
      { root, rootMargin: `${OVERSCAN} 0px` },
    );
    pageEls.current.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [viewports.length]);

  const registerPageEl = useCallback((n: number, el: HTMLElement | null) => {
    if (el) pageEls.current.set(n, el);
    else pageEls.current.delete(n);
  }, []);

  // ── 缩放操作 ──
  const applyZoom = useCallback(
    (next: number) => {
      patch(path, { zoom: Math.min(6, Math.max(0.25, next)), fitWidth: false });
    },
    [patch, path],
  );
  const zoomIn = useCallback(() => applyZoom((fitWidth ? scale : zoom) + 0.2), [applyZoom, fitWidth, scale, zoom]);
  const zoomOut = useCallback(() => applyZoom((fitWidth ? scale : zoom) - 0.2), [applyZoom, fitWidth, scale, zoom]);
  const resetFit = useCallback(() => patch(path, { fitWidth: true }), [patch, path]);

  // ⌘+ / ⌘− / ⌘0，仅活跃标签
  useEffect(() => {
    if (!isActive) return;
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        patch(path, { search: { ...search, open: true } });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive, zoomIn, zoomOut, patch, path, search]);

  // 触控板双指捏合（ctrlKey wheel，macOS 惯例）
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyZoom((fitWidth ? scale : zoom) - e.deltaY * 0.01);
    },
    [applyZoom, fitWidth, scale, zoom],
  );

  const jumpToPage = useCallback(
    (n: number) => {
      const el = scrollRef.current;
      if (!el || n < 1 || n > pageOffsets.length) return;
      el.scrollTop = pageOffsets[n - 1];
    },
    [pageOffsets],
  );

  // ── 搜索：query 变→扫全页 textContent 算命中（一次，textContent 已缓存）──
  // 版本守卫：快速输入时并发的旧 runSearch 完成后不得覆盖新结果（Bug#4）。
  const searchSeq = useRef(0);
  const runSearch = useCallback(
    (query: string) => {
      const seq = ++searchSeq.current;
      // 先同步写 query（受控输入必须立即回填，否则异步匹配未完成时旧值回填会吞掉后续按键）。
      const cur = usePdfStore.getState().byRef[path]?.search ?? { open: true, query: '', matches: [], activeIndex: -1 };
      patch(path, { search: { ...cur, open: true, query, matches: [], activeIndex: -1 } });
      if (!pdf || !query) return;
      // 匹配计算异步（逐页扫 textContent），完成后再 patch matches；版本守卫防旧查询覆盖新。
      void (async () => {
        const matches: PdfSearchMatch[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const tc = await getTextContent(i);
          if (seq !== searchSeq.current) return; // 已有更新的查询，丢弃本次
          findOffsets(pageText(tc), query).forEach((off, occ) =>
            matches.push({ pageIndex: i - 1, offset: off, occInPage: occ }),
          );
        }
        if (seq !== searchSeq.current) return;
        const s = usePdfStore.getState().byRef[path]?.search;
        if (!s || s.query !== query) return; // query 又变了，不覆盖
        patch(path, { search: { ...s, matches, activeIndex: matches.length ? 0 : -1 } });
        if (matches.length) jumpToPage(matches[0].pageIndex + 1);
      })();
    },
    [pdf, patch, path, getTextContent, jumpToPage],
  );

  const gotoMatch = useCallback(
    (delta: number) => {
      const m = search.matches;
      if (!m.length) return;
      const next = (search.activeIndex + delta + m.length) % m.length;
      patch(path, { search: { ...search, activeIndex: next } });
      jumpToPage(m[next].pageIndex + 1);
    },
    [search, patch, path, jumpToPage],
  );

  const closeSearch = useCallback(
    () => patch(path, { search: { open: false, query: '', matches: [], activeIndex: -1 } }),
    [patch, path],
  );

  const activeMatch = search.activeIndex >= 0 ? search.matches[search.activeIndex] : null;

  // ── 跨页选字复制：页边界注入 \n（PRD §选字，验收 5）──
  // 跨页选区横跨多个独立文字层 <div>，Chromium 原生 copy 换行不稳定——逐层取交集文本、页间插 \n。
  const onCopy = useCallback((e: React.ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const layers = scrollRef.current?.querySelectorAll('.oru-pdf-textlayer') ?? [];
    const parts: string[] = [];
    layers.forEach((layer) => {
      if (!range.intersectsNode(layer)) return;
      const txt = intersectText(range, layer);
      if (txt.trim()) parts.push(txt);
    });
    // 统一接管为纯文本、页间插 \n（设计 §5.3 定死，不留原生出口——跨页原生换行不稳定，单页也保持一致）
    if (parts.length) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', parts.join('\n'));
    }
  }, []);

  if (loadError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-canvas text-sm text-text-tertiary">
        {t(loadError === 'encrypted' ? 'error.encrypted' : 'error.corrupt')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具栏 */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-elevated/60 px-3">
        <PageIndicator current={currentPage} total={viewports.length} onJump={jumpToPage} t={t} />
        <div className="flex-1" />
        <ToolbarButton title={t('zoom.out')} disabled={!pdf} onClick={zoomOut}>
          <ZoomOut className="h-4 w-4" strokeWidth={1.5} />
        </ToolbarButton>
        <span className="w-11 text-center text-[11px] tabular-nums text-text-tertiary">
          {Math.round(scale * 100)}%
        </span>
        <ToolbarButton title={t('zoom.in')} disabled={!pdf} onClick={zoomIn}>
          <ZoomIn className="h-4 w-4" strokeWidth={1.5} />
        </ToolbarButton>
        <ToolbarButton title={t('zoom.fitWidth')} accent={fitWidth} disabled={!pdf} onClick={resetFit}>
          <MoveHorizontal className="h-4 w-4" strokeWidth={1.5} />
        </ToolbarButton>
        <div className="mx-1 h-4 w-px bg-border" />
        {search.open ? (
          <SearchBar
            query={search.query}
            count={search.matches.length}
            active={search.activeIndex}
            onQuery={runSearch}
            onPrev={() => gotoMatch(-1)}
            onNext={() => gotoMatch(1)}
            onClose={closeSearch}
            t={t}
          />
        ) : (
          <ToolbarButton title={t('search.open')} onClick={() => patch(path, { search: { ...search, open: true } })}>
            <Search className="h-4 w-4" strokeWidth={1.5} />
          </ToolbarButton>
        )}
      </div>

      {/* 页面区：连续垂直滚动，底色随主题（暗色为浅灰纸背衬，canvas 本身不反色） */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onCopy={onCopy}
        className="min-h-0 flex-1 overflow-auto bg-canvas"
      >
        {viewports.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-text-tertiary">{t('loading')}</div>
        ) : (
          <div className="flex flex-col items-center py-3" style={{ gap: PAGE_GAP }}>
            {viewports.map((vp, i) => (
              <PdfPage
                key={i}
                pageNum={i + 1}
                width={vp.width * scale}
                height={vp.height * scale}
                scale={scale}
                pdf={pdf}
                visible={visible.has(i + 1)}
                getTextContent={getTextContent}
                query={search.query}
                activeOcc={activeMatch?.pageIndex === i ? activeMatch.occInPage : null}
                registerEl={registerPageEl}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 求 range 与某文字层容器的交集文本。 */
function intersectText(range: Range, layer: Element): string {
  const inter = document.createRange();
  inter.selectNodeContents(layer);
  const r = range.cloneRange();
  if (r.compareBoundaryPoints(Range.START_TO_START, inter) < 0) r.setStart(inter.startContainer, inter.startOffset);
  if (r.compareBoundaryPoints(Range.END_TO_END, inter) > 0) r.setEnd(inter.endContainer, inter.endOffset);
  return r.toString();
}

/** 单页：占位 div（撑总高）+ 可视时渲染 canvas + 文字层。 */
function PdfPage({
  pageNum,
  width,
  height,
  scale,
  pdf,
  visible,
  getTextContent,
  query,
  activeOcc,
  registerEl,
}: {
  pageNum: number;
  width: number;
  height: number;
  scale: number;
  pdf: PDFDocumentProxy | null;
  visible: boolean;
  getTextContent: (n: number) => Promise<TextContent>;
  query: string;
  activeOcc: number | null;
  registerEl: (n: number, el: HTMLElement | null) => void;
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(0); // 自增：文字层渲染完触发高亮 effect

  useEffect(() => {
    registerEl(pageNum, wrapRef.current);
    return () => registerEl(pageNum, null);
  }, [pageNum, registerEl]);

  // 渲染 canvas + 文字层（可视 + scale 变时）
  useEffect(() => {
    if (!visible || !pdf) return;
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel: () => void } | null = null;
    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const outputScale = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // HiDPI 不发虚（验收 3）：像素放大 outputScale、CSS 尺寸不变、render 传 transform
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      renderTask = page.render({
        canvasContext: ctx,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      });
      try {
        await renderTask.promise;
      } catch (e) {
        if ((e as { name?: string })?.name === 'RenderingCancelledException') return;
        return;
      }
      if (cancelled) return;
      // 文字层
      const tlDiv = textRef.current;
      if (!tlDiv) return;
      tlDiv.replaceChildren();
      tlDiv.style.setProperty('--scale-factor', String(scale));
      const tc = await getTextContent(pageNum);
      if (cancelled) return;
      const { TextLayer } = pdfjs as unknown as { TextLayer: new (o: unknown) => { render: () => Promise<void> } };
      const layer = new TextLayer({ textContentSource: tc, container: tlDiv, viewport });
      await layer.render();
      if (cancelled) return;
      setRendered((v) => v + 1);
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [visible, pdf, pageNum, scale, getTextContent]);

  // 高亮：query / active 变时，扫本层 span 加类（不重渲染 canvas）
  useEffect(() => {
    const tlDiv = textRef.current;
    if (!tlDiv) return;
    applyHighlight(tlDiv, query, activeOcc);
  }, [query, activeOcc, rendered]);

  return (
    <div
      ref={wrapRef}
      data-page={pageNum}
      className="relative shadow-pop"
      style={{ width, height, background: 'white' }}
    >
      {visible ? (
        <>
          <canvas ref={canvasRef} className="block" />
          <div ref={textRef} className="oru-pdf-textlayer" />
        </>
      ) : null}
    </div>
  );
}

/**
 * 给命中 span 加高亮类；active（本页第 activeOcc 个命中）所在 span 加 active 类并滚入视图。
 * 按「出现序号」定位 active，不按字符 offset——跨 span 累计命中次数，命中数落到 activeOcc 的那个 span
 * 即为 active。这样即便 pdfjs 的 span 切分与 items.str 口径不完全一致，出现顺序仍稳定对齐（Bug#3）。
 */
function applyHighlight(container: HTMLElement, query: string, activeOcc: number | null): void {
  container.querySelectorAll('.oru-pdf-hit,.oru-pdf-hit-active').forEach((el) => {
    el.classList.remove('oru-pdf-hit', 'oru-pdf-hit-active');
  });
  if (!query) return;
  const q = query.toLowerCase();
  let occSeen = 0; // 已累计的命中次数
  for (const child of Array.from(container.children)) {
    if (!(child instanceof HTMLElement) || child.tagName !== 'SPAN') continue;
    const lower = (child.textContent ?? '').toLowerCase();
    if (!lower.includes(q)) continue;
    child.classList.add('oru-pdf-hit');
    // 本 span 内命中次数
    let n = 0;
    for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) n++;
    if (activeOcc !== null && activeOcc >= occSeen && activeOcc < occSeen + n) {
      child.classList.add('oru-pdf-hit-active');
      child.scrollIntoView({ block: 'center' });
    }
    occSeen += n;
  }
}

function PageIndicator({
  current,
  total,
  onJump,
  t,
}: {
  current: number;
  total: number;
  onJump: (n: number) => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  if (total === 0) return <span className="text-[11px] text-text-tertiary" />;
  return (
    <div className="flex items-center gap-1 text-[11px] tabular-nums text-text-secondary">
      {editing !== null ? (
        <input
          autoFocus
          value={editing}
          onChange={(e) => setEditing(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const n = Number(editing);
              if (n) onJump(n);
              setEditing(null);
            } else if (e.key === 'Escape') setEditing(null);
          }}
          aria-label={t('page.jumpAria')}
          className="h-5 w-9 rounded border border-border bg-elevated px-1 text-center outline-none focus:border-accent"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(String(current))}
          className="rounded px-1 hover:bg-hover"
          title={t('page.jumpAria')}
        >
          {t('page.indicator', { current, total })}
        </button>
      )}
    </div>
  );
}

function ToolbarButton({
  title,
  accent,
  disabled,
  onClick,
  children,
}: {
  title: string;
  accent?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded transition-colors',
        disabled
          ? 'cursor-default text-text-tertiary opacity-40'
          : accent
            ? 'text-accent hover:bg-hover'
            : 'text-text-tertiary hover:bg-hover hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}
