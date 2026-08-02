/**
 * 启动期 GLM 模型 supportsPromptCache 回灌
 *
 * 触发条件：settings.migratedZhipuPromptCacheFlag 仍为 false / undefined。
 *
 * 行为：
 * - 遍历 settings.models；对命中以下 (provider.type, modelId) 组合的 model：
 *     - provider.type === 'zhipu'    且 modelId ∈ {'glm-4.6', 'glm-4-flash'}
 *     - provider.type === 'openrouter' 且 modelId === 'zai-org/glm-4.6'
 * - 仅当 model.supportsPromptCache === undefined 时改为 true；**已有 false（用户主动取消）或
 *   已有 true 都不动**——尊重用户主动配置，跟 RegisteredModel 整体的"不擅自改写"原则一致。
 * - 写回 settings：除了 guard 还要把改过的 model.id 存到
 *   migratedZhipuPromptCacheFlagChangedIds——给未来反向 migration 留锚点（区分 migration 改的
 *   vs 用户主动勾的）。
 *
 * 幂等：guard 一旦 true，后续启动短路返回。
 *
 * 必须在 ws server start 之前调用，避免渲染端首次拉 settings 时看到未迁移状态。
 *
 * ── 已知脆弱面 ──
 * 1. `provider.type` 枚举若改名（如 zhipu 拆 zhipu-bigmodel / zhipu-glm），TS 编译期会捕捉到
 *    （TARGETS 的 providerType 字段已用 BackendProviderType 类型）；但运行期 settings 里残留的
 *    枚举值仍可能跟新代码不一致，那一次改名 PR 必须自带补丁。
 * 2. modelId 字符串硬编码；智谱日后改名（如 glm-4-flash → glm-4.5-flash）老用户新模型不会自动迁移——
 *    新用户走推荐 chip 没问题。
 * 3. 一次性 guard，没有反向回滚——若需把 supportsPromptCache 改回 false，需新写一份反向 migration，
 *    只动 migratedZhipuPromptCacheFlagChangedIds 白名单里的 id。
 */
import type { BackendProviderType, Settings } from '@shared/types';
import { getSettings, updateSettings } from '../projects/store';

/** 命中迁移范围的 (providerType, modelId) 组合——直接拼成 Set 的 key，单次 has 检查 O(1)。 */
const TARGET_KEYS: ReadonlySet<string> = new Set<string>(
  (
    [
      ['zhipu', 'glm-4.6'],
      ['zhipu', 'glm-4-flash'],
      ['openrouter', 'zai-org/glm-4.6'],
    ] as ReadonlyArray<readonly [BackendProviderType, string]>
  ).map(([t, m]) => `${t}|${m}`),
);

export async function migrateZhipuPromptCacheFlag(): Promise<void> {
  const settings: Settings = await getSettings();
  if (settings.migratedZhipuPromptCacheFlag) return;

  const providerTypeById = new Map<string, BackendProviderType>();
  for (const p of settings.providers) providerTypeById.set(p.id, p.type);

  const changedIds: string[] = [];
  const nextModels = settings.models.map((m) => {
    const ptype = providerTypeById.get(m.providerId);
    if (!ptype) return m;
    if (!TARGET_KEYS.has(`${ptype}|${m.modelId}`)) return m;
    // 只改 undefined；已有 false（用户主动取消）或已有 true 都不动
    if (m.supportsPromptCache !== undefined) return m;
    changedIds.push(m.id);
    return { ...m, supportsPromptCache: true };
  });

  if (changedIds.length > 0) {
    console.log(
      `[oru.migrate zhipuPromptCacheFlag] updated ${changedIds.length} model(s):`,
      changedIds,
    );
  }
  await updateSettings({
    models: nextModels,
    migratedZhipuPromptCacheFlag: true,
    migratedZhipuPromptCacheFlagChangedIds: changedIds,
  });
}
