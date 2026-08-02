/**
 * 老 manualApiKey → BackendProvider 启动迁移 smoke
 *
 * 验证决策 7.9：
 * 1. OAuth 模式（claude_cli）：不建 provider，只设 migratedFromManualApiKey: true
 * 2. manual_api_key 模式 + manualApiKey 非空：建 anthropic provider + sonnet model + 全用途指向
 * 3. 多次启动幂等：第二次跑不重复建
 * 4. migratedFromManualApiKey: true 后 manualApiKey 后续变化不再触发自动迁移
 *
 * 不打 Claude；通过 mock detectAuth 控制鉴权 mode
 */
import './__smoke_isolate__';
import type { AuthMode, AuthStatus } from '@shared/types';
import { __clearCacheForTest, getSettings, updateSettings } from '../../electron/main/projects/store';
import { migrateLegacyApiKey } from '../../electron/main/agent/migrateLegacyApiKey';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

let mockingMode: AuthMode = 'none';
const mockDetectAuth = async (): Promise<AuthStatus> => ({
  mode: mockingMode,
  ready: mockingMode !== 'none',
  hint: `mock(${mockingMode})`,
});

async function resetSettings(opts: { manualApiKey: string | null; migrated: boolean }): Promise<void> {
  __clearCacheForTest();
  // 重置：清空 providers/models/assignments，设 manualApiKey + migrated 标志
  await updateSettings({
    providers: [],
    models: [],
    modelAssignments: {
      twinMain: null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: null,
      conversationSummary: null,
    },
    manualApiKey: opts.manualApiKey,
    migratedFromManualApiKey: opts.migrated,
  });
}

async function main(): Promise<void> {
  console.log('=== settings_migration smoke ===');

  try {
    // case 1: OAuth 模式 + 任意 manualApiKey → 不建 provider，只设标志
    mockingMode = 'claude_cli';
    await resetSettings({ manualApiKey: 'sk-old-oauth', migrated: false });
    await migrateLegacyApiKey({ detectAuth: mockDetectAuth });
    let s = await getSettings();
    assert(s.providers.length === 0, 'OAuth 模式：不建 provider', `providers=${s.providers.length}`);
    assert(s.models.length === 0, 'OAuth 模式：不建 model', `models=${s.models.length}`);
    assert(s.migratedFromManualApiKey === true, 'OAuth 模式：标志置为 true', `migrated=${s.migratedFromManualApiKey}`);

    // case 2: manual_api_key 模式 + manualApiKey 非空 → 自动建 provider + model + 全用途指向
    mockingMode = 'manual_api_key';
    await resetSettings({ manualApiKey: 'sk-anth-real', migrated: false });
    await migrateLegacyApiKey({ detectAuth: mockDetectAuth });
    s = await getSettings();
    assert(s.providers.length === 1, 'manual_api_key：建 1 个 provider', `providers=${s.providers.length}`);
    if (s.providers.length === 1) {
      assert(s.providers[0].type === 'anthropic', 'provider.type === anthropic', s.providers[0].type);
      assert(s.providers[0].apiKey === 'sk-anth-real', 'provider.apiKey 来自 manualApiKey', s.providers[0].apiKey);
    }
    assert(s.models.length === 1, '建 1 个 RegisteredModel', `models=${s.models.length}`);
    if (s.models.length === 1) {
      assert(s.models[0].modelId === 'claude-sonnet-4-6', 'model.modelId === claude-sonnet-4-6', s.models[0].modelId);
    }
    const allUsages: Array<keyof typeof s.modelAssignments> = ['twinMain', 'twinBackground', 'memoryDream', 'subagentCoder'];
    const allAssigned = allUsages.every((u) => s.modelAssignments[u] === s.models[0]?.id);
    assert(allAssigned, '四个用途都指向新建的 model', JSON.stringify(s.modelAssignments));

    // case 3: 幂等——再跑一次 migrate 不应重复建
    const beforeProviders = s.providers.length;
    await migrateLegacyApiKey({ detectAuth: mockDetectAuth });
    s = await getSettings();
    assert(s.providers.length === beforeProviders, '第二次跑 migrate 不重复建', `providers=${s.providers.length}`);

    // case 4: migrated: true 后用户改 manualApiKey 也不再触发
    await resetSettings({ manualApiKey: 'sk-anth-NEW-changed', migrated: true });
    await migrateLegacyApiKey({ detectAuth: mockDetectAuth });
    s = await getSettings();
    assert(
      s.providers.length === 0,
      '已迁移过：再次 migrate 不会因 manualApiKey 变化重新建 provider（保持空 providers）',
      `providers=${s.providers.length}`,
    );

    // case 5: none 模式 + 没 manualApiKey → 设标志为 true，不建任何 provider
    mockingMode = 'none';
    await resetSettings({ manualApiKey: null, migrated: false });
    await migrateLegacyApiKey({ detectAuth: mockDetectAuth });
    s = await getSettings();
    assert(s.providers.length === 0, 'none + 无 key：不建 provider', `providers=${s.providers.length}`);
    assert(s.migratedFromManualApiKey === true, 'none + 无 key：标志置为 true（避免重复尝试）', `migrated=${s.migratedFromManualApiKey}`);
  } finally {
    // mockDetectAuth 是函数局部，不需要还原
  }

  // 总结
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
