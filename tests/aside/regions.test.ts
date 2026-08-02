/** @vitest-environment jsdom */
/**
 * 场所感（二期 §4）——两层缺一不可：
 * - 定位层：resolver 在现有解析之外读 closest('[data-aside-region]')，各档 referent
 *   带可选 region；锚点缺失 / 值不在闭集 → region 缺席（不硬认，宁缺毋错）
 * - 锚点契约：一期两个内容锚点（data-message-id / data-chat-area）+ 二期区域锚点
 *   收编成一份清单，逐项验证挂在源码里——UI 重构丢锚点时本测试红，不再静默降档
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '@shared/types';
import { ASIDE_REGION_ATTR, ASIDE_REGION_IDS } from '@shared/asideRegions';
import { resolveAsideReferent, type AsideResolveArgs } from '../../src/aside/resolve';

function makeArgs(overrides: Partial<AsideResolveArgs>): AsideResolveArgs {
  return {
    target: null,
    selectionText: '',
    selectionAnchorEl: null,
    getEditorSelection: () => '',
    findMessage: () => null,
    getActiveMessages: () => [],
    ...overrides,
  };
}

function msg(id: string, text: string): ChatMessage {
  return {
    id,
    conversationId: 'conv-1',
    role: 'assistant',
    text,
    toolCalls: [],
    createdAt: 1,
    done: true,
  };
}

describe('resolver 的区域识别', () => {
  it('点击目标在 data-aside-region="memory" 内 → referent.region = "memory"', () => {
    document.body.innerHTML = `<div ${ASIDE_REGION_ATTR}="memory"><p id="t">一段记忆</p></div>`;
    const referent = resolveAsideReferent(
      makeArgs({ target: document.getElementById('t') }),
    );
    expect(referent.region).toBe('memory');
  });

  it('消息档同样带 region（区域与内容锚点正交）', () => {
    document.body.innerHTML = `<div ${ASIDE_REGION_ATTR}="chat"><div data-message-id="m1" id="t">hi</div></div>`;
    const referent = resolveAsideReferent(
      makeArgs({
        target: document.getElementById('t'),
        findMessage: (id) => (id === 'm1' ? { list: [msg('m1', 'hi')], index: 0 } : null),
      }),
    );
    expect(referent.type).toBe('message');
    expect(referent.region).toBe('chat');
  });

  it('无区域锚点 → region 缺席（不硬认）', () => {
    document.body.innerHTML = `<div><p id="t">游离内容</p></div>`;
    const referent = resolveAsideReferent(makeArgs({ target: document.getElementById('t') }));
    expect(referent.region).toBeUndefined();
  });

  it('锚点值不在闭集 → region 缺席（脏值不进指代卡）', () => {
    document.body.innerHTML = `<div ${ASIDE_REGION_ATTR}="not-a-region"><p id="t">x</p></div>`;
    const referent = resolveAsideReferent(makeArgs({ target: document.getElementById('t') }));
    expect(referent.region).toBeUndefined();
  });
});

// ─── 锚点契约：清单逐项过，丢锚点测试红（给大型 UI 重构上的保险） ──────

/** 锚点 → 挂载组件源文件的契约清单（源码级断言：重构移走属性立刻红） */
const ANCHOR_CONTRACT: Array<{ anchor: string; file: string }> = [
  { anchor: 'data-chat-area', file: 'src/components/chat/ChatArea.tsx' },
  { anchor: 'data-message-id', file: 'src/components/chat/ChatMessage.tsx' },
  { anchor: `${ASIDE_REGION_ATTR}="chat"`, file: 'src/components/chat/ChatArea.tsx' },
  { anchor: `${ASIDE_REGION_ATTR}="memory"`, file: 'src/components/home/HomeLanding.tsx' },
  { anchor: `${ASIDE_REGION_ATTR}="settings"`, file: 'src/pages/SettingsPage.tsx' },
  { anchor: `${ASIDE_REGION_ATTR}="file-tree"`, file: 'src/components/FileTree.tsx' },
  { anchor: `${ASIDE_REGION_ATTR}="editor"`, file: 'src/components/editor/EditorPane.tsx' },
];

describe('锚点契约清单', () => {
  it.each(ANCHOR_CONTRACT)('$file 挂有 $anchor', ({ anchor, file }) => {
    // 剥掉注释行再匹配——挂点旁的注释常含同名字符串（如 ChatArea 的 data-chat-area 说明），
    // 重构删了真属性、留下注释时不许假绿
    const src = readFileSync(join(process.cwd(), file), 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');
    expect(src.includes(anchor), `${file} 缺锚点 ${anchor}`).toBe(true);
  });

  it('deck 预览的 region 在 host 翻译层注入（webview 内点不经 DOM resolver）', async () => {
    const { translateDeckAsideClick } = await import('../../src/aside/deckClick');
    const referent = translateDeckAsideClick(
      { pageIndex: 0, pageText: '第一页', selectionText: '', outline: ['开场'], x: 1, y: 1 },
      '',
    );
    expect(referent.region).toBe('deck-preview');
  });

  it('区域 id 闭集与挂载契约一一对应（加区域必须同步加挂点）', () => {
    const mounted = new Set(
      ANCHOR_CONTRACT.map((c) => /data-aside-region="([^"]+)"/.exec(c.anchor)?.[1]).filter(
        Boolean,
      ),
    );
    mounted.add('deck-preview'); // host 翻译层注入，不走 DOM 锚点
    expect([...ASIDE_REGION_IDS].sort()).toEqual([...mounted].sort());
  });
});
