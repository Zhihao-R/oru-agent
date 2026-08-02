/**
 * providers / models / modelAssignments WS 协议 CRUD smoke
 *
 * 验证：
 * 1. providers.add / providers.update / providers.remove 状态正确
 * 2. providers.remove 同时清理引用了该 provider 的 model + assignments
 * 3. models.add / models.remove 状态正确
 * 4. models.remove 同时清理引用了该 model 的 assignment
 * 5. modelAssignments.update 单一 usage 修改正确
 * 6. broadcast 事件正确发出
 *
 * 通过 ws server + ws client 走真协议链路。
 */
import './__smoke_isolate__';
import WebSocket from 'ws';
import { startWsServer, stopWsServer } from '../../electron/main/ws/server';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { createSubConversation } from '../../electron/main/conversations/store';
import { newReqId } from '@shared/ids';
import type { ClientRequestPayload, ServerEvent } from '@shared/protocol';
import type { BackendProvider, RegisteredModel } from '@shared/types';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function send<T = ServerEvent>(ws: WebSocket, payload: ClientRequestPayload): Promise<T> {
  const reqId = newReqId();
  return new Promise<T>((resolve, reject) => {
    const onMsg = (raw: WebSocket.RawData) => {
      const ev = JSON.parse(raw.toString()) as ServerEvent;
      if (ev.reqId === reqId) {
        ws.off('message', onMsg);
        if (ev.type === 'error') reject(new Error(`${ev.code}: ${ev.message}`));
        else resolve(ev as unknown as T);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ ...payload, reqId }));
    setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout: ${payload.type}`));
    }, 5000);
  });
}

async function main(): Promise<void> {
  console.log('=== providers_crud smoke ===');

  const agent = await ensureDefaultAgent();
  await createSubConversation(agent.id, '新对话');
  const port = await startWsServer();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'file://' });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  try {
    // 收集 broadcast 事件
    const broadcasts: ServerEvent[] = [];
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw.toString()) as ServerEvent;
      if (!ev.reqId) broadcasts.push(ev);
    });

    // 初始：空
    let r = await send<{ type: 'providers.state'; providers: BackendProvider[] }>(ws, { type: 'providers.list' });
    assert(r.providers.length === 0, '初始 providers 为空', `len=${r.providers.length}`);

    // case 1: add anthropic provider
    const a = await send<{ type: 'providers.state'; providers: BackendProvider[] }>(ws, {
      type: 'providers.add',
      provider: { type: 'anthropic', label: 'Anthropic', apiKey: 'sk-anth-1' },
    });
    assert(a.providers.length === 1 && a.providers[0].type === 'anthropic', 'add: 1 个 anthropic provider', JSON.stringify(a.providers));
    const anthId = a.providers[0].id;

    // case 2: add OpenRouter provider
    const b = await send<{ type: 'providers.state'; providers: BackendProvider[] }>(ws, {
      type: 'providers.add',
      provider: { type: 'openrouter', label: 'OpenRouter', apiKey: 'sk-or-1' },
    });
    assert(b.providers.length === 2, 'add: 总共 2 个 provider', `len=${b.providers.length}`);
    const orId = b.providers.find((p) => p.type === 'openrouter')!.id;

    // case 3: update anthropic label + apiKey
    const c = await send<{ type: 'providers.state'; providers: BackendProvider[] }>(ws, {
      type: 'providers.update',
      id: anthId,
      patch: { label: 'My Anthropic', apiKey: 'sk-anth-NEW' },
    });
    const anthAfter = c.providers.find((p) => p.id === anthId)!;
    assert(anthAfter.label === 'My Anthropic' && anthAfter.apiKey === 'sk-anth-NEW', 'update: label/apiKey 改成功', JSON.stringify(anthAfter));

    // case 4: add 2 models（对应两个 provider）
    // 2026-05-06：models.add 入参校验加严——contextWindow / supportsVision 必填
    const m1 = await send<{ type: 'models.state'; models: RegisteredModel[] }>(ws, {
      type: 'models.add',
      model: {
        providerId: anthId,
        modelId: 'claude-sonnet-4-6',
        label: 'Sonnet',
        contextWindow: 200_000,
        supportsVision: true,
        supportsPromptCache: true,
        supportsReasoning: true,
      },
    });
    assert(m1.models.length === 1, 'add model 1', `len=${m1.models.length}`);
    const sonnetId = m1.models[0].id;
    const m2 = await send<{ type: 'models.state'; models: RegisteredModel[] }>(ws, {
      type: 'models.add',
      model: {
        providerId: orId,
        modelId: 'openai/gpt-5',
        label: 'GPT-5',
        contextWindow: 400_000,
        supportsVision: true,
      },
    });
    assert(m2.models.length === 2, 'add model 2', `len=${m2.models.length}`);
    const gpt5Id = m2.models.find((m) => m.modelId === 'openai/gpt-5')!.id;

    // case 4a: add 缺 contextWindow → MODEL_INVALID
    let invalidErr: Error | null = null;
    try {
      await send(ws, {
        type: 'models.add',
        model: {
          providerId: anthId,
          modelId: 'no-ctx',
          label: 'no-ctx',
          supportsVision: true,
        } as Parameters<typeof send>[1] extends { model: infer M } ? M : never,
      } as ClientRequestPayload);
    } catch (e) {
      invalidErr = e as Error;
    }
    assert(
      invalidErr !== null && invalidErr.message.startsWith('MODEL_INVALID'),
      'add 缺 contextWindow → MODEL_INVALID',
      invalidErr?.message,
    );

    // case 4b: add 缺 supportsVision → MODEL_INVALID
    invalidErr = null;
    try {
      await send(ws, {
        type: 'models.add',
        model: {
          providerId: anthId,
          modelId: 'no-vision',
          label: 'no-vision',
          contextWindow: 100_000,
        } as Parameters<typeof send>[1] extends { model: infer M } ? M : never,
      } as ClientRequestPayload);
    } catch (e) {
      invalidErr = e as Error;
    }
    assert(
      invalidErr !== null && invalidErr.message.startsWith('MODEL_INVALID'),
      'add 缺 supportsVision → MODEL_INVALID',
      invalidErr?.message,
    );

    // case 4c: maxOutputTokens > contextWindow → MODEL_INVALID
    invalidErr = null;
    try {
      await send(ws, {
        type: 'models.add',
        model: {
          providerId: anthId,
          modelId: 'too-big',
          label: 'too-big',
          contextWindow: 1024,
          supportsVision: false,
          maxOutputTokens: 10_000,
        },
      });
    } catch (e) {
      invalidErr = e as Error;
    }
    assert(
      invalidErr !== null && invalidErr.message.startsWith('MODEL_INVALID'),
      'add maxOutputTokens > contextWindow → MODEL_INVALID',
      invalidErr?.message,
    );

    // case 4d: models.update label/contextWindow → 成功
    const u1 = await send<{ type: 'models.state'; models: RegisteredModel[] }>(ws, {
      type: 'models.update',
      id: sonnetId,
      patch: { label: 'Sonnet (renamed)', contextWindow: 180_000 },
    });
    const sonnetAfter = u1.models.find((m) => m.id === sonnetId)!;
    assert(
      sonnetAfter.label === 'Sonnet (renamed)' && sonnetAfter.contextWindow === 180_000,
      'update: label/contextWindow 改成功',
      JSON.stringify(sonnetAfter),
    );

    // case 4e: update 不存在的 id → MODEL_NOT_FOUND
    invalidErr = null;
    try {
      await send(ws, { type: 'models.update', id: 'does-not-exist', patch: { label: 'x' } });
    } catch (e) {
      invalidErr = e as Error;
    }
    assert(
      invalidErr !== null && invalidErr.message.startsWith('MODEL_NOT_FOUND'),
      'update 不存在的 id → MODEL_NOT_FOUND',
      invalidErr?.message,
    );

    // case 4f: update 让合并后的 maxOutputTokens 超窗口 → MODEL_INVALID
    invalidErr = null;
    try {
      await send(ws, {
        type: 'models.update',
        id: sonnetId,
        patch: { maxOutputTokens: 999_999 },
      });
    } catch (e) {
      invalidErr = e as Error;
    }
    assert(
      invalidErr !== null && invalidErr.message.startsWith('MODEL_INVALID'),
      'update maxOutputTokens > 窗口 → MODEL_INVALID',
      invalidErr?.message,
    );

    // case 5: 给 twinMain / subagentCoder 分配
    await send(ws, { type: 'modelAssignments.update', usage: 'twinMain', modelId: gpt5Id });
    await send(ws, { type: 'modelAssignments.update', usage: 'subagentCoder', modelId: sonnetId });
    const settingsBefore = await send<{ type: 'settings.state'; settings: { modelAssignments: { twinMain: string | null; subagentCoder: string | null } } }>(
      ws,
      { type: 'settings.get' },
    );
    assert(
      settingsBefore.settings.modelAssignments.twinMain === gpt5Id,
      'twinMain → gpt5Id',
      settingsBefore.settings.modelAssignments.twinMain ?? 'null',
    );
    assert(
      settingsBefore.settings.modelAssignments.subagentCoder === sonnetId,
      'subagentCoder → sonnetId',
      settingsBefore.settings.modelAssignments.subagentCoder ?? 'null',
    );

    // case 6: 删 OpenRouter provider —— 引用它的 gpt-5 model 和 twinMain assignment 都应被清理
    await send(ws, { type: 'providers.remove', id: orId });
    const m3 = await send<{ type: 'models.state'; models: RegisteredModel[] }>(ws, { type: 'models.list' });
    assert(m3.models.length === 1 && m3.models[0].id === sonnetId, '删 OR provider 后只剩 sonnet model', JSON.stringify(m3.models));
    const settingsAfter = await send<{ type: 'settings.state'; settings: { modelAssignments: { twinMain: string | null; subagentCoder: string | null } } }>(
      ws,
      { type: 'settings.get' },
    );
    assert(settingsAfter.settings.modelAssignments.twinMain === null, '删 OR 后 twinMain 被清理', settingsAfter.settings.modelAssignments.twinMain ?? 'null');
    assert(
      settingsAfter.settings.modelAssignments.subagentCoder === sonnetId,
      '删 OR 后 subagentCoder 仍指向 sonnet（没被误清理）',
      settingsAfter.settings.modelAssignments.subagentCoder ?? 'null',
    );

    // case 7: 删 sonnet model —— 引用它的 subagentCoder assignment 应被清理
    await send(ws, { type: 'models.remove', id: sonnetId });
    const settingsFinal = await send<{ type: 'settings.state'; settings: { modelAssignments: { subagentCoder: string | null } } }>(
      ws,
      { type: 'settings.get' },
    );
    assert(
      settingsFinal.settings.modelAssignments.subagentCoder === null,
      '删 sonnet 后 subagentCoder 被清理',
      settingsFinal.settings.modelAssignments.subagentCoder ?? 'null',
    );

    // case 8: 验证 broadcast 事件——至少能收到 providers.state / models.state / modelAssignments.state
    const types = new Set(broadcasts.map((b) => b.type));
    assert(types.has('providers.state'), 'broadcast 含 providers.state');
    assert(types.has('models.state'), 'broadcast 含 models.state');
    assert(types.has('modelAssignments.state'), 'broadcast 含 modelAssignments.state');
  } finally {
    ws.close();
    await stopWsServer();
  }

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
