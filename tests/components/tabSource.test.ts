import { describe, it, expect, beforeEach } from 'vitest';
import { tabSourcePath } from '@/components/workspace/tabSource';
import { useArtifactStore } from '@/stores/artifactStore';
import { useProjectStore } from '@/stores/projectStore';
import { makeTab } from '@/stores/workspaceStore';

describe('tabSourcePath', () => {
  beforeEach(() => {
    useArtifactStore.setState({ artifactsByProject: {} });
    useProjectStore.setState({ projects: [], activeProjectId: null });
  });

  it('文件类标签直接用 ref 当路径', () => {
    const tab = makeTab({ kind: 'editor', projectId: 'p1', ref: 'docs/a.md', title: 'a.md' });
    expect(tabSourcePath(tab)).toEqual({ path: 'docs/a.md', name: 'a.md' });
  });

  it('deck 标签经记录把绝对路径转项目相对', () => {
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'Proj', path: '/Users/a/Proj' }] as never,
      activeProjectId: 'p1',
    });
    useArtifactStore.setState({
      artifactsByProject: {
        p1: [
          { id: 'dck_1', projectId: 'p1', name: 'My Deck', path: '/Users/a/Proj/my-deck', createdAt: 0, updatedAt: 0 },
        ],
      },
    });
    const tab = makeTab({ kind: 'deck', projectId: 'p1', ref: 'dck_1', title: 'My Deck' });
    expect(tabSourcePath(tab)).toEqual({ path: 'my-deck', name: 'My Deck' });
  });

  it('deck 记录缺失回 null', () => {
    const tab = makeTab({ kind: 'deck', projectId: 'p1', ref: 'dck_missing', title: 'X' });
    expect(tabSourcePath(tab)).toBeNull();
  });

  it('deck 项目缺失回 null', () => {
    useArtifactStore.setState({
      artifactsByProject: {
        p1: [{ id: 'dck_1', projectId: 'p1', name: 'D', path: '/Users/a/Proj/d', createdAt: 0, updatedAt: 0 }],
      },
    });
    const tab = makeTab({ kind: 'deck', projectId: 'p1', ref: 'dck_1', title: 'D' });
    expect(tabSourcePath(tab)).toBeNull();
  });
});
