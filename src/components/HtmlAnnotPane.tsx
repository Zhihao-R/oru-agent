import { useMemo } from 'react';
import { useHtmlAnnotStore, emptyHtmlAnnotations } from '@/stores/htmlAnnotStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { AnnotPanel } from '@/components/annot/AnnotPanel';
import type { SubmissionSurface } from '@/components/annot/submissionSurface';
import { parentDir } from '@/lib/paths';

/**
 * HTML 批注面板（项目B 第三期 Task15）——把 htmlAnnotStore（按 ref 分桶）接到共用 `AnnotPanel`。
 * 与 deck 的 AnnotPane 镜像，只差接线（store + WS 命名空间）；渲染/交互全在 AnnotPanel。
 *
 * 身份口径：store 按 ref（项目相对 path）分桶，动作传 ref；crop URL base = html 所在目录的**绝对路径**
 * （sidecar crops 落在 `resolve(htmlPath)` 同目录，cropAssetUrl 吃绝对路径）。
 * html 不存定位 → requestJump no-op；收起按钮与 deck 共享全局 annotPaneCollapsed
 * （html 无 deck 那套沉浸/peek 态，恒工作态直接 toggle）。
 */
export function HtmlAnnotPane({ path, absPath }: { path: string; absPath: string }) {
  const annotations = useHtmlAnnotStore((s) => s.byRef[path]?.annotations ?? emptyHtmlAnnotations());
  const submission = useHtmlAnnotStore((s) => s.byRef[path]?.submission ?? null);
  const comparing = useHtmlAnnotStore((s) => s.byRef[path]?.compareState != null);
  const comparingThisGroup = useHtmlAnnotStore(
    (s) => s.byRef[path]?.compareState != null && s.byRef[path]?.submission?.afterVersionId != null,
  );
  const store = useHtmlAnnotStore;
  const cropBaseDir = parentDir(absPath);
  const toggleAnnotPaneCollapsed = useLayoutStore((s) => s.toggleAnnotPaneCollapsed);

  const surface: SubmissionSurface = useMemo(() => {
    const a = store.getState();
    return {
      annotations,
      submission,
      cropBaseDir,
      comparing,
      comparingThisGroup,
      onCollapse: toggleAnnotPaneCollapsed,
      updateAnnotation: (id, patch) => a.updateAnnotation(path, id, patch),
      removeAnnotation: (id) => a.removeAnnotation(path, id),
      submitAnnotations: (ids, convId) => a.submitAnnotations(path, ids, convId),
      stopSubmission: (groupId) => a.stopSubmission(path, groupId),
      manualFinalize: (groupId) => a.manualFinalize(path, groupId),
      saveSubmission: (groupId) => a.saveSubmission(path, groupId),
      cancelSubmission: (groupId) => a.cancelSubmission(path, groupId),
      enterCompare: (groupId) => a.enterCompare(path, groupId),
      exitCompare: () => a.exitCompare(path),
      discardInterrupted: (groupId) => a.discardInterrupted(path, groupId),
      requestFrameSelect: () => a.requestFrameSelect(path),
      requestJump: () => {}, // html 不存定位，点卡片不跳
    };
  }, [annotations, submission, cropBaseDir, comparing, comparingThisGroup, path, store, toggleAnnotPaneCollapsed]);

  return <AnnotPanel surface={surface} />;
}
