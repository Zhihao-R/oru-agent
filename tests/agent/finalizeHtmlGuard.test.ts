/**
 * deck agentTool artifact_finalize_submission 对 html 组的代码层护栏（项目B 第三期 Task16，C-1）。
 *
 * html 收尾旁路 deck 体检（手动「标记完成」）；若 AI 仍对 html 组调本工具，必须**优雅返回**、
 * 绝不进 deck 逻辑（resolveDeckPath(htmlPath) 会抛）也不触发 deck 广播（onArtifactSubmissionChanged）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { SubmissionTarget } from '../../electron/main/submissions/target';
import { createSubmission, __resetForTest as resetSubmissions } from '../../electron/main/deck/submissions';
import { makeFinalizeSubmissionTool } from '../../electron/main/agent/agentTools/finalizeSubmission';
import { makeToolContext } from '../helpers/toolContext';

afterEach(() => resetSubmissions());

function htmlStubTarget(key: string): SubmissionTarget {
  const noop = async () => {};
  return {
    key,
    kind: 'html',
    annotationLoc: { jsonPath: '', cropRelPrefix: '', lockKey: key },
    pointer: { commit: async () => ({ versionId: 's1' }), checkout: noop, restore: async () => '' },
    interruptionsPath: '',
    compareTmp: { before: '', after: '' },
    deriveBefore: async () => 's0',
    pin: noop,
    unpin: noop,
  } satisfies SubmissionTarget;
}

describe('artifact_finalize_submission 对 html 组的 C-1 护栏', () => {
  it('html 组：优雅返回（非 isError）、不调 deck 广播、不抛 resolveDeckPath', async () => {
    createSubmission({
      groupId: 'grp_html',
      target: htmlStubTarget(resolve('/tmp/loose/page.html')),
      annotationIds: ['a1'],
      beforeVersionId: 's0',
      conversationId: 'cnv',
    });
    const onArtifactSubmissionChanged = vi.fn(async () => {});
    const ctx = makeToolContext({ onArtifactSubmissionChanged });

    const res = await makeFinalizeSubmissionTool().execute({ group_id: 'grp_html' }, ctx);
    expect(res.isError).not.toBe(true); // 不报"收尾失败：deck not found"
    expect(res.text).toContain('标记完成'); // 引导走手动收尾
    expect(onArtifactSubmissionChanged).not.toHaveBeenCalled(); // 绝不触发 deck 广播（C-2 连带）
  });
});
