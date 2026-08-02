/**
 * deck 版本指针（项目B 第三期 Task11）
 *
 * 把 VersionPointer 接口落到 deck history.ts 上——行为零改，版本账本（manifest/currentVersion/
 * changedPages/undo）仍由 history.ts 维护，指针只透传。versionId 是 deck 的 vNNN（语义层 id）。
 * checkout 走 force（提交流的取消/退回改前语义，绕过缺图询问）。
 */
import type { VersionPointer } from '../fs/versionPointer';
import { commitVersion, checkoutVersion, restoreVersionContent } from './history';

export function deckVersionPointer(artifactId: string): VersionPointer {
  return {
    async commit(kind, summary) {
      const v = await commitVersion(artifactId, kind, summary);
      return { versionId: v.id };
    },
    async checkout(versionId) {
      await checkoutVersion(artifactId, versionId, { force: true });
    },
    restore(versionId) {
      return restoreVersionContent(artifactId, versionId);
    },
  };
}
