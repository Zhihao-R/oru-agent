/**
 * 主窗导航的安全裁决。
 *
 * 渲染进程的主文档只应停在本地 SPA（dev 下是 ELECTRON_RENDERER_URL，生产是 file://）。
 * 任何指向外部站点的整页导航，都是误触链接——某处 <a> 漏了 target="_blank"——的事故，
 * 会把整个 Oru 替换成外站、白屏级故障。`will-navigate` 是导航的唯一收口：在这里拦下
 * 并交系统浏览器，安全边界落在主进程，而非要求每个渲染组件自觉补 target。
 *
 * @param url       will-navigate 的目标 URL
 * @param devOrigin 开发模式渲染器的 origin（`new URL(ELECTRON_RENDERER_URL).origin`）；
 *                  生产为 undefined（主文档走 file://，任何 http(s) 整页导航都是外部）
 * @returns true = 应阻止整页导航并外开系统浏览器
 */
export function shouldExternalize(url: string, devOrigin: string | undefined): boolean {
  if (!/^https?:\/\//i.test(url)) return false; // 本地协议 / SPA 内部锚点（#…）不拦
  if (!devOrigin) return true; // 生产无同源 http(s)，一律外开
  try {
    return new URL(url).origin !== devOrigin; // dev 同源（HMR / reload）放行，跨源外开
  } catch {
    return true;
  }
}
