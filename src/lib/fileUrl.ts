/**
 * 把本地文件系统绝对路径拼成 file:// URL，对路径里的空格 / 非 ASCII 字符做百分号编码。
 *
 * 为什么需要：`<img src>` / `<webview src>` 解析 URL 时，路径含空格（macOS 默认下载目录、
 * 用户把项目放在带空格或中文的目录下）会解析失败，资源静默不加载。`encodeURI` 保留
 * `/` `:` 等分隔符、只编码空格/非 ASCII，且对纯 ASCII 路径是 no-op（无回归）。入参是
 * 未编码的原始路径，不会双重编码。
 */
export function fileUrl(absPath: string): string {
  return encodeURI(`file://${absPath}`);
}

/**
 * 框选 crop 截图的 renderer 可加载 URL。主窗口 `<img>` 不能用 file://（webSecurity 拦），
 * 走自定义协议 `oru-crop://`（main 进程 cropProtocol.ts 拦截读盘，同 oru-avatar:// 套路）。
 * 入参是 crop 的绝对路径（`<deckPath>/.annotations/crops/<id>.png`）。
 */
export function cropAssetUrl(absPath: string): string {
  return `oru-crop://local${encodeURI(absPath)}`;
}

/**
 * 图片工具（image_search 候选缩略图 / download_image 落地图）的 renderer 可加载 URL。
 * 同 cropAssetUrl 的理由——主窗口 `<img>` 不能 file://，走自定义协议 `oru-toolimg://`
 * （main 进程 toolImageProtocol.ts 拦截读盘）。入参是图的绝对路径。
 */
export function toolImageUrl(absPath: string): string {
  return `oru-toolimg://local${encodeURI(absPath)}`;
}
