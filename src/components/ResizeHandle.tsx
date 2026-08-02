/**
 * 拖拽分隔条：1px 视觉宽 + 4px 命中区，按下后接管全局光标
 * - side='left'  → 拖右增大左侧栏宽度
 * - side='right' → 拖右减少右侧栏宽度
 * - mousemove 用 rAF 折叠到一帧一次，避免高频更新触发 React 反复 reconcile
 * - 松手时调 onCommit（用于持久化），中途只更新内存状态
 */
import { useRef, type MouseEvent } from 'react';

type Props = {
  side: 'left' | 'right';
  current: number;
  onChange: (next: number) => void;
  onCommit?: () => void;
};

export function ResizeHandle({ side, current, onChange, onCommit }: Props): JSX.Element {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  function handleMouseDown(e: MouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = current;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // 屏蔽 webview 截获 mouse 事件——配合 index.css 'body.oru-resizing webview' 规则
    document.body.classList.add('oru-resizing');

    let pendingWidth = startWidth;
    let frame = 0;

    function flush(): void {
      frame = 0;
      onChangeRef.current(pendingWidth);
    }
    function onMove(ev: globalThis.MouseEvent): void {
      const dx = ev.clientX - startX;
      pendingWidth = side === 'left' ? startWidth + dx : startWidth - dx;
      if (frame === 0) frame = requestAnimationFrame(flush);
    }
    function onUp(): void {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
        onChangeRef.current(pendingWidth);
      }
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      document.body.classList.remove('oru-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      onCommitRef.current?.();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={handleMouseDown}
      onDoubleClick={(e) => e.preventDefault()}
      className="group relative z-10 w-px shrink-0 cursor-col-resize bg-border"
    >
      {/* 命中区：透明，仅用于扩大抓取范围 */}
      <span aria-hidden className="absolute inset-y-0 -left-1 -right-1" />
      {/* hover 指示：垂直居中浮现一段圆角胶囊（长椭圆） */}
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-active:opacity-100"
      />
    </div>
  );
}
