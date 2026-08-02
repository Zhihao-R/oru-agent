/**
 * mainChatStatus（UI 门禁口径：主对话是否有可用模型后端）。
 *
 * 行为锚点：多 backend 时代「不能聊」= 没有任何可用后端，而非 Claude 鉴权缺失——
 * 已分配模型且后端就绪即 ready；twinMain 未分配（走本机 Claude 回落）且未就绪时，
 * hint 改写成「配置供应商 / 登录 Claude Code」双路径引导，不再是 Claude 中心文案。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ORU_DIR = join(tmpdir(), `oru-test-mainchatstatus-${Date.now()}`);

const { getBackendForMock, isReadyMock, getSettingsMock } = vi.hoisted(() => ({
  getBackendForMock: vi.fn(),
  isReadyMock: vi.fn<() => Promise<{ ok: boolean; hint: string }>>(),
  getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
}));
vi.mock('../../electron/main/agent/backends/factory', () => ({ getBackendFor: getBackendForMock }));
vi.mock('../../electron/main/projects/store', async (orig) => ({ ...(await orig()), getSettings: getSettingsMock }));

import { mainChatStatus } from '../../electron/main/agent/backends/readiness';

beforeEach(() => {
  vi.clearAllMocks();
  getBackendForMock.mockResolvedValue({ isReady: isReadyMock });
  isReadyMock.mockResolvedValue({ ok: true, hint: '已使用 openrouter' });
  getSettingsMock.mockResolvedValue({ modelAssignments: { twinMain: 'mdl_1' } } as never);
});

describe('mainChatStatus', () => {
  it('后端就绪 → ready（hint 透传）', async () => {
    const s = await mainChatStatus();
    expect(s).toEqual({ ready: true, hint: '已使用 openrouter' });
  });

  it('已分配模型但后端未就绪 → 透传后端原因（缺 key 等）', async () => {
    isReadyMock.mockResolvedValue({ ok: false, hint: 'openrouter provider 缺少 API Key——请去 Settings 填入' });
    const s = await mainChatStatus();
    expect(s).toEqual({ ready: false, hint: 'openrouter provider 缺少 API Key——请去 Settings 填入' });
  });

  it('twinMain 未分配（走 Claude 回落）且未就绪 → hint 改写为双路径引导，按 owner 语言取词', async () => {
    isReadyMock.mockResolvedValue({ ok: false, hint: '尚未检测到鉴权；请登录 Claude Code 或在设置里填入 API Key' });
    getSettingsMock.mockResolvedValue({ modelAssignments: { twinMain: null }, language: 'zh' } as never);
    const zh = await mainChatStatus();
    expect(zh.ready).toBe(false);
    expect(zh.hint).toContain('添加供应商并分配模型');
    expect(zh.hint).toContain('登录 Claude Code');

    getSettingsMock.mockResolvedValue({ modelAssignments: { twinMain: null }, language: 'en' } as never);
    const en = await mainChatStatus();
    expect(en.ready).toBe(false);
    expect(en.hint).toContain('add a provider and assign a model');
  });

  it('backend 构造期抛错（如 custom-openai 缺 baseUrl）→ ready:false + 错误消息', async () => {
    getBackendForMock.mockRejectedValue(new Error('custom-openai provider 缺少 baseUrl'));
    const s = await mainChatStatus();
    expect(s).toEqual({ ready: false, hint: 'custom-openai provider 缺少 baseUrl' });
  });
});
