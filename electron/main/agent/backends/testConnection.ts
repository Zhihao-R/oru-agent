/**
 * provider 连通性测试
 *
 * 各 provider type 用一个最小 chat call 探活，主要看是否 401（key 错）/ 网络错。
 * 即使 model id 不对，4xx 错误也可让我们区分鉴权问题 vs 配置问题。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BackendProvider, BackendProviderType } from '@shared/types';
import { providerProtocol } from '@shared/agent/providerProtocol';
import { resolveOpenAICompatibleBaseURL } from './openaiCompatible';
import { resolveAnthropicCompatiblePreset } from './providerPresets';

const TEST_MODEL: Record<BackendProviderType, string> = {
  anthropic: 'claude-haiku-4-5',
  openrouter: 'openai/gpt-5-mini',
  openai: 'gpt-5-mini',
  zhipu: 'glm-4-flash',
  kimi: 'moonshot-v1-8k',
  'custom-openai': 'gpt-5-mini', // 用户自定义；只能猜一个常见
  // 三家 coding plan 探活 model——占位值取自 2026-07-21 厂商事实表，
  // 待 Task 0 真机（需真实订阅 key）核实后更新（厂商会静默换搭载模型）。
  'glm-coding': 'glm-4.7',
  'kimi-coding': 'kimi-for-coding',
  'minimax-coding': 'MiniMax-M2.5',
};

export async function testProvider(provider: BackendProvider): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!provider.apiKey || provider.apiKey.trim().length === 0) {
    return { ok: false, message: 'API Key 为空' };
  }

  const model = TEST_MODEL[provider.type];

  if (providerProtocol(provider.type) === 'anthropic-native') {
    // anthropic 直连 + 三家 coding plan：Anthropic SDK 探活，端点/鉴权由预设解析。
    let preset: { baseUrl?: string; authMode: 'x-api-key' | 'bearer' };
    try {
      preset = resolveAnthropicCompatiblePreset(provider.type, provider.baseUrl);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const auth =
      preset.authMode === 'bearer'
        ? { authToken: provider.apiKey }
        : { apiKey: provider.apiKey };
    try {
      const client = new Anthropic({ ...auth, baseURL: preset.baseUrl });
      await client.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return { ok: true, message: '已连通' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 即使是 model not found 错，至少证明 key 是活的
      if (/401|unauthorized|invalid.*api.*key/i.test(msg)) {
        return { ok: false, message: `认证失败：${truncate(msg)}` };
      }
      return { ok: false, message: truncate(msg) };
    }
  }

  // OpenAI 风格
  let baseURL: string;
  try {
    baseURL = resolveOpenAICompatibleBaseURL(provider.type, provider.baseUrl);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.type === 'openrouter'
          ? { 'HTTP-Referer': 'https://oru.local', 'X-Title': 'Oru' }
          : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (resp.status === 401 || resp.status === 403) {
      const text = await resp.text();
      return { ok: false, message: `认证失败 (${resp.status})：${truncate(text)}` };
    }
    if (resp.ok) return { ok: true, message: '已连通' };
    if (resp.status === 400 || resp.status === 404) {
      // model 不对 / endpoint 不对——但 key 大概率是好的（401 才是真挂）
      return {
        ok: true,
        message: `API 端点可达，但测试 model "${model}" 返回 ${resp.status}（可能模型未启用，不影响实际配置自有 model）`,
      };
    }
    const text = await resp.text();
    return { ok: false, message: `HTTP ${resp.status}: ${truncate(text)}` };
  } catch (e) {
    return { ok: false, message: `网络错误：${e instanceof Error ? e.message : String(e)}` };
  }
}

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
