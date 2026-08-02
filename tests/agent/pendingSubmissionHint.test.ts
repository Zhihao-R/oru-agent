/**
 * 待收尾提交组提示按 target.kind 路由（项目B 第三期 Task16，护栏 C-1）。
 *
 * deck 组 → 提示调 artifact_finalize_submission + deck 源文件 + 体检语言；
 * html 组 → 提示改 html 源文件、用户手动「标记完成」收尾，**绝不**让 agent 调 deck 收尾工具/跑体检
 * （html 旁路 deck 体检；deck agentTool 对 html 路径会抛 resolveDeckPath）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { SubmissionTarget } from '../../electron/main/submissions/target';
import {
  createSubmission,
  __resetForTest as resetSubmissions,
} from '../../electron/main/deck/submissions';
import { buildPendingSubmissionHint } from '../../electron/main/agent/hooks';

afterEach(() => resetSubmissions());

/** 最小 target 桩——hint 只读 key/kind/groupId/annotationIds，其余字段满足类型即可（CLAUDE.md：satisfies 不裸 as）。 */
function stubTarget(kind: 'deck' | 'html', key: string): SubmissionTarget {
  const noop = async () => {};
  return {
    key,
    kind,
    annotationLoc: { jsonPath: '', cropRelPrefix: '', lockKey: key },
    pointer: {
      commit: async () => ({ versionId: 's1' }),
      checkout: noop,
      restore: async () => '',
    },
    interruptionsPath: '',
    compareTmp: { before: '', after: '' },
    deriveBefore: async () => 's0',
    pin: noop,
    unpin: noop,
  } satisfies SubmissionTarget;
}

describe('buildPendingSubmissionHint 按 target.kind 路由', () => {
  it('html 组：提示改源文件 + 用户手动收尾，不调 deck 收尾工具/不跑体检', async () => {
    const htmlPath = resolve('/tmp/some/page.html');
    createSubmission({
      groupId: 'grp_html_1',
      target: stubTarget('html', htmlPath),
      annotationIds: ['a1', 'a2'],
      beforeVersionId: 's0',
      conversationId: 'cnv_h',
    });
    const hint = await buildPendingSubmissionHint('cnv_h');
    expect(hint).toContain(htmlPath); // 给出要改的 html 源文件
    expect(hint).toContain('grp_html_1');
    expect(hint).toContain('标记完成'); // 用户手动收尾
    expect(hint).not.toContain('artifact_finalize_submission'); // 不让 agent 调 deck 收尾工具
    expect(hint).not.toContain('体检'); // html 旁路 deck 体检
  });

  it('deck 组：保留原 deck 收尾提示（artifact_finalize_submission + 体检）', async () => {
    createSubmission({
      groupId: 'grp_deck_1',
      target: stubTarget('deck', 'dck_fake'),
      annotationIds: ['a1'],
      beforeVersionId: 'v0',
      conversationId: 'cnv_d',
    });
    const hint = await buildPendingSubmissionHint('cnv_d');
    expect(hint).toContain('grp_deck_1');
    expect(hint).toContain('artifact_finalize_submission');
    expect(hint).toContain('体检');
  });

  it('同一对话 deck+html 混合：两段都在，html 段不含 deck 收尾语言', async () => {
    const htmlPath = resolve('/tmp/x/y.html');
    createSubmission({
      groupId: 'grp_h',
      target: stubTarget('html', htmlPath),
      annotationIds: ['a1'],
      beforeVersionId: 's0',
      conversationId: 'cnv_mix',
    });
    createSubmission({
      groupId: 'grp_d',
      target: stubTarget('deck', 'dck_x'),
      annotationIds: ['b1'],
      beforeVersionId: 'v0',
      conversationId: 'cnv_mix',
    });
    const hint = await buildPendingSubmissionHint('cnv_mix');
    expect(hint).toContain('grp_h');
    expect(hint).toContain('grp_d');
    expect(hint).toContain('artifact_finalize_submission'); // deck 段有
    expect(hint).toContain(htmlPath); // html 段有源文件
  });
});
