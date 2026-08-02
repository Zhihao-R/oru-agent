/**
 * 记忆卡「查看」落点回归测试
 *
 * 修前的两个缺陷：
 * 1.「改一下」是个装成按钮的 <span>（有图标和按钮内距，却没有 onClick），点了毫无反应——
 *   编辑入口本就在档案浮层内置的 ✎ 里，卡片上这个是重复且失效的。
 * 2.「查看」不分记忆种类一律开笔记浮层。档案类记忆（user/profile.md、self.md、projects/*）
 *   不在 episodes 列表里，NoteDetailOverlay 找不到就 return null——用户被弹去手账页，
 *   却什么都没弹出来。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage, MemoryRecordPayload } from '@shared/types';

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: () => Promise.resolve({ type: 'noop' }),
    subscribe: () => () => {},
    onStatus: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

// 浮层内部各有自己的测试，这里被测的是「哪种记忆开哪个浮层」的分发——把两个落点替换成探针
vi.mock('@/components/memory/ProfileDocView', () => ({
  ProfileDocView: ((props) => (
    <div data-testid="doc-view" data-relpath={props.relPath}>
      {props.title}
    </div>
  )) satisfies React.FC<import('@/components/memory/ProfileDocView').ProfileDocViewProps>,
}));
vi.mock('@/components/home/overlays/NoteDetailOverlay', () => ({
  NoteDetailOverlay: ((props) => (
    <div data-testid="note-detail" data-relpath={props.relPath} />
  )) satisfies React.FC<import('@/components/home/overlays/NoteDetailOverlay').NoteDetailOverlayProps>,
}));

import { MemoryRecordCard } from '@/components/chat/MemoryRecordCard';
import { MemoryRecordOverlay } from '@/components/chat/MemoryRecordOverlay';
import { useProjectStore } from '@/stores/projectStore';
import { useMemoryStore } from '@/stores/memoryStore';
import { useChatStore } from '@/stores/chatStore';

function makeRecord(over: Partial<MemoryRecordPayload> = {}): MemoryRecordPayload {
  return {
    relPath: 'user/profile.md',
    preview: '称呼：阮子',
    scope: 'personal',
    type: 'user-basic',
    ...over,
  };
}

function makeMessage(record: MemoryRecordPayload): ChatMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'system',
    text: `已记下 ${record.preview}`,
    toolCalls: [],
    createdAt: 0,
    done: true,
    kind: 'memory-record',
    memoryRecord: record,
  };
}

afterEach(() => {
  cleanup();
  // 两个 store 是模块级单例，用例间不清会互相污染落点判定
  useMemoryStore.setState({ episodes: [] });
  useProjectStore.setState({ projects: [] });
  useChatStore.setState({ conversations: {} });
});

describe('MemoryRecordCard', () => {
  it('不再渲染「改一下」——编辑入口在浮层内，卡片上那个是点不动的死元素', () => {
    render(<MemoryRecordCard message={makeMessage(makeRecord())} onView={() => {}} />);
    expect(screen.queryByText('改一下')).toBeNull();
    expect(screen.getByText('撤销')).toBeTruthy();
    expect(screen.getByText('查看')).toBeTruthy();
  });

  it('点「查看」把记忆交给宿主开浮层（不再跳手账页）', () => {
    const onView = vi.fn();
    const record = makeRecord();
    render(<MemoryRecordCard message={makeMessage(record)} onView={onView} />);
    fireEvent.click(screen.getByText('查看'));
    expect(onView).toHaveBeenCalledWith(record);
  });

  it('档案改动显示前后对照——只贴新内容的话，用户没有判断该不该撤回的依据', () => {
    const record = makeRecord({ replaced: '- 称呼：阮子，男', revertHash: 'h1' });
    render(<MemoryRecordCard message={makeMessage(record)} onView={() => {}} />);
    expect(screen.getByText('- 称呼：阮子，男')).toBeTruthy(); // 旧文（划掉）
    expect(screen.getByText(record.preview)).toBeTruthy(); // 新文
  });

  it('档案卡的按钮是「撤回这次修改」，事件卡才是「撤销」', () => {
    const doc = makeRecord({ revertHash: 'h1' });
    const { unmount } = render(<MemoryRecordCard message={makeMessage(doc)} onView={() => {}} />);
    expect(screen.getByText('撤回这次修改')).toBeTruthy();
    expect(screen.queryByText('撤销')).toBeNull();
    unmount();

    const ep = makeRecord({ relPath: 'agents/twin/episodes/x.md', scope: 'agent', type: 'episode' });
    render(<MemoryRecordCard message={makeMessage(ep)} onView={() => {}} />);
    expect(screen.getByText('撤销')).toBeTruthy();
  });

  it('整篇覆盖报出动了哪几个小节——只说「整篇重写了」等于什么都没说', () => {
    // 主进程对 write_memory 留空 preview（见 memory/tools.ts），文案在渲染端才随语言切换走
    const record = makeRecord({
      preview: '',
      revertHash: 'h1',
      sections: { added: ['饮食习惯'], changed: ['作息'], removed: ['工作节奏'] },
    });
    render(<MemoryRecordCard message={makeMessage(record)} onView={() => {}} />);
    expect(screen.getByText('整篇重写了《关于你》')).toBeTruthy();
    expect(screen.getByText('新增「饮食习惯」，改写「作息」，删除「工作节奏」')).toBeTruthy();
  });

  it('删掉一段的卡片说「删掉了这段」，不留半截空白', () => {
    const record = makeRecord({ preview: '', replaced: '- 现居成都', revertHash: 'h1' });
    render(<MemoryRecordCard message={makeMessage(record)} onView={() => {}} />);
    expect(screen.getByText('- 现居成都')).toBeTruthy();
    expect(screen.getByText('删掉了这段')).toBeTruthy();
  });

  it('同一档案后来又改过 → 更早那张卡的撤回置灰但仍可点，点了说明原因', () => {
    // disabled 的按钮 Tab 不到、也没有 hover——理由就只剩鼠标用户看得见，那正是「改一下」的毛病
    const older = makeMessage(makeRecord({ revertHash: 'h1' }));
    const newer = { ...makeMessage(makeRecord({ revertHash: 'h2' })), id: 'm2' };
    useChatStore.setState({ conversations: { c1: [older, newer] } });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);

    render(<MemoryRecordCard message={older} onView={() => {}} />);
    const btn = screen.getByText('撤回这次修改').closest('button')!;
    expect(btn.disabled).toBe(false); // 可聚焦、可点
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toContain('之后又改过');

    fireEvent.click(btn);
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('之后又改过'));
    expect(confirmSpy).not.toHaveBeenCalled(); // 不先问「要撤吗」再反悔
    alertSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it('最近那张卡的撤回不置灰', () => {
    const older = makeMessage(makeRecord({ revertHash: 'h1' }));
    const newer = { ...makeMessage(makeRecord({ revertHash: 'h2' })), id: 'm2' };
    useChatStore.setState({ conversations: { c1: [older, newer] } });

    render(<MemoryRecordCard message={newer} onView={() => {}} />);
    expect(
      screen.getByText('撤回这次修改').closest('button')?.getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('已撤销的卡片不给任何动作', () => {
    render(<MemoryRecordCard message={makeMessage(makeRecord({ undone: true }))} onView={() => {}} />);
    expect(screen.queryByText('查看')).toBeNull();
    expect(screen.getByText('已撤销')).toBeTruthy();
  });
});

describe('MemoryRecordOverlay 落点分发', () => {
  it('用户档案开档案视图（修前走笔记浮层 → 白弹）', () => {
    render(<MemoryRecordOverlay record={makeRecord()} onClose={() => {}} />);
    const view = screen.getByTestId('doc-view');
    expect(view.getAttribute('data-relpath')).toBe('user/profile.md');
    expect(view.textContent).toBe('关于你');
    expect(screen.queryByTestId('note-detail')).toBeNull();
  });

  it('Oru 自我档案开档案视图，标题带个体名（无名回落 Oru）', () => {
    const record = makeRecord({ relPath: 'agents/twin/self.md', scope: 'agent', type: 'self' });
    render(<MemoryRecordOverlay record={record} onClose={() => {}} />);
    const view = screen.getByTestId('doc-view');
    expect(view.getAttribute('data-relpath')).toBe('agents/twin/self.md');
    expect(view.textContent).toBe('关于 Oru');
  });

  it('项目档案开档案视图，标题取项目名', () => {
    useProjectStore.setState({
      projects: [
        {
          id: 'p1',
          ownerId: 'local-user',
          name: '猎户座',
          path: '/tmp/p1',
          addedAt: 0,
          lastOpenedAt: 0,
          hasClaudeMd: false,
        },
      ],
    });
    const record = makeRecord({ relPath: 'projects/p1/profile.md', scope: 'project' });
    render(<MemoryRecordOverlay record={record} onClose={() => {}} />);
    expect(screen.getByTestId('doc-view').textContent).toBe('猎户座');
  });

  it('历史卡片的旧 type 值 persona 仍开自我档案——标题不能落成「关于你」', () => {
    // shared/types.ts 注明 fact / preference / persona 是已持久化的历史值，类型联合只列新值，
    // 故这里按它在 JSONL 里的真实形态构造。self.md 恒 scope=agent（tools.ts 的 cardMetaForDoc），
    // 落点按 scope 判就与 type 的历史包袱无关——改回按 type 判，这条会红。
    const record: MemoryRecordPayload = {
      ...makeRecord({ relPath: 'agents/twin/self.md', scope: 'agent' }),
      type: 'persona' as MemoryRecordPayload['type'],
    };
    render(<MemoryRecordOverlay record={record} onClose={() => {}} />);
    expect(screen.getByTestId('doc-view').textContent).toBe('关于 Oru');
  });

  it('事件记忆开笔记详情', () => {
    const relPath = 'agents/twin/episodes/2026-07-27-x.md';
    useMemoryStore.setState({
      episodes: [
        {
          relPath,
          title: '定了配色',
          scope: 'agent',
          tags: [],
          mtime: 0,
          status: 'active',
          type: 'agent',
          description: '',
          date: '2026-07-27',
        },
      ],
    });
    const record = makeRecord({ relPath, scope: 'agent', type: 'episode' });
    render(<MemoryRecordOverlay record={record} onClose={() => {}} />);
    expect(screen.getByTestId('note-detail').getAttribute('data-relpath')).toBe(relPath);
    expect(screen.queryByTestId('doc-view')).toBeNull();
  });

  it('已被整理掉的事件记忆明说它没了，而不是什么都不显示', async () => {
    // 被 dream 取代 / 被删的 episode 会挪进 archived/，relPath 永远对不上 episodes 列表。
    // NoteDetailOverlay 这时 return null——连遮罩都没有，点击等于石沉大海（正是本次要根除的形态）。
    const record = makeRecord({
      relPath: 'agents/twin/episodes/2026-01-01-gone.md',
      scope: 'agent',
      type: 'episode',
    });
    render(<MemoryRecordOverlay record={record} onClose={() => {}} />);
    expect(await screen.findByText(/这条记忆已经不在了/)).toBeTruthy();
    expect(screen.queryByTestId('note-detail')).toBeNull();
  });
});
