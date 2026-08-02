import type { Annotation } from '@shared/types';
import type { ArtifactSubmissionView, ArtifactSubmitPayloadItem } from '@shared/protocol';

/**
 * 提交面（项目B 第三期 Task15）——右侧卡片栏 `AnnotPanel` 的"后端"抽象。
 *
 * deck 与 html 共用同一块右侧面板（采集 UI=右侧卡片栏，PM 定），只差接线：
 * - deck：从 artifactStore（按 artifactId）取数据 + 发 artifact.* WS。
 * - html：从 htmlAnnotStore（按 htmlPath）取数据 + 发 html.* WS。
 *
 * 面板只认这个接口，不知道 artifactId / htmlPath / 哪个 store——加第二个实现零成本（系统性）。
 */
export interface SubmissionSurface {
  annotations: Annotation[];
  submission: ArtifactSubmissionView | null;
  /** crop 图 URL base：cropAssetUrl(`${cropBaseDir}/${cropPath}`)。deck=deckPath，html=文件所在目录 */
  cropBaseDir: string;
  /** 该面正在对比（compareState 指向它）——禁用框选 */
  comparing: boolean;
  /** 正在对比"本完成组"——「对比」按钮文案切「退出对比」 */
  comparingThisGroup: boolean;
  /** 收起按钮回调——undefined 则不渲染收起按钮 */
  onCollapse?: () => void;

  updateAnnotation(id: string, patch: Partial<Pick<Annotation, 'comment'>>): void | Promise<void>;
  removeAnnotation(id: string): void | Promise<void>;
  /** 提交一批标注；返回预填 composer 用的 payload（null=被并发约束拒绝） */
  submitAnnotations(
    ids: string[],
    conversationId: string,
  ): Promise<{ payload: ArtifactSubmitPayloadItem[] } | null>;
  stopSubmission(groupId: string): void | Promise<void>;
  manualFinalize(groupId: string): void | Promise<void>;
  saveSubmission(groupId: string): void | Promise<void>;
  cancelSubmission(groupId: string): void | Promise<void>;
  enterCompare(groupId: string): void | Promise<void>;
  exitCompare(): void | Promise<void>;
  discardInterrupted(groupId: string): void | Promise<void>;
  /** 进入框选模式（往预览发框选信号） */
  requestFrameSelect(): void;
  /** 点卡片跳到标注位置；实现不支持定位则 no-op */
  requestJump(locator: Annotation['locator']): void;
}
