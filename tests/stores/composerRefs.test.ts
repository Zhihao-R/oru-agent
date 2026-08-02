/**
 * composer 引用桶的 key 解析 + 草稿→真对话交接
 *
 * 回归目标：新对话（草稿态）里右键「引用到对话」/ 拖拽引用要写进可见的草稿桶，
 * 并在发送建会话时随之转移到新会话——不能像旧版那样静默丢掉。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { composerKey, useChatStore } from '@/stores/chatStore';
import type { ChatRef } from '@shared/types';

const AGENT = 'agt_1';
const CONV = 'cnv_1';

function fileRef(id: string, name: string): ChatRef {
  return { id, kind: 'file', quote: name, sourcePath: name };
}

beforeEach(() => {
  useChatStore.setState({ composerRefsByConv: {} });
});

describe('composerKey', () => {
  it('有活跃对话时用真会话 id', () => {
    expect(composerKey(AGENT, CONV)).toBe(CONV);
  });

  it('草稿态（无活跃对话）落到 per-agent 草稿桶', () => {
    expect(composerKey(AGENT, null)).toBe(`draft:${AGENT}`);
  });

  it('无 agent 时无桶可写', () => {
    expect(composerKey(null, null)).toBeNull();
  });
});

describe('migrateComposerRefs', () => {
  it('把草稿桶的引用搬到新会话并清空源桶', () => {
    const draftKey = `draft:${AGENT}`;
    useChatStore.setState({ composerRefsByConv: { [draftKey]: [fileRef('r1', 'a.md')] } });

    useChatStore.getState().migrateComposerRefs(draftKey, CONV);

    const map = useChatStore.getState().composerRefsByConv;
    expect(map[CONV]).toEqual([fileRef('r1', 'a.md')]);
    expect(map[draftKey] ?? []).toEqual([]);
  });

  it('目标已有引用时追加而非覆盖', () => {
    const draftKey = `draft:${AGENT}`;
    useChatStore.setState({
      composerRefsByConv: { [draftKey]: [fileRef('r2', 'b.md')], [CONV]: [fileRef('r1', 'a.md')] },
    });

    useChatStore.getState().migrateComposerRefs(draftKey, CONV);

    expect(useChatStore.getState().composerRefsByConv[CONV]).toEqual([
      fileRef('r1', 'a.md'),
      fileRef('r2', 'b.md'),
    ]);
  });

  it('源桶为空时不动目标', () => {
    useChatStore.setState({ composerRefsByConv: { [CONV]: [fileRef('r1', 'a.md')] } });

    useChatStore.getState().migrateComposerRefs(`draft:${AGENT}`, CONV);

    expect(useChatStore.getState().composerRefsByConv[CONV]).toEqual([fileRef('r1', 'a.md')]);
  });
});
