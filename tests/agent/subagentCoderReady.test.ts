/**
 * 派工探针 subagentCoderReady 回归（方案二前置自检）
 *
 * 三条分支必须各自成立——尤其「非 anthropic provider 时 getBackendFor 是 throw 不是返回 false」，
 * 探针必须 try-catch 兜住、不外抛，否则 proposeAction 自检会崩穿到工具层。
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { AgentBackend } from '@shared/agent/backend';
import {
  subagentCoderReady,
  __setBackendFactoryForTest,
} from '../../electron/main/agent/backends/factory';

// 完整实现 AgentBackend 接口（satisfies，不裸 as）——只 isReady 有行为，其余抛错占位，
// 探针只摸 isReady，碰别的就说明实现走偏了。
function stubBackend(isReady: AgentBackend['isReady'], backendType: AgentBackend['backendType'] = 'claude-code'): AgentBackend {
  return {
    backendType,
    toolProtocol: 'sdk-mcp',
    runConversation: () => {
      throw new Error('stub backend：runConversation 不该被探针调用');
    },
    runOneShot: async () => {
      throw new Error('stub backend：runOneShot 不该被探针调用');
    },
    registerTool: () => {},
    unregisterTool: () => {},
    isReady,
  } satisfies AgentBackend;
}

describe('subagentCoderReady 派工探针', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('anthropic 鉴权 ready → ok:true', async () => {
    restore = __setBackendFactoryForTest(async () =>
      stubBackend(async () => ({ ok: true, hint: '' }), 'claude-code'),
    );
    const r = await subagentCoderReady();
    expect(r.ok).toBe(true);
  });

  it('backend 存在但未鉴权 → ok:false 且透传 hint', async () => {
    restore = __setBackendFactoryForTest(async () =>
      stubBackend(async () => ({ ok: false, hint: '本机未登录 Claude' }), 'claude-code'),
    );
    const r = await subagentCoderReady();
    expect(r.ok).toBe(false);
    expect(r.hint).toBe('本机未登录 Claude');
  });

  it('非 anthropic provider ok:true → ok:true', async () => {
    restore = __setBackendFactoryForTest(async () =>
      stubBackend(async () => ({ ok: true }), 'openai-compatible'),
    );
    const r = await subagentCoderReady();
    expect(r.ok).toBe(true);
  });

  it('非 anthropic provider → getBackendFor throw → 兜成 ok:false，不外抛', async () => {
    restore = __setBackendFactoryForTest(async () => {
      throw new Error(
        'subagent（写代码）不支持 openai-compatible provider；请改用 anthropic provider',
      );
    });
    const r = await subagentCoderReady();
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('anthropic');
  });
});
