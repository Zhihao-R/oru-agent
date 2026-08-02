/**
 * Settings 测试工厂——收敛散落的 partial mock 双层强转（`{ …partial } as unknown as` 的 Settings 版）。
 *
 * 仓库约定：mock 必须 `satisfies` 被 mock 的接口类型（接口加必填字段时假绿）。Settings 有 6 个
 * 必填字段（theme/colorScheme/manualApiKey/providers/models/modelAssignments），partial mock 用
 * 双层强转绕过完整性检查——加了新必填字段测试照绿。本工厂给齐必填、`satisfies Settings` 收口：
 * 日后 Settings 加必填字段，这里编译红，一处补齐。
 *
 * 只从 `@shared/types` 取类型与枚举（无副作用），不 import 主进程 store——避免静态拉入
 * paths.ts 破坏动态 import 型测试（Pattern A）的 ORU_DIR 隔离。**代价**：这里的默认值只需满足
 * 类型（satisfies），不保证等于生产 DEFAULT_SETTINGS；测试若依赖某字段的**生产默认值**应显式 override。
 *
 * ```ts
 * const s = makeSettings({ mcpServers: [cfg] });
 * vi.mocked(getSettings).mockResolvedValue(makeSettings({ language: 'zh' }));
 * ```
 */
import type { ModelAssignment, Settings } from '@shared/types';
import { LLM_USAGES } from '@shared/types';

export function makeSettings(overrides?: Partial<Settings>): Settings {
  const modelAssignments = Object.fromEntries(
    LLM_USAGES.map((u) => [u, null]),
  ) as ModelAssignment;
  return {
    theme: 'system',
    colorScheme: 'terracotta',
    manualApiKey: null,
    providers: [],
    models: [],
    modelAssignments,
    ...overrides,
  } satisfies Settings;
}
