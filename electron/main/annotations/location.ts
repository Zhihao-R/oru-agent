/**
 * 标注存储落点解析（项目B 第三期 Task10）
 *
 * 把"绑 artifactId"解耦为"吃 AnnotationLocation"——annotations.ts 的增删改查 + crop 读写是
 * 单一出处，按 location 落盘。两种制品各自解析自己的 location：
 * - deck：按 deck 目录存一份 `.annotations.json` + `.annotations/crops/`（保留旧行为）
 * - html：按**文件路径**存文件旁 sidecar，同目录多个松散 HTML 互不覆盖（脱 artifact 的核心动机）
 *
 * cropRelPrefix 相对 `dirname(jsonPath)` 解析——前端 `cropAssetUrl(${baseDir}/${cropPath})`
 * 据此拼图片 URL（deck baseDir=deckPath，html baseDir=文件所在目录）。
 */
import { basename, dirname, join, resolve } from 'node:path';
import { deckAnnotationsPath, deckLockKey } from '../deck/pathResolver';

export interface AnnotationLocation {
  /** `.annotations.json` 绝对路径 */
  jsonPath: string;
  /** 写进 Annotation.cropPath 的相对前缀（相对 dirname(jsonPath)，正斜杠）；crops 目录由此 + dirname 推得 */
  cropRelPrefix: string;
  /** mutate 写锁 key（resolve 归一，与 fileHistory/applyTextEdit 同源）——非 jsonPath 派生：deck 锁的是 index.html */
  lockKey: string;
}

/** deck：保留旧落点 `deckPath/.annotations.json` + `.annotations/crops/`。 */
export function deckAnnotationLocation(deckPath: string): AnnotationLocation {
  return {
    jsonPath: deckAnnotationsPath(deckPath),
    cropRelPrefix: '.annotations/crops',
    lockKey: deckLockKey(deckPath),
  };
}

/**
 * html：文件旁 sidecar——`/dir/foo.html` → `/dir/.foo.html.annotations.json`
 * + `/dir/.foo.html.annotations/crops/`。同目录两个松散 HTML 落不同 sidecar，互不覆盖。
 */
export function htmlAnnotationLocation(htmlPath: string): AnnotationLocation {
  const abs = resolve(htmlPath);
  const dir = dirname(abs);
  const base = basename(abs);
  const sidecar = `.${base}.annotations`;
  return {
    jsonPath: join(dir, `${sidecar}.json`),
    cropRelPrefix: `${sidecar}/crops`,
    lockKey: abs,
  };
}
