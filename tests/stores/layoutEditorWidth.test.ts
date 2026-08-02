// @vitest-environment jsdom
/**
 * editorWidth 的对话区预留——html 预览态有两列（HtmlViewer + 恒显批注栏），
 * editorWidth 的可拖上限必须把批注栏那一列也算进去，否则对话区被挤没（回归目标）。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  EDITOR_BOUNDS,
  MIN_CHAT_WIDTH,
  useLayoutStore,
} from '@/stores/layoutStore';

const VW = 1600;

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: VW, configurable: true });
  useLayoutStore.setState({
    sidebarWidth: 260,
    autoHideSidebar: false,
    sidebarCollapsed: false,
    editorWidth: EDITOR_BOUNDS.default,
  });
});

describe('setEditorWidth 的对话区预留', () => {
  it('单列模式（无额外预留）：上限只扣侧栏 + 对话区最小宽', () => {
    useLayoutStore.getState().setEditorWidth(9999);
    expect(useLayoutStore.getState().editorWidth).toBe(VW - 260 - MIN_CHAT_WIDTH);
  });

  it('html 两列模式：上限还要再扣批注栏宽，对话区恰好留够 MIN_CHAT_WIDTH', () => {
    const annot = 400;
    useLayoutStore.getState().setEditorWidth(9999, annot);
    const { editorWidth } = useLayoutStore.getState();
    expect(editorWidth).toBe(VW - 260 - MIN_CHAT_WIDTH - annot);
    // 不变量：侧栏 + editor + 批注栏 + 对话区 = 视口，且对话区 ≥ 最小宽
    const chat = VW - 260 - editorWidth - annot;
    expect(chat).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH);
  });

  it('视口太窄时退回 editor 最小宽（对话区溢出交给 flex，不让 editor 反吃）', () => {
    Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });
    useLayoutStore.getState().setEditorWidth(9999, 400);
    expect(useLayoutStore.getState().editorWidth).toBe(EDITOR_BOUNDS.min);
  });
});
