/** @vitest-environment jsdom */
/**
 * 评点设置行（二期 §3）：模型 select 旁的思考灯泡（aria-pressed 按钮，点亮＝先思考再开口）。
 * - 行 label 为「评点（那句话与原地短聊）」——短评与短聊共用，用户不该分清两者
 * - 灯泡默认灭（settings.asideThinking 缺省）；点亮 → settings.update { asideThinking: true }
 * - settings.state 带 asideThinking: true 时初始点亮
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { Settings } from '@shared/types';

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

function makeSettings(asideThinking?: boolean): Settings {
  return {
    theme: 'system',
    colorScheme: 'terracotta',
    manualApiKey: null,
    asideThinking,
    providers: [{ id: 'prov-1', type: 'openrouter', label: 'OR', apiKey: 'sk' }],
    models: [
      {
        id: 'model-1',
        providerId: 'prov-1',
        modelId: 'm-1',
        label: 'm-1',
        contextWindow: 200000,
        supportsVision: true,
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
    throw new Error(`未配置的请求：${p.type}`);
  };
}

beforeEach(() => {
  ws.calls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('评点设置行', () => {
  it('label 为「评点（那句话与原地短聊）」，思考灯泡默认灭', async () => {
    configureWs(makeSettings());
    render(<BackendSettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('评点（那句话与原地短聊）')).toBeTruthy();
    });
    const bulb = screen.getByRole('button', { name: '评点时思考' });
    expect(bulb.getAttribute('aria-pressed')).toBe('false');
  });

  it('点亮灯泡 → settings.update { asideThinking: true }', async () => {
    configureWs(makeSettings());
    render(<BackendSettingsSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '评点时思考' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '评点时思考' }));
    await waitFor(() => {
      expect(
        ws.calls.some(
          (c) => c.type === 'settings.update' && c.settings.asideThinking === true,
        ),
      ).toBe(true);
    });
  });

  it('settings.asideThinking: true → 灯泡初始点亮', async () => {
    configureWs(makeSettings(true));
    render(<BackendSettingsSection />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '评点时思考' }).getAttribute('aria-pressed'),
      ).toBe('true');
    });
  });
});
