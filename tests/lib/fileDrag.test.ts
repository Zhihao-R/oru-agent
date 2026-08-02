import { describe, it, expect } from 'vitest';
import type { DragEvent } from 'react';
import { FILE_DRAG_MIME, setFileDragData, readFileDragPayload } from '@/lib/fileDrag';

function fakeEvent(): DragEvent {
  const store: Record<string, string> = {};
  return {
    dataTransfer: {
      setData: (k: string, v: string) => {
        store[k] = v;
      },
      getData: (k: string) => store[k] ?? '',
      effectAllowed: '',
    },
  } as unknown as DragEvent;
}

describe('fileDrag', () => {
  it('setData → readPayload round-trip', () => {
    const e = fakeEvent();
    setFileDragData(e, { paths: ['a/b.md'], path: 'a/b.md', name: 'b.md' });
    expect(readFileDragPayload(e)).toEqual({ paths: ['a/b.md'], path: 'a/b.md', name: 'b.md' });
  });
  it('MIME 是 application/x-oru-file', () => {
    expect(FILE_DRAG_MIME).toBe('application/x-oru-file');
  });
  it('坏 payload 回 null', () => {
    const e = fakeEvent();
    e.dataTransfer.setData(FILE_DRAG_MIME, '{bad');
    expect(readFileDragPayload(e)).toBeNull();
  });
  it('无 MIME 回 null', () => {
    expect(readFileDragPayload(fakeEvent())).toBeNull();
  });
});
