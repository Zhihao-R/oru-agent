import type { Annotation } from '@shared/types';
import type { ArtifactSubmissionView } from '@shared/protocol';
import { sortAnnotations } from './sortAnnotations';

/**
 * 把标注按"活跃提交组 + 开放卡"分组（纯函数，submission 驱动）
 *
 * 分组规则：
 * - 无活跃组（submission=null）：全部 pending / failed 都是开放卡。
 * - 修改中组（submission.afterVersionId 无）：组成员 = groupId 匹配且 status==='submitted'。
 * - 已中断组（submission.interrupted，PRD §六-6）：崩溃后无 live 组但有中断记录，组成员同修改中
 *   （submitted），但 UI 渲「已中断」+「继续」/「退回改前」而非「停止」/「标记完成」。
 * - 完成组（submission.afterVersionId 有）：成功标注已删，组成员 = groupId 匹配且 status==='failed'；
 *   即使无 failed（全成功）也返回空组（[保存][对比][取消] 的唯一入口）。
 * - 开放卡：pending + 无 groupId 的独立 failed（属已解散旧组的 failed 也归这里兜底）。
 *
 * 组内 / 开放卡都按创建顺序排序（见 sortAnnotations）。
 *
 * activeGroup.isNarrative：纯文稿更新组（submission.annotationIds 为空），
 * AnnotPane 据此渲染说明正文而非逐标注卡。
 */
export function groupAnnotations(
  annotations: Annotation[],
  submission: ArtifactSubmissionView | null,
): {
  activeGroup: {
    kind: 'editing' | 'done' | 'interrupted';
    groupId: string;
    items: Annotation[];
    /** 纯文稿更新组（annotationIds 为空，没有框选标注） */
    isNarrative: boolean;
  } | null;
  openCards: Annotation[];
} {
  const groupId = submission?.groupId;
  const kind: 'editing' | 'done' | 'interrupted' | null =
    submission == null
      ? null
      : submission.interrupted
        ? 'interrupted'
        : submission.afterVersionId == null
          ? 'editing'
          : 'done';
  // 已中断与修改中都匹配 submitted 标注；完成组匹配 failed（成功项已删）
  const inGroupStatus = kind === 'done' ? 'failed' : 'submitted';

  const items: Annotation[] = [];
  const open: Annotation[] = [];
  for (const a of annotations) {
    if (kind && a.groupId === groupId && a.status === inGroupStatus) {
      items.push(a);
    } else if (a.status === 'pending' || (a.status === 'failed' && !a.groupId)) {
      open.push(a);
    }
  }
  return {
    activeGroup: kind
      ? {
          kind,
          groupId: groupId as string,
          items: sortAnnotations(items),
          isNarrative: submission!.annotationIds.length === 0,
        }
      : null,
    openCards: sortAnnotations(open),
  };
}
