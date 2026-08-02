/** @vitest-environment jsdom */
/**
 * 设置 ▸ 权限与行为 ▸ 权限策略表（2026-07-31 双向开关拍板，取代 2026-07-30 v1）：
 * - 静态行渲染齐全（行为区 + 修饰区，来自 shared/proposals/behaviors.ts 注册表）；
 * - 默认问的行拨杆「开→免卡」调 grants.add、「关→重问」调 grants.revoke；
 * - 默认不问的 askable 行（新建/修改内容、覆盖 Oru 自己的产出）拨杆「关→每次问」调
 *   behaviorPolicy.setAsk（收紧覆盖），开关语义统一「开=直接执行」；
 * - 灾难级锁定行无拨杆、显示「始终询问」；读取/派工/经命令行删改文件只显示状态（无拨杆）；
 * - 「发送内容到外部」有总开关（grants.add category:sendExternal），收件人行随授权动态长出、可逐条撤销；
 * - 只读 / 危险挡下整表置灰（拨杆 disabled）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { Agent, Grant } from '@shared/types';
import { grantKey } from '@shared/proposals/grantKey';

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

import { PermissionsSection } from '@/components/settings/PermissionsSection';
import { useAgentStore } from '@/stores/agentStore';

let grants: Grant[];
let askRows: string[];

function setAgent(mode: Agent['approvalMode']): void {
  useAgentStore.setState({
    activeAgentId: 'twin',
    agents: [
      {
        id: 'twin',
        ownerId: 'local-user',
        name: 'Oru',
        homePath: '/tmp/h',
        approvalMode: mode,
      } as Agent,
    ],
  });
}

beforeEach(() => {
  ws.calls.length = 0;
  grants = [
    { scope: { kind: 'overwrite' }, grantedAt: 1, label: '覆盖既有内容' },
    { scope: { kind: 'delivery', channel: 'feishu', recipient: 'oc_1' }, grantedAt: 2, label: '向 飞书:研发群 外发' },
  ];
  askRows = [];
  ws.impl = async (p) => {
    if (p.type === 'grants.list') return { type: 'grants.list.result', grants };
    if (p.type === 'grants.add') {
      grants = [...grants, { scope: p.scope, grantedAt: 3, label: '（后端推导的标签）' }];
      return { type: 'grants.list.result', grants };
    }
    if (p.type === 'grants.revoke') {
      grants = grants.filter((g) => grantKey(g.scope) !== p.key);
      return { type: 'grants.list.result', grants };
    }
    if (p.type === 'behaviorPolicy.list') return { type: 'behaviorPolicy.list.result', askRows };
    if (p.type === 'behaviorPolicy.setAsk') {
      askRows = p.ask ? [...askRows, p.rowId] : askRows.filter((r) => r !== p.rowId);
      return { type: 'behaviorPolicy.list.result', askRows };
    }
    throw new Error(`未配置的请求：${p.type}`);
  };
  setAgent('work');
});
afterEach(cleanup);

/** 行容器（SettingsRow 根 div）内查询，避免跨行误命中。 */
function rowOf(text: string): HTMLElement {
  const el = screen.getByText(text).closest('div[class*="justify-between"]');
  if (!el) throw new Error(`找不到行：${text}`);
  return el as HTMLElement;
}

describe('权限策略表（2026-07-31 双向开关）', () => {
  it('静态行渲染齐全：行为区 13 行 + 修饰区 4 行', async () => {
    render(<PermissionsSection />);
    await waitFor(() => screen.getByText('访问网站'));
    for (const title of [
      '读取内容', '访问网站', '新建内容', '修改既有内容', '覆盖既有内容', '删除内容',
      '发送内容到外部', '变更系统环境 · MCP', '变更系统环境 · 插件', '变更系统环境 · Skill',
      '创建自动化任务', '破坏性命令', '派工子代理',
      '灾难级命令', '看不透的命令', '经命令行删改文件', '覆盖 Oru 自己的产出',
    ]) {
      expect(screen.getByText(title), `缺行：${title}`).toBeTruthy();
    }
  });

  it('拨杆「关→开」调 grants.add（label 由后端经注册表推导，协议不传）', async () => {
    render(<PermissionsSection />);
    const sw = await waitFor(() => within(rowOf('破坏性命令')).getByRole('switch'));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(ws.calls).toContainEqual({
        type: 'grants.add',
        scope: { kind: 'destructive' },
      }),
    );
    await waitFor(() =>
      expect(within(rowOf('破坏性命令')).getByRole('switch').getAttribute('aria-checked')).toBe('true'),
    );
  });

  it('拨杆「开→关」调 grants.revoke（稳定键）', async () => {
    render(<PermissionsSection />);
    // 预置已授权：覆盖既有内容
    const sw = await waitFor(() => within(rowOf('覆盖既有内容')).getByRole('switch'));
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(ws.calls).toContainEqual({ type: 'grants.revoke', key: 'overwrite' }));
  });

  it('askable 行（新建内容）默认开；拨关调 behaviorPolicy.setAsk（收紧覆盖），拨回恢复', async () => {
    render(<PermissionsSection />);
    const sw = await waitFor(() => within(rowOf('新建内容')).getByRole('switch'));
    expect(sw.getAttribute('aria-checked')).toBe('true'); // 默认开 = 直接执行
    fireEvent.click(sw); // 拨关 = 每次问
    await waitFor(() =>
      expect(ws.calls).toContainEqual({ type: 'behaviorPolicy.setAsk', rowId: 'create', ask: true }),
    );
    await waitFor(() =>
      expect(within(rowOf('新建内容')).getByRole('switch').getAttribute('aria-checked')).toBe('false'),
    );
    fireEvent.click(within(rowOf('新建内容')).getByRole('switch')); // 拨回 = 恢复默认
    await waitFor(() =>
      expect(ws.calls).toContainEqual({ type: 'behaviorPolicy.setAsk', rowId: 'create', ask: false }),
    );
  });

  it('发送内容到外部：总开关调 grants.add category:sendExternal；收件人行动态长出、可撤销', async () => {
    render(<PermissionsSection />);
    const sw = await waitFor(() => within(rowOf('发送内容到外部')).getByRole('switch'));
    expect(sw.getAttribute('aria-checked')).toBe('false'); // 总开关默认关
    fireEvent.click(sw);
    await waitFor(() =>
      expect(ws.calls).toContainEqual({
        type: 'grants.add',
        scope: { kind: 'category', id: 'sendExternal' },
      }),
    );
    // 收件人行自身无拨杆（按收件人授权，只能撤销）
    await waitFor(() => screen.getByText('向 飞书:研发群 外发'));
    expect(within(rowOf('向 飞书:研发群 外发')).queryByRole('switch')).toBeNull();
    fireEvent.click(within(rowOf('向 飞书:研发群 外发')).getByText('撤销'));
    await waitFor(() =>
      expect(ws.calls).toContainEqual({ type: 'grants.revoke', key: 'delivery:feishu:oc_1' }),
    );
  });

  it('灾难级锁定行无拨杆、显示「始终询问」；读取/派工/经命令行删改文件只显示状态', async () => {
    render(<PermissionsSection />);
    await waitFor(() => screen.getByText('灾难级命令'));
    expect(within(rowOf('灾难级命令')).queryByRole('switch')).toBeNull();
    expect(within(rowOf('灾难级命令')).getByText('始终询问')).toBeTruthy();
    expect(within(rowOf('读取内容')).queryByRole('switch')).toBeNull();
    expect(within(rowOf('读取内容')).getByText('直接执行')).toBeTruthy();
    expect(within(rowOf('派工子代理')).queryByRole('switch')).toBeNull();
    expect(within(rowOf('经命令行删改文件')).queryByRole('switch')).toBeNull();
    expect(within(rowOf('经命令行删改文件')).getByText('每次询问')).toBeTruthy();
  });

  it('修饰区 label 带 hover tip（原生 title 属性）', async () => {
    render(<PermissionsSection />);
    await waitFor(() => screen.getByText('看不透的命令'));
    expect(screen.getByText('看不透的命令').getAttribute('title')).toContain('静态分析');
    expect(screen.getByText('读取内容').getAttribute('title')).toBeNull(); // 无 tipKey 的行不带
  });

  it('只读挡下整表置灰：拨杆 disabled + 提示只读', async () => {
    setAgent('readonly');
    render(<PermissionsSection />);
    const sw = await waitFor(() => within(rowOf('破坏性命令')).getByRole('switch'));
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/策略表只读/)).toBeTruthy();
  });
});
