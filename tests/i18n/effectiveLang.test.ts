/**
 * 主进程语言归约 resolveEffectiveLang（D4 回落用）——显式 zh/en 原样；'system'/undefined
 * 看 OS（app.getLocale），非中文一律 en。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getLocaleMock } = vi.hoisted(() => ({ getLocaleMock: vi.fn<() => string>() }));
vi.mock('electron', () => ({ app: { getLocale: getLocaleMock } }));

import { resolveEffectiveLang } from '../../electron/main/i18n/effectiveLang';

beforeEach(() => getLocaleMock.mockReset());

describe('resolveEffectiveLang', () => {
  it('显式 zh / en 原样返回，不看 OS', () => {
    getLocaleMock.mockReturnValue('fr-FR');
    expect(resolveEffectiveLang('zh')).toBe('zh');
    expect(resolveEffectiveLang('en')).toBe('en');
    expect(getLocaleMock).not.toHaveBeenCalled();
  });

  it("'system' → 看 OS：中文 OS 落 zh", () => {
    getLocaleMock.mockReturnValue('zh-CN');
    expect(resolveEffectiveLang('system')).toBe('zh');
  });

  it("'system' / undefined → 非中文 OS 一律 en", () => {
    getLocaleMock.mockReturnValue('fr-FR');
    expect(resolveEffectiveLang('system')).toBe('en');
    expect(resolveEffectiveLang(undefined)).toBe('en');
  });
});
