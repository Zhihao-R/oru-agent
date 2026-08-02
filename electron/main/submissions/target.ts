/**
 * SubmissionTarget——提交流内核的"后端"抽象（项目B 第三期 Task12）
 *
 * 提交内核（submissions.ts 的 submit/finalize/cancel/save/stop/reconcile/中断）只通过 target 操作
 * 标注/版本/中断记录/pin，deck 与 html 据此共用一条流（不再让 html 伪装成 deck）：
 * - deck：每个方法接到**今天的原函数/路径**，行为逐字不变；pin 是 no-op（deck 走 retainAll 整体豁免 GC）。
 * - html：标注走文件旁 sidecar、版本直连 fileHistory、pin 真生效（周期模型靠 pin 护住 before/after，裁定 A）。
 *
 * key = byTarget Map 的键（deck:artifactId / html:resolve(htmlPath)）。
 */
import { resolve, dirname, join, basename } from 'node:path';
import type { AnnotationLocation } from '../annotations/location';
import { deckAnnotationLocation, htmlAnnotationLocation } from '../annotations/location';
import type { VersionPointer } from '../fs/versionPointer';
import { htmlVersionPointer } from '../fs/versionPointer';
import { deckVersionPointer } from '../deck/deckPointer';
import { deckInterruptionsPath } from '../deck/pathResolver';
import { resolveDeckPath } from '../deck/store';
import { flushPending } from '../deck/commitScheduler';
import { isDirty, ensureManifest } from '../deck/history';
import { pin as fhPin, unpin as fhUnpin } from '../fs/fileHistory';

export interface SubmissionTarget {
  /** byTarget Map 键（deck:artifactId / html:resolve(htmlPath)）。 */
  key: string;
  /** 制品类型——收尾提示/路由据此分流（deck 走体检+收尾工具，html 旁路、手动收尾）。 */
  kind: 'deck' | 'html';
  /** 标注存储落点（Task10）。 */
  annotationLoc: AnnotationLocation;
  /** 版本指针（Task11）。 */
  pointer: VersionPointer;
  /** 中断记录 json 落点。 */
  interruptionsPath: string;
  /** 改前/改后对比的两个临时文件绝对路径——落活动文件所在目录（相对资源 images/ 才解析对）。 */
  compareTmp: { before: string; after: string };
  /** 提交时算"改前" id——deck:flushPending+isDirty?commit('protective'):currentVersion；html:一律 commit。 */
  deriveBefore(): Promise<string>;
  /** pin/unpin 被引用版本免于 GC（Task11.5）——deck no-op（retainAll 已豁免），html 真 pin。 */
  pin(ids: string[]): Promise<void>;
  unpin(ids: string[]): Promise<void>;
}

export async function deckTarget(artifactId: string): Promise<SubmissionTarget> {
  const deckPath = await resolveDeckPath(artifactId);
  const pointer = deckVersionPointer(artifactId);
  return {
    key: artifactId,
    kind: 'deck',
    annotationLoc: deckAnnotationLocation(deckPath),
    pointer,
    interruptionsPath: deckInterruptionsPath(deckPath),
    // deck 一目录一份 deck，对比文件名不带前缀（落点/名与重构前一致，零回归）
    compareTmp: { before: join(deckPath, '.compare-before.html'), after: join(deckPath, '.compare-after.html') },
    async deriveBefore() {
      // deck 旧逻辑逐字保留：flushPending → dirty 则防护性 commit，否则懒初始化 currentVersion 作 before
      await flushPending(artifactId);
      if (await isDirty(artifactId)) {
        return (await pointer.commit('protective', '提交标注前的暂存')).versionId;
      }
      return (await ensureManifest(artifactId)).currentVersion;
    },
    // deck 走 retainAll 整体豁免 GC，pin 冗余——no-op（且 deck versionId 是 vNNN，非 fileHistory id，pin 也不匹配）
    async pin() {},
    async unpin() {},
  };
}

export function htmlTarget(htmlPath: string): SubmissionTarget {
  const abs = resolve(htmlPath);
  const pointer = htmlVersionPointer(abs);
  const sidecarDir = join(dirname(abs), `.${basename(abs)}.annotations`);
  return {
    key: abs,
    kind: 'html',
    annotationLoc: htmlAnnotationLocation(abs),
    pointer,
    interruptionsPath: join(sidecarDir, 'interruptions.json'),
    // 同目录多个松散 html：对比文件名带 .{base} 前缀防撞（落 html 同目录解析相对资源）
    compareTmp: {
      before: join(dirname(abs), `.${basename(abs)}.compare-before.html`),
      after: join(dirname(abs), `.${basename(abs)}.compare-after.html`),
    },
    // html 无 dirty 概念，一律 commit('protective')（commitSnapshot 内容未变复用 ref，before 不落空）
    async deriveBefore() {
      return (await pointer.commit('protective', '提交标注前的暂存')).versionId;
    },
    // html versionId === fileHistory snapshot id，pin 真生效（护住 before/after 免于按龄/封顶 GC）
    async pin(ids) {
      await fhPin(abs, ids);
    },
    async unpin(ids) {
      await fhUnpin(abs, ids);
    },
  };
}
