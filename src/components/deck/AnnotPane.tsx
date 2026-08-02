import { useMemo } from 'react';
import type { Annotation } from '@shared/types';
import { useArtifactStore } from '@/stores/artifactStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { AnnotPanel } from '@/components/annot/AnnotPanel';
import type { SubmissionSurface } from '@/components/annot/submissionSurface';

/**
 * Deck 批注面板——把 artifactStore（按 artifactId）接到共用 `AnnotPanel`（提交面，项目B 第三期 Task15）。
 * 渲染/交互全在 AnnotPanel；这里只组 deck 的 SubmissionSurface（数据 + 动作绑 artifactId + deck 专属收起按钮）。
 */
type Props = {
  artifactId: string;
  deckPath: string;
};

const EMPTY_ANNOTATIONS: Annotation[] = [];

export function AnnotPane({ artifactId, deckPath }: Props) {
  const annotations = useArtifactStore((s) => s.annotationsByArtifact[artifactId] ?? EMPTY_ANNOTATIONS);
  const submission = useArtifactStore((s) => s.submissionByArtifact[artifactId] ?? null);
  const comparing = useArtifactStore((s) => s.compareStateByArtifactId[artifactId] != null);
  const comparingThisGroup = useArtifactStore(
    (s) =>
      s.compareStateByArtifactId[artifactId] != null &&
      s.submissionByArtifact[artifactId]?.afterVersionId != null,
  );
  // 收起按钮只在工作态有意义——沉浸态走右缘 peek 浮层，不读收起标志
  const inWorkMode = useArtifactStore((s) => (s.chromeStateByArtifactId[artifactId] ?? 'work') === 'work');
  const store = useArtifactStore;
  const toggleAnnotPaneCollapsed = useLayoutStore((s) => s.toggleAnnotPaneCollapsed);

  const surface: SubmissionSurface = useMemo(() => {
    const a = store.getState();
    return {
      annotations,
      submission,
      cropBaseDir: deckPath,
      comparing,
      comparingThisGroup,
      onCollapse: inWorkMode ? toggleAnnotPaneCollapsed : undefined,
      updateAnnotation: (id, patch) => a.updateAnnotation(artifactId, id, patch),
      removeAnnotation: (id) => a.removeAnnotation(artifactId, id),
      submitAnnotations: (ids, convId) => a.submitAnnotations(artifactId, ids, convId),
      stopSubmission: (groupId) => a.stopSubmission(artifactId, groupId),
      manualFinalize: (groupId) => a.manualFinalize(artifactId, groupId),
      saveSubmission: (groupId) => a.saveSubmission(artifactId, groupId),
      cancelSubmission: (groupId) => a.cancelSubmission(artifactId, groupId),
      enterCompare: (groupId) => a.enterCompare(artifactId, groupId),
      exitCompare: () => a.exitCompare(artifactId),
      discardInterrupted: (groupId) => a.discardInterrupted(artifactId, groupId),
      requestFrameSelect: () => a.requestFrameSelect(artifactId),
      requestJump: (locator) => a.requestJump(artifactId, locator),
    };
  }, [annotations, submission, deckPath, comparing, comparingThisGroup, inWorkMode, artifactId, store, toggleAnnotPaneCollapsed]);

  return <AnnotPanel surface={surface} />;
}
