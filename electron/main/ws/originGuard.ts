/**
 * WebSocket 握手 Origin 校验。
 *
 * 背景：ws server 绑了 127.0.0.1 但 WebSocket 协议不受浏览器 CORS 约束——
 * 任何浏览器开着的页面（或恶意扩展）扫到本机端口都能发 chat.send / proposal.execute /
 * mcp.create 等命令。必须在握手期靠 Origin 头白名单挡住。
 *
 * 白名单：
 *   - 精确匹配 'file://'：Electron renderer 加载打包后 index.html 的真实 origin
 *   - 'file:///' 开头：少数 chromium 版本带三斜杠（无 host，attacker 塞不进东西）
 *   - 'http://localhost:5173' / 'http://127.0.0.1:5173'：vite dev server
 *
 * 拒绝：
 *   - Origin 缺省 / 'null'：浏览器对沙箱页面、恶意构造常用此值
 *   - 'file://anything-evil'：非浏览器客户端（恶意 native app / curl / ws 库）
 *     可任意设置 Origin 头——绝不能用 startsWith('file://') 兜底，否则 file://x
 *     直接放行，与本守卫初衷冲突
 *   - 其他任何 Origin
 *
 * 例外：smoke 测试用的 `ws` Node 客户端默认不带 Origin——smoke isolate / smoke 文件
 * 显式传 origin: 'file://' 模拟 renderer。
 */

const DEV_ORIGINS = new Set<string>([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return false;
  if (origin === 'file://') return true;
  // 三斜杠后是路径而非 host，attacker 无法构造可控部分
  if (origin.startsWith('file:///')) return true;
  if (DEV_ORIGINS.has(origin)) return true;
  return false;
}
