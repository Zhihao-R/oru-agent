/**
 * providers.* 与 webSearch.testEngine 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内对应各 case 字节级一致——纯搬运。
 */
import type { RegistrySlice } from './types';
import { getSettings, updateSettings } from '../../projects/store';
import { testProvider } from '../../agent/backends/testConnection';
import { broadcastMainChatStatus } from './backendStatusBroadcast';
import { newProviderId } from '@shared/ids';

export const providerHandlers = {
  'providers.list': async (req, { reply }) => {
    const settings = await getSettings();
    reply(req.reqId, { type: 'providers.state', providers: settings.providers });
  },
  'providers.add': async (req, { reply, broadcast }) => {
    const cur = await getSettings();
    const newProvider = { id: newProviderId(), ...req.provider };
    const updated = await updateSettings({
      providers: [...cur.providers, newProvider],
    });
    reply(req.reqId, { type: 'providers.state', providers: updated.providers });
    broadcast({ type: 'providers.state', providers: updated.providers });
    await broadcastMainChatStatus(broadcast);
  },
  'providers.update': async (req, { reply, broadcast }) => {
    const cur = await getSettings();
    const next = cur.providers.map((p) => (p.id === req.id ? { ...p, ...req.patch } : p));
    const updated = await updateSettings({ providers: next });
    reply(req.reqId, { type: 'providers.state', providers: updated.providers });
    broadcast({ type: 'providers.state', providers: updated.providers });
    await broadcastMainChatStatus(broadcast);
  },
  'providers.remove': async (req, { reply, broadcast }) => {
    const cur = await getSettings();
    const filtered = cur.providers.filter((p) => p.id !== req.id);
    // 同时清理引用了该 provider 的 model + assignments
    const removedModelIds = cur.models
      .filter((m) => m.providerId === req.id)
      .map((m) => m.id);
    const filteredModels = cur.models.filter((m) => m.providerId !== req.id);
    const cleanedAssignments = { ...cur.modelAssignments };
    for (const usage of Object.keys(cleanedAssignments) as Array<keyof typeof cleanedAssignments>) {
      if (cleanedAssignments[usage] && removedModelIds.includes(cleanedAssignments[usage] as string)) {
        cleanedAssignments[usage] = null;
      }
    }
    const updated = await updateSettings({
      providers: filtered,
      models: filteredModels,
      modelAssignments: cleanedAssignments,
    });
    reply(req.reqId, { type: 'providers.state', providers: updated.providers });
    broadcast({ type: 'providers.state', providers: updated.providers });
    broadcast({ type: 'models.state', models: updated.models });
    broadcast({ type: 'modelAssignments.state', assignments: updated.modelAssignments });
    await broadcastMainChatStatus(broadcast);
  },
  'providers.test': async (req, { reply }) => {
    const cur = await getSettings();
    const provider = cur.providers.find((p) => p.id === req.id);
    if (!provider) {
      reply(req.reqId, {
        type: 'provider.test.result',
        providerId: req.id,
        ok: false,
        providerType: 'custom-openai',
        message: '找不到该 provider',
      });
      return;
    }
    const r = await testProvider(provider);
    reply(req.reqId, {
      type: 'provider.test.result',
      providerId: provider.id,
      providerType: provider.type,
      ok: r.ok,
      message: r.message,
    });
  },
  'webSearch.testEngine': async (req, { reply }) => {
    // 用临时配置直接构造引擎 + 调 test()——不写入 settings，由前端拿到结果后自行 settings.update
    const { makeEngine } = await import('../../search/selector');
    try {
      const engine = makeEngine({
        id: '__test__',
        type: req.engineType,
        apiKey: req.apiKey,
      });
      const r = await engine.test();
      reply(req.reqId, {
        type: 'webSearch.test.result',
        engineType: req.engineType,
        ok: r.ok,
        message: r.error,
      });
    } catch (e) {
      reply(req.reqId, {
        type: 'webSearch.test.result',
        engineType: req.engineType,
        ok: false,
        message: (e as Error).message,
      });
    }
  },
} satisfies RegistrySlice;
