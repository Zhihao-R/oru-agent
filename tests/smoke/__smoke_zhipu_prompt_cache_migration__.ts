/**
 * GLM 模型 supportsPromptCache 回灌 migration smoke
 *
 * 表驱动，每条 case 独立预置 settings → 跑 migrateZhipuPromptCacheFlag → 断言。
 * 覆盖：
 * - 推荐 modelId（zhipu/glm-4.6, zhipu/glm-4-flash, openrouter/zai-org/glm-4.6）+ undefined → true
 * - 用户曾改 false → 不动（尊重主动配置）
 * - 已是 true → 不动 + changedIds 不含
 * - 自定义 modelId → 不动
 * - 非目标 provider.type → 不动
 * - 幂等（guard 已 true）
 */
import './__smoke_isolate__';
import type { BackendProvider, RegisteredModel } from '@shared/types';
import { newProviderId, newRegisteredModelId } from '@shared/ids';
import { __clearCacheForTest, getSettings, updateSettings } from '../../electron/main/projects/store';
import { migrateZhipuPromptCacheFlag } from '../../electron/main/agent/migrateZhipuPromptCacheFlag';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

type Preset = {
  providers: BackendProvider[];
  models: RegisteredModel[];
  migrated?: boolean;
};

async function prep(preset: Preset): Promise<void> {
  __clearCacheForTest();
  await updateSettings({
    providers: preset.providers,
    models: preset.models,
    modelAssignments: {
      twinMain: null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: null,
      conversationSummary: null,
    },
    migratedZhipuPromptCacheFlag: preset.migrated ?? false,
  });
}

function mkProvider(type: BackendProvider['type']): BackendProvider {
  return { id: newProviderId(), type, label: `${type} test`, apiKey: 'sk-x' };
}

function mkModel(
  providerId: string,
  modelId: string,
  supportsPromptCache: boolean | undefined,
): RegisteredModel {
  return {
    id: newRegisteredModelId(),
    providerId,
    modelId,
    label: modelId,
    contextWindow: 128_000,
    supportsVision: false,
    supportsPromptCache,
    supportsReasoning: false,
  };
}

async function caseHappyZhipuUndefined(): Promise<void> {
  const zhipu = mkProvider('zhipu');
  const m46 = mkModel(zhipu.id, 'glm-4.6', undefined);
  const mFlash = mkModel(zhipu.id, 'glm-4-flash', undefined);
  await prep({ providers: [zhipu], models: [m46, mFlash] });
  await migrateZhipuPromptCacheFlag();
  const s = await getSettings();
  const got46 = s.models.find((m) => m.id === m46.id);
  const gotFlash = s.models.find((m) => m.id === mFlash.id);
  assert(got46?.supportsPromptCache === true, 'happy: glm-4.6 undefined → true', String(got46?.supportsPromptCache));
  assert(gotFlash?.supportsPromptCache === true, 'happy: glm-4-flash undefined → true', String(gotFlash?.supportsPromptCache));
  assert(s.migratedZhipuPromptCacheFlag === true, 'happy: guard 置 true');
  // changedIds 必须精确包含这两条——是未来反向 migration 的白名单锚点
  const ids = new Set(s.migratedZhipuPromptCacheFlagChangedIds ?? []);
  assert(
    ids.size === 2 && ids.has(m46.id) && ids.has(mFlash.id),
    'happy: changedIds 精确含 m46.id + mFlash.id',
    JSON.stringify(s.migratedZhipuPromptCacheFlagChangedIds),
  );
}

async function caseExistingFalseNotTouched(): Promise<void> {
  const zhipu = mkProvider('zhipu');
  const m = mkModel(zhipu.id, 'glm-4.6', false);
  await prep({ providers: [zhipu], models: [m] });
  await migrateZhipuPromptCacheFlag();
  const s = await getSettings();
  const got = s.models.find((mm) => mm.id === m.id);
  assert(got?.supportsPromptCache === false, 'existing_false: 不动用户主动配置', String(got?.supportsPromptCache));
  assert(s.migratedZhipuPromptCacheFlag === true, 'existing_false: guard 仍置 true');
  // 关键：changedIds 不含这条——反向 migration 不会误碰用户主动配置
  const ids = s.migratedZhipuPromptCacheFlagChangedIds ?? [];
  assert(
    !ids.includes(m.id),
    'existing_false: changedIds 不含此 model（保护用户主动选择）',
    JSON.stringify(ids),
  );
}

async function caseExistingTrueNotTouched(): Promise<void> {
  const zhipu = mkProvider('zhipu');
  const m = mkModel(zhipu.id, 'glm-4.6', true);
  await prep({ providers: [zhipu], models: [m] });
  await migrateZhipuPromptCacheFlag();
  const s = await getSettings();
  const got = s.models.find((mm) => mm.id === m.id);
  assert(got?.supportsPromptCache === true, 'existing_true: 保持 true', String(got?.supportsPromptCache));
}

async function caseUnknownModelIdNotTouched(): Promise<void> {
  const zhipu = mkProvider('zhipu');
  const m = mkModel(zhipu.id, 'glm-4-air-preview', undefined);
  await prep({ providers: [zhipu], models: [m] });
  await migrateZhipuPromptCacheFlag();
  const s = await getSettings();
  const got = s.models.find((mm) => mm.id === m.id);
  assert(
    got?.supportsPromptCache === undefined,
    'unknown_modelId: 自定义 modelId 不动（保留 undefined）',
    String(got?.supportsPromptCache),
  );
  assert(s.migratedZhipuPromptCacheFlag === true, 'unknown_modelId: guard 仍置 true');
}

async function caseOpenrouterZaiGlm46(): Promise<void> {
  const or = mkProvider('openrouter');
  const m = mkModel(or.id, 'zai-org/glm-4.6', undefined);
  await prep({ providers: [or], models: [m] });
  await migrateZhipuPromptCacheFlag();
  const s = await getSettings();
  const got = s.models.find((mm) => mm.id === m.id);
  assert(got?.supportsPromptCache === true, 'openrouter_zai_glm_46: undefined → true', String(got?.supportsPromptCache));
}

async function caseOpenrouterOtherModelIdNotTouched(): Promise<void> {
  const or = mkProvider('openrouter');
  const m = mkModel(or.id, 'anthropic/claude-sonnet-4.6', undefined);
  await prep({ providers: [or], models: [m] });
  await migrateZhipuPromptCacheFlag();
  const s = await getSettings();
  const got = s.models.find((mm) => mm.id === m.id);
  assert(
    got?.supportsPromptCache === undefined,
    'openrouter_other: 非目标 modelId 不动',
    String(got?.supportsPromptCache),
  );
}

async function caseMixedProviders(): Promise<void> {
  // 真实用户场景：同时配了 zhipu 直连 + openrouter 代理，两边都有 GLM 模型
  const zhipu = mkProvider('zhipu');
  const or = mkProvider('openrouter');
  const mZhipu = mkModel(zhipu.id, 'glm-4.6', undefined);
  const mOr = mkModel(or.id, 'zai-org/glm-4.6', undefined);
  const mOrOther = mkModel(or.id, 'openai/gpt-5', undefined);
  await prep({ providers: [zhipu, or], models: [mZhipu, mOr, mOrOther] });
  await migrateZhipuPromptCacheFlag();
  const s = await getSettings();
  assert(
    s.models.find((m) => m.id === mZhipu.id)?.supportsPromptCache === true,
    'mixed: zhipu glm-4.6 → true',
  );
  assert(
    s.models.find((m) => m.id === mOr.id)?.supportsPromptCache === true,
    'mixed: openrouter zai-org/glm-4.6 → true',
  );
  assert(
    s.models.find((m) => m.id === mOrOther.id)?.supportsPromptCache === undefined,
    'mixed: openrouter gpt-5 不动（非目标 modelId）',
  );
  const ids = new Set(s.migratedZhipuPromptCacheFlagChangedIds ?? []);
  assert(
    ids.size === 2 && ids.has(mZhipu.id) && ids.has(mOr.id),
    'mixed: changedIds 含两条 GLM、不含 gpt-5',
    JSON.stringify(s.migratedZhipuPromptCacheFlagChangedIds),
  );
}

async function caseEmptySettings(): Promise<void> {
  // 全新用户、models=[] 也应走通 → guard 置 true，changedIds 空数组
  await prep({ providers: [], models: [] });
  await migrateZhipuPromptCacheFlag();
  const s = await getSettings();
  assert(s.migratedZhipuPromptCacheFlag === true, 'empty: guard 置 true');
  assert(
    (s.migratedZhipuPromptCacheFlagChangedIds ?? []).length === 0,
    'empty: changedIds 是空数组',
    JSON.stringify(s.migratedZhipuPromptCacheFlagChangedIds),
  );
}

async function caseIdempotent(): Promise<void> {
  const zhipu = mkProvider('zhipu');
  const m = mkModel(zhipu.id, 'glm-4.6', undefined);
  await prep({ providers: [zhipu], models: [m], migrated: true }); // 已 true
  await migrateZhipuPromptCacheFlag();
  const s = await getSettings();
  const got = s.models.find((mm) => mm.id === m.id);
  assert(
    got?.supportsPromptCache === undefined,
    'idempotent: guard 已 true → 短路，不动模型',
    String(got?.supportsPromptCache),
  );
}

async function main(): Promise<void> {
  console.log('=== zhipu prompt cache migration smoke ===');
  await caseHappyZhipuUndefined();
  await caseExistingFalseNotTouched();
  await caseExistingTrueNotTouched();
  await caseUnknownModelIdNotTouched();
  await caseOpenrouterZaiGlm46();
  await caseOpenrouterOtherModelIdNotTouched();
  await caseMixedProviders();
  await caseEmptySettings();
  await caseIdempotent();

  const failed = RESULTS.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${RESULTS.length}`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${RESULTS.length} cases`);
}

main().catch((e) => {
  console.error('smoke unhandled error:', e);
  process.exit(1);
});
