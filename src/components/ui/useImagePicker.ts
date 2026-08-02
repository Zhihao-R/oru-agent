/**
 * 选图三件套（文件选择器 / 粘贴 / 拖拽）的 DOM 接线，聊天与评论输入框共用。
 *
 * 职责边界：只把"图片文件"从 input/clipboard/drag 里提取出来交给 onAddFiles；
 * 校验、上限、状态与 vision 门控都由 onAddFiles 决定——返回非 null 字符串即拒绝原因，本 hook alert。
 */
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { FILE_DRAG_MIME } from '@/lib/fileDrag';

/**
 * 解析文件树拖拽 payload（x-oru-file）→ 要引用的文件列表。
 * 多选带 paths[] 则整组引用（name 取末段）；否则回退单个 {path,name}；坏 payload 返回 []。
 */
export function parseFileRefDrop(raw: string): { path: string; name: string }[] {
  try {
    const data = JSON.parse(raw) as { path?: string; name?: string; paths?: string[] };
    if (Array.isArray(data.paths) && data.paths.length > 0) {
      return data.paths.map((p) => ({ path: p, name: p.split('/').pop() ?? p }));
    }
    if (typeof data.path === 'string') {
      return [{ path: data.path, name: data.name ?? data.path.split('/').pop() ?? data.path }];
    }
    return [];
  } catch {
    return []; // 坏 payload：忽略
  }
}

/**
 * onAddFiles：系统/外部拖入的图片文件（视觉附件，现状不变）。
 * onDropFileRef：文件树拖来的条目（一律走引用，含图片，决策三）；不传则该路径不开放（如评论框）。
 */
export function useImagePicker(
  onAddFiles: (files: File[]) => string | null,
  onDropFileRef?: (data: { path: string; name: string }) => void,
) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (files: File[]) => {
    if (files.length === 0) return;
    const reason = onAddFiles(files);
    if (reason) alert(reason);
  };

  const onPickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    handleFiles(Array.from(list));
  };

  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return; // 纯文本粘贴：让默认行为继续
    e.preventDefault(); // 含图：阻止 textarea 把图当文本处理
    handleFiles(files);
  };

  const onDrop = (e: DragEvent) => {
    // 文件树拖来的（带自定义 mime）→ 一律走引用，不分图片（决策三）
    const fileRefRaw = onDropFileRef ? e.dataTransfer.getData(FILE_DRAG_MIME) : '';
    if (fileRefRaw) {
      e.preventDefault();
      setIsDragOver(false);
      // 多选时 payload 带整组 paths——逐条引用，别只取主项（parseFileRefDrop 同时兜住坏 payload）
      for (const item of parseFileRefDrop(fileRefRaw)) onDropFileRef!(item);
      return;
    }
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    handleFiles(files);
  };

  const onDragOver = (e: DragEvent) => {
    // 不放行自定义 mime，drop 根本不触发、ring 也不亮——这是 drop 死活的开关（§4.2）
    const types = e.dataTransfer.types;
    if (types.includes('Files') || (onDropFileRef && types.includes(FILE_DRAG_MIME))) {
      e.preventDefault();
      setIsDragOver(true);
    }
  };

  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget === e.target) setIsDragOver(false);
  };

  const openPicker = () => fileInputRef.current?.click();

  return {
    isDragOver,
    fileInputRef,
    openPicker,
    onPickFiles,
    onPaste,
    dragHandlers: { onDrop, onDragOver, onDragLeave },
  };
}
