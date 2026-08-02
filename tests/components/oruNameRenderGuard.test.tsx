/** @vitest-environment jsdom */
/**
 * 称呼收敛「调用点」回归守卫——专防「组件声明了 oruName 却没传进 t(key,{name})」这类 bug：
 * i18n 快照测试只验模板（t 显式传 name），抓不到调用点漏传；漏传时 {{name}} 会原样/空串渲染。
 * 这里真渲染组件，断言收敛文案里出现解析出的名字、不出现字面 {{name}}。
 * 无 active agent → useOruName 回落物种名 Oru。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(_p: ClientRequestPayload): Promise<T> =>
      ({ type: 'noop' }) as unknown as T,
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { SkillGroups } from '@/components/settings/CapabilitiesSection';

afterEach(cleanup);

describe('称呼收敛渲染守卫（无 active agent → 回落 Oru）', () => {
  it('能力页 Skill 空态 emptyHint 渲染出名字、不漏字面 {{name}}', () => {
    // 默认 skillModuleStore.skills = []（空态），agentStore 无 agent → useOruName = Oru
    render(<SkillGroups selectedSkillId={null} onSelectSkill={() => {}} />);
    // 收敛后文案：「Oru 在帮你跑完复杂任务后会主动提议…」——名字必须真出现
    expect(screen.getByText(/^Oru 在帮你跑完复杂任务/)).toBeTruthy();
    // 调用点漏传 { name } 时 i18next 会把 {{name}} 渲成空串/字面——两种都不许出现
    expect(screen.queryByText(/\{\{name\}\}/)).toBeNull();
    expect(screen.queryByText(/^\s*在帮你跑完复杂任务/)).toBeNull();
  });
});
