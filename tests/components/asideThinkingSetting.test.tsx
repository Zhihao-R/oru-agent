/** @vitest-environment jsdom */
/**
 * 功能分配行 · 思考开关（Track B）：模型 select 旁的思考灯泡（aria-pressed 按钮，点亮＝该用途先思考）。
 * - each 用途一行，灯泡默认按 defaultModelThinking 分档（asideComment 廉价类默认灭）
 * - 点亮 → 走 store action → ws 协议 modelThinking.update
 * - settings.state 带 modelThinking['asideComment']=true 时 asideComment 行灯泡初始点亮
 * - 当前选到不支持思考的模型 → 灯泡置灰（disabled）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { Settings } from '@shared/types';
import { defaultModelThinking } from '@shared/types';

const ws = vi.hoisted(() => ({
  impl: (async (_p: ClientRequestPayload): Promise<ServerEventPayload> => {
    throw new Error('ws.impl 未配置');
  }) as (p: ClientRequestPayload) => Promise<ServerEventPayload>,
  calls: [] as ClientRequestPayload[],
}));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> => {
      ws.calls.push(payload);
      return (await ws.impl(payload)) as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { BackendSettingsSection } from '@/components/BackendSettingsSection';

function makeSettings(p: { asideCommentThinking?: boolean; asideModelSupportsReasoning?: boolean } = {}): Settings {
  return {
    theme: 'system',
    colorScheme: 'terracotta',
    manualApiKey: null,
    providers: [{ id: 'prov-1', type: 'openrouter', label: 'OR', apiKey: 'sk' }],
    models: [
      {
        id: 'model-1',
        providerId: 'prov-1',
        modelId: 'm-1',
        label: 'm-1',
        contextWindow: 200000,
        supportsVision: true,
        supportsReasoning: p.asideModelSupportsReasoning,
      },
    ],
    modelAssignments: {
      twinMain: null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: null,
      conversationSummary: null,
      conversationTitle: null,
      twinSubagent: null,
      asideComment: null,
    },
    modelThinking: { ...defaultModelThinking(), asideComment: p.asideCommentThinking ?? false },
  };
}

function configureWs(settings: Settings): void {
  ws.impl = async (p) => {
    if (p.type === 'providers.list')
      return { type: 'providers.state', providers: settings.providers };
    if (p.type === 'models.list') return { type: 'models.state', models: settings.models };
    if (p.type === 'settings.get') return { type: 'settings.state', settings };
    if (p.type === 'settings.update')
      return { type: 'settings.state', settings: { ...settings, ...p.settings } };
    if (p.type === 'modelThinking.update') {
      ws.calls; // 落盘走主进程，测试侧只断言协议事件已发出
      return { type: 'settings.state', settings: { ...settings, modelThinking: { ...settings.modelThinking, [p.usage]: p.thinking } } };
    }
    throw new Error(`未配置的请求：${p.type}`);
  };
}

beforeEach(() => {
  ws.calls.length = 0;
});

afterEach(() => {
  cleanup();
});

/** 定位 asideComment 行（含「评点（那句话与原地短聊）」label 的那一行）的思考灯泡 */
function asideBulb(): HTMLElement {
  const label = screen.getByText('评点（那句话与原地短聊）');
  // getByText 返回 label 文本的 div，其直接父=该行（row）——灯泡是本行 controls 内的 button
  const row = label.parentElement as HTMLElement;
  return row.querySelector('button[aria-label="开启思考"]') as HTMLElement;
}

describe('功能分配行思考开关（Track B，asideComment 行为）', () => {
  it('asideComment 默认关（廉价分档）→ 灯泡默认灭', async () => {
    configureWs(makeSettings());
    render(<BackendSettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('评点（那句话与原地短聊）')).toBeTruthy();
    });
    expect(asideBulb().getAttribute('aria-pressed')).toBe('false');
  });

  it('点亮 → 走 store 动作 → ws 协议 modelThinking.update（usage=asideComment, thinking=true）', async () => {
    configureWs(makeSettings());
    render(<BackendSettingsSection />);
    await waitFor(() => expect(asideBulb()).toBeTruthy());
    fireEvent.click(asideBulb());
    await waitFor(() => {
      expect(
        ws.calls.some(
          (c) => c.type === 'modelThinking.update' && c.usage === 'asideComment' && c.thinking === true,
        ),
      ).toBe(true);
    });
    // 乐观翻转：本地灯泡即时点亮
    expect(asideBulb().getAttribute('aria-pressed')).toBe('true');
  });

  it('settings.modelThinking[asideComment]=true → 灯泡初始点亮', async () => {
    configureWs(makeSettings({ asideCommentThinking: true }));
    render(<BackendSettingsSection />);
    await waitFor(() => {
      expect(asideBulb().getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('当前选到不支持思考的模型 → 灯泡置灰（disabled，开不了）', async () => {
    const s = makeSettings({ asideCommentThinking: true, asideModelSupportsReasoning: false });
    s.modelAssignments.asideComment = 'model-1';
    configureWs(s);
    render(<BackendSettingsSection />);
    await waitFor(() => {
      const bulb = asideBulb();
      expect(bulb.getAttribute('aria-pressed')).toBe('true');
      expect((bulb as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
