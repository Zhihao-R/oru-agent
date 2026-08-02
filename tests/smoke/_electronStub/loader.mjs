/**
 * smoke(tsx)专用 ESM resolve hook：把裸 'electron' 重定向到本目录的 stub.mjs。
 *
 * 只在 smoke 经 register.mjs（smokeRunner 注入 --import）注册，不影响生产 electron-vite 构建、
 * 也不影响 vitest（vitest 各测试文件自行 vi.mock('electron')）。除 'electron' 外一律透传 nextResolve，
 * 与 tsx 自身的 loader 共存（解析 hook 成链）。
 */
const STUB = new URL('./stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: STUB, shortCircuit: true };
  return nextResolve(specifier, context);
}
