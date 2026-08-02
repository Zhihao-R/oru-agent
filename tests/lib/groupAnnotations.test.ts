/**
 * groupAnnotations 单元测试——submission 驱动的「活跃组 + 开放卡」分组
 */
import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../shared/types';
import type { ArtifactSubmissionView } from '../../shared/protocol';
import { groupAnnotations } from '../../src/lib/groupAnnotations';

// 造一条最小标注：只关心 status / groupId / 排序用的 pageIndex
function ann(id: string, status: Annotation['status'], groupId?: string, pageIndex = 0): Annotation {
  return {
    id,
    comment: '',
    cropPath: '',
    htmlSnippet: '',
    text: '',
    locator: { scrollY: 0, rect: { x: 0, y: pageIndex, w: 0, h: 0 }, pageIndex },
    status,
    groupId,
    createdAt: 0,
    updatedAt: 0,
  };
}

// annotationIds 要与组内标注一致（真实提交里 submitAnnotations 同时落 annotationIds + 打 groupId）。
// 空 annotationIds = 纯文稿更新组（isNarrative）；非空 = 含框选标注的组。
const editing = (groupId: string, annotationIds: string[] = []): ArtifactSubmissionView => ({
  groupId,
  annotationIds,
  beforeVersionId: 'v0',
});
const done = (groupId: string, annotationIds: string[] = []): ArtifactSubmissionView => ({
  groupId,
  annotationIds,
  beforeVersionId: 'v0',
  afterVersionId: 'v1',
});

describe('groupAnnotations', () => {
  it('无 submission：全部 pending/failed 都是开放卡', () => {
    const out = groupAnnotations(
      [ann('a', 'pending'), ann('b', 'failed')],
      null,    );
    expect(out.activeGroup).toBeNull();
    expect(out.openCards.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('修改中组：组成员 = groupId 匹配且 submitted；pending 进开放卡', () => {
    const out = groupAnnotations(
      [
        ann('g1', 'submitted', 'grp', 0),
        ann('g2', 'submitted', 'grp', 1),
        ann('p', 'pending'),
        ann('other', 'submitted', 'grpX'), // 别组 submitted——既不进本组也不进开放卡
      ],
      editing('grp', ['g1', 'g2']),    );
    expect(out.activeGroup).toEqual({
      kind: 'editing',
      groupId: 'grp',
      items: [expect.objectContaining({ id: 'g1' }), expect.objectContaining({ id: 'g2' })],
      isNarrative: false, // 含框选标注的组（annotationIds 非空）
    });
    expect(out.openCards.map((x) => x.id)).toEqual(['p']);
  });

  it('完成组：组成员 = groupId 匹配且 failed；submitted 不进组', () => {
    const out = groupAnnotations(
      [ann('f', 'failed', 'grp'), ann('s', 'submitted', 'grp'), ann('p', 'pending')],
      done('grp', ['f', 's']),    );
    expect(out.activeGroup?.kind).toBe('done');
    expect(out.activeGroup?.items.map((x) => x.id)).toEqual(['f']);
    expect(out.activeGroup?.isNarrative).toBe(false); // 含标注的完成组
    // submitted 不匹配完成组的 failed 条件，也无开放卡条件 → 既不进组也不进开放卡
    expect(out.openCards.map((x) => x.id)).toEqual(['p']);
  });

  it('完成组全成功（标注组、无 failed）：空 items 但 isNarrative=false（走"本次修改已全部完成"，非汇总卡）', () => {
    // 真实场景：提交了 ['x'] 标注、全成功被删 → items 空但 annotationIds 非空 → 不是文稿更新
    const out = groupAnnotations([ann('p', 'pending')], done('grp', ['x']));
    expect(out.activeGroup).toEqual({ kind: 'done', groupId: 'grp', items: [], isNarrative: false });
    expect(out.openCards.map((x) => x.id)).toEqual(['p']);
  });

  it('独立 failed（无 groupId）进开放卡；有 groupId 但非活跃组的 failed 不进开放卡', () => {
    const out = groupAnnotations(
      [ann('orphan', 'failed'), ann('stale', 'failed', 'oldGrp')],
      editing('grp'),    );
    expect(out.openCards.map((x) => x.id)).toEqual(['orphan']);
  });

  // ── isNarrative：纯文稿更新组（annotationIds 为空）────────────────
  it('纯文稿更新——修改中：isNarrative=true，items 空', () => {
    const sub: ArtifactSubmissionView = { groupId: 'grp', annotationIds: [], beforeVersionId: 'v0' };
    const out = groupAnnotations([], sub);
    expect(out.activeGroup).not.toBeNull();
    expect(out.activeGroup!.items).toEqual([]);
    expect(out.activeGroup!.isNarrative).toBe(true);
  });

  it('纯文稿更新——完成：isNarrative=true，items 空', () => {
    const sub: ArtifactSubmissionView = {
      groupId: 'grp',
      annotationIds: [],
      beforeVersionId: 'v0',
      afterVersionId: 'v1',
    };
    const out = groupAnnotations([], sub);
    expect(out.activeGroup).not.toBeNull();
    expect(out.activeGroup!.items).toEqual([]);
    expect(out.activeGroup!.isNarrative).toBe(true);
  });

  it('含标注的提交组：isNarrative=false', () => {
    const sub: ArtifactSubmissionView = {
      groupId: 'grp',
      annotationIds: ['a1'],
      beforeVersionId: 'v0',
    };
    const out = groupAnnotations([ann('a1', 'submitted', 'grp')], sub);
    expect(out.activeGroup!.isNarrative).toBe(false);
  });

  it('已中断组（interrupted）：kind=interrupted，成员=submitted 标注（PRD §六-6）', () => {
    const sub: ArtifactSubmissionView = {
      groupId: 'grp',
      annotationIds: ['a1'],
      beforeVersionId: 'v0',
      interrupted: true,
      conversationId: 'cnv',
    };
    const out = groupAnnotations([ann('a1', 'submitted', 'grp'), ann('a2', 'pending')], sub);
    expect(out.activeGroup!.kind).toBe('interrupted');
    expect(out.activeGroup!.items.map((a) => a.id)).toEqual(['a1']); // submitted 入组
    expect(out.openCards.map((a) => a.id)).toEqual(['a2']); // pending 仍是开放卡
  });
});
