/**
 * prompt 工作台命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 prompts.* / promptbench.run 各 case 字节级一致——纯搬运。
 */
import type { RegistrySlice } from './types';
import { getBackendForModel } from '../../agent/backends/factory';
import { runOneShotWithTimeout } from '../../agent/backends';
import { listPrompts, getPrompt } from '../../prompts';

export const promptHandlers = {
  'prompts.list': async (req, { reply }) => {
    reply(req.reqId, {
      type: 'prompts.listed',
      prompts: listPrompts().map(({ body, ...meta }) => meta),
    });
  },
  'prompts.get': async (req, { reply }) => {
    const prompt = getPrompt(req.id);
    if (!prompt) throw new Error(`未知 prompt：${req.id}`);
    reply(req.reqId, { type: 'prompts.one', prompt });
  },
  'promptbench.run': async (req, { reply }) => {
    const backend = await getBackendForModel(req.modelId);
    const { text } = await runOneShotWithTimeout(
      backend,
      { prompt: req.input, systemContext: req.systemContext },
      120_000,
    );
    reply(req.reqId, { type: 'promptbench.result', text });
  },
} satisfies RegistrySlice;
