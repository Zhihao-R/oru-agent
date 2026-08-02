/**
 * md 文档本地图片引用 → oru-doc-img:// URL 的唯一构造源。
 *
 * 渲染端只持「项目相对路径」、不碰 fs 绝对布局——URL 形态
 *   `oru-doc-img://local/<projectId>/<文档项目相对 path>/<图相对引用…>`
 * 前两段是文档身份（各整段 encodeURIComponent，含其中的 `/`），其后是逐段编码的图引用。
 * 主进程 `docImageProtocol.parseDocImageUrl` 拆三段后经两道沙箱校验——本构造与该解析必须往返一致。
 *
 * 单独成模块（不放 livePreview.ts）：md 编辑器实时预览与导出（renderToStaticMarkup）共用同一构造，
 * 但导出端不该被拖进 CodeMirror 依赖。这里只是纯函数 + 类型，零运行时依赖。
 */

/** 文档身份：项目 + 项目相对文档 path。 */
export type DocIdentity = { projectId: string; docPath: string };

/**
 * 把文档内相对引用编成 oru-doc-img:// URL。无文档身份（理论上不该发生）回空字符串 →
 * `<img>` 走缺失占位。
 */
export function docImageUrl(relSrc: string, identity: DocIdentity | null): string {
  if (!identity) return '';
  const head = [identity.projectId, identity.docPath].map(encodeURIComponent).join('/');
  const tail = relSrc.split('/').map(encodeURIComponent).join('/');
  return `oru-doc-img://local/${head}/${tail}`;
}
