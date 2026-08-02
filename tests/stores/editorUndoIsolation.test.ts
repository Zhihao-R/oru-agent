// @vitest-environment jsdom

/**
 * S27 · G94 外部换入不进撤销栈（attacker）。
 *  - Ctrl+Z 撤的是用户自己敲的字，不是换入的内容（addToHistory.of(false) 隔离）；
 *  - 破坏性换入命中撤销栈已记录区域 → 清空该 view history，撤销不再拼出双方都没写过的脏内容；
 *  - 纯插入换入（AI 在别处追加）不动既有文本 → 撤销栈原样保留，Ctrl+Z 仍撤用户的字。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { undo, undoDepth } from '@codemirror/commands';
import { useEditorStore } from '@/stores/editorStore';
import { editorHistoryExtension } from '@/components/editor/editorHistory';
import { registerEditorView, __clearEditorViewsForTest } from '@/components/editor/editorViewRegistry';

const S = () => useEditorStore.getState();
const PRJ = 'prj';
const PATH = 'a.md';
let disk: Record<string, string> = {};

const openViews: EditorView[] = [];
function makeHistoryView(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [editorHistoryExtension()] }), parent });
  openViews.push(view);
  return view;
}

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockImplementation((p: { type: string; projectId?: string; path?: string; content?: string }) => {
    switch (p.type) {
      case 'fs.readMd':
        return Promise.resolve({ type: 'fs.md.content', projectId: p.projectId, path: p.path, content: disk[p.path!] ?? '' });
      case 'fs.history.sample':
        return Promise.resolve({ type: 'ack' });
      default:
        return Promise.reject(new Error('unexpected ' + p.type));
    }
  });
  disk = {};
  useEditorStore.setState({ files: {} });
});

afterEach(() => {
  for (const p of Object.keys(S().files)) S().close(p);
  while (openViews.length) openViews.pop()!.destroy(); // 销毁 view 取消挂起的 measure rAF（jsdom 无 getClientRects 会异步抛）
  document.body.innerHTML = '';
  __clearEditorViewsForTest();
});

describe('G94 外部换入不进撤销栈', () => {
  it('纯插入换入（AI 别处追加）→ 撤销栈保留：Ctrl+Z 撤用户的字、换入内容留住', async () => {
    disk[PATH] = 'hello';
    await S().open(PRJ, PATH);
    const view = makeHistoryView('hello');
    registerEditorView(PATH, view);
    view.dispatch({ changes: { from: 5, insert: ' world' } }); // 用户敲字（进撤销栈）→ 'hello world'
    expect(undoDepth(view.state)).toBe(1);

    disk[PATH] = 'INTRO\nhello world'; // AI 在开头追加（纯插入，不动既有文本）
    await S().syncFromDisk(PATH);
    expect(view.state.doc.toString()).toBe('INTRO\nhello world'); // 换入落入

    undo(view); // Ctrl+Z
    expect(view.state.doc.toString()).toBe('INTRO\nhello'); // 撤的是用户敲的 ' world'，换入的 'INTRO' 留住
  });

  it('破坏性换入命中已记录区域 → 清空 history：撤销不拼出双方都没写过的脏内容', async () => {
    disk[PATH] = 'hello';
    await S().open(PRJ, PATH);
    const view = makeHistoryView('hello');
    registerEditorView(PATH, view);
    view.dispatch({ changes: { from: 5, insert: ' world' } }); // 用户敲字 → 'hello world'
    expect(undoDepth(view.state)).toBe(1);

    disk[PATH] = 'hello PLANET'; // AI 替换 'world'→'PLANET'（破坏性、命中用户敲字区域）
    await S().syncFromDisk(PATH);
    expect(view.state.doc.toString()).toBe('hello PLANET');
    expect(undoDepth(view.state)).toBe(0); // 撤销栈已作废清空

    undo(view); // 无可撤销
    expect(view.state.doc.toString()).toBe('hello PLANET'); // 不回退成 'hello world' / 不拼出 'hello worldPLANET' 等脏内容
  });
});
