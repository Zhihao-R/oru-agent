/**
 * ORU_DIR 沙箱——收敛全仓测试里手写的 `mkdtempSync + process.env.ORU_DIR = …` 样板。
 *
 * ## 两种落地范式（取决于业务模块怎么 import）
 *
 * **Pattern A · 动态 import（占绝大多数）**——业务模块全走测试体内 `await import(...)`：
 * ```ts
 * import { sandboxOruDir } from '../helpers/oruDirSandbox';
 * const ORU_DIR = sandboxOruDir('conv-archive');   // 测试体顶层，先于任何 await import
 * // ...用例里：const { archive } = await import('../../electron/main/conversations/...');
 * ```
 * 为什么必须在动态 import 之前调用：`electron/main/runtime/paths.ts` 在**模块加载时**把
 * `ORU_DIR` 固化成 const，之后改 env 不生效。本函数在测试体顶层设好 env，动态 import 到时才
 * 读到沙箱目录。helper 自身是静态 import（提升到顶、已就绪），但它的**调用**发生在测试体、
 * 早于 `await import`，故有效。
 *
 * **Pattern B · 静态 import + mock electron**——此时 env 赋值会被 import 提升甩到身后失效，
 * 唯一可靠机制是 `vi.hoisted`（factory 先于所有 import 执行，故**不能** import 本 helper）：
 * ```ts
 * import { ORU_DIR as PATHS_ORU_DIR } from '../../electron/main/runtime/paths';
 * import { assertOruDirIsolated } from '../helpers/oruDirSandbox';
 * const ORU_DIR = vi.hoisted(() => {
 *   const { mkdtempSync } = require('node:fs');
 *   const dir = mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'oru-test-x-'));
 *   process.env.ORU_DIR = dir;
 *   return dir;
 * });
 * vi.mock('electron', () => ({ … }));
 * assertOruDirIsolated(PATHS_ORU_DIR);   // 隔离失效即抛，绝不静默污染真实 ~/.oru
 * ```
 *
 * 与 `tests/setup/oruDir.ts`（worker 级 tmpdir 兜底）和 `paths.ts` 的 VITEST 硬护栏成三层防线。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 开一个隔离的 ORU_DIR 沙箱目录并把 `process.env.ORU_DIR` 指向它，返回该路径。
 * 用 `mkdtempSync` 而非 `Date.now()` 拼名——保证同毫秒内多文件也不撞、且目录当场存在。
 */
export function sandboxOruDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `oru-test-${label}-`));
  process.env.ORU_DIR = dir;
  return dir;
}

/**
 * 硬护栏：确认 paths.ts 实际固化的 ORU_DIR 落在系统 tmpdir 内——隔离失效即抛，拒绝落真实 ~/.oru。
 * 给 Pattern B 的文件在顶层或 beforeAll 里调（传入自己 import 的 paths.ORU_DIR），
 * 收敛 17 份 vi.hoisted 文件里手抄的 `if (!X.startsWith(tmpdir())) throw`。
 */
export function assertOruDirIsolated(oruDir: string): void {
  if (!oruDir.startsWith(tmpdir())) {
    throw new Error(
      `ORU_DIR 隔离失效：paths.ts 固化到 ${oruDir}（不在 tmpdir 内）——测试禁止落真实 ~/.oru`,
    );
  }
}
