/**
 * useImagePicker 拖拽分流（文件引用进对话 §4.2）：
 * - 文件树拖来的（application/x-oru-file）→ 走 onDropFileRef（一律引用，含图片，决策三）。
 * - 系统/外部图片拖入 → 走 onAddFiles（视觉附件，无回归）。
 * - onDragOver 放行判定：含 'Files' 或自定义 mime 才 preventDefault（drop 死活的开关）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useImagePicker } from '@/components/ui/useImagePicker';
import { FILE_DRAG_MIME } from '@/lib/fileDrag';

afterEach(cleanup);

/** 造一个最小 DragEvent 替身——只实现 hook 真正读的字段 */
function dragEvent(opts: {
  types?: string[];
  fileRef?: { path?: string; name?: string; paths?: string[] };
  files?: Array<{ type: string }>;
}) {
  const preventDefault = vi.fn();
  return {
    preventDefault,
    dataTransfer: {
      types: opts.types ?? [],
      files: opts.files ?? [],
      getData: (t: string) =>
        t === FILE_DRAG_MIME && opts.fileRef ? JSON.stringify(opts.fileRef) : '',
    },
  } as unknown as Parameters<ReturnType<typeof useImagePicker>['dragHandlers']['onDrop']>[0];
}

describe('useImagePicker — 拖拽分流', () => {
  it('文件树拖来的（自定义 mime）→ onDropFileRef，不碰 onAddFiles', () => {
    const onAddFiles = vi.fn(() => null);
    const onDropFileRef = vi.fn();
    const { result } = renderHook(() => useImagePicker(onAddFiles, onDropFileRef));

    act(() => {
      result.current.dragHandlers.onDrop(
        dragEvent({ types: [FILE_DRAG_MIME], fileRef: { path: 'reports/a.md', name: 'a.md' } }),
      );
    });

    expect(onDropFileRef).toHaveBeenCalledWith({ path: 'reports/a.md', name: 'a.md' });
    expect(onAddFiles).not.toHaveBeenCalled();
  });

  it('多选拖来的（paths[]）→ 整组都引用，不丢其余', () => {
    const onDropFileRef = vi.fn();
    const { result } = renderHook(() => useImagePicker(() => null, onDropFileRef));

    act(() => {
      result.current.dragHandlers.onDrop(
        dragEvent({ types: [FILE_DRAG_MIME], fileRef: { paths: ['a.md', 'docs/b.md'] } }),
      );
    });

    expect(onDropFileRef).toHaveBeenCalledTimes(2);
    expect(onDropFileRef).toHaveBeenCalledWith({ path: 'a.md', name: 'a.md' });
    expect(onDropFileRef).toHaveBeenCalledWith({ path: 'docs/b.md', name: 'b.md' });
  });

  it('系统图片拖入（无自定义 mime）→ onAddFiles（视觉，无回归）', () => {
    const onAddFiles = vi.fn(() => null);
    const onDropFileRef = vi.fn();
    const { result } = renderHook(() => useImagePicker(onAddFiles, onDropFileRef));

    act(() => {
      result.current.dragHandlers.onDrop(
        dragEvent({ types: ['Files'], files: [{ type: 'image/png' }] }),
      );
    });

    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onDropFileRef).not.toHaveBeenCalled();
  });

  it('onDragOver 放行：自定义 mime 时 preventDefault + ring 亮', () => {
    const { result } = renderHook(() => useImagePicker(() => null, vi.fn()));
    const ev = dragEvent({ types: [FILE_DRAG_MIME] });
    act(() => result.current.dragHandlers.onDragOver(ev));
    expect((ev.preventDefault as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(result.current.isDragOver).toBe(true);
  });

  it('未提供 onDropFileRef（如评论框）→ 自定义 mime 不放行、不识别 file ref（行为不变）', () => {
    const onAddFiles = vi.fn(() => null);
    const { result } = renderHook(() => useImagePicker(onAddFiles));
    const over = dragEvent({ types: [FILE_DRAG_MIME] });
    act(() => result.current.dragHandlers.onDragOver(over));
    expect((over.preventDefault as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.current.isDragOver).toBe(false);
  });
});
