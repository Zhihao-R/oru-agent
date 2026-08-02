/**
 * 后台命令工具行活状态（2026-07-20 拍板）：复用 ToolCallLine 底座，
 * 状态以登记表实时数据为准——跑着 = 绿脉冲 + 时长；结束按真实结局定成败
 * （工具调用本身恒 success"已启动"，照抄会把跑挂的命令谎报成绿）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(_payload: ClientRequestPayload): Promise<T> => {
      throw new Error('本测试不应触发 ws 请求');
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { ToolCallLine } from '@/components/chat/ToolCallLine';
import { useBgCommandStore } from '@/stores/bgCommandStore';
import type { BgCommandView } from '@shared/protocol';
import type { ToolCall } from '@shared/types';

function bgTool(id: string | null): ToolCall {
  return {
    id: 'tc1',
    name: 'mcp__oru__bash',
    input: { command: 'npm run dev', run_in_background: true },
    status: 'success',
    startedAt: 1000,
    finishedAt: 1200,
    result: {
      toolCallId: 'tc1',
      isError: false,
      summary: '已启动',
      ...(id ? { structured: { backgroundCommand: { id } } } : {}),
    },
  };
}

function bgView(patch: Partial<BgCommandView>): BgCommandView {
  return {
    id: 'bash-bg-x',
    conversationId: 'c1',
    status: 'running',
    exitCode: null,
    timedOut: false,
    startedAt: Date.now() - 65_000,
    finishedAt: null,
    ...patch,
  };
}

function dotOf(name: string): Element {
  const line = screen.getByText(name).closest('button');
  if (!line) throw new Error('工具行不存在');
  const dot = line.querySelector('span');
  if (!dot) throw new Error('状态点不存在');
  return dot;
}

beforeEach(() => {
  useBgCommandStore.setState({ byId: {} });
});
afterEach(cleanup);

describe('后台命令工具行', () => {
  it('运行中：行文字是命令本身（非工具名）+ 绿脉冲 + 时长（settled 不压后台命令的脉冲）', () => {
    useBgCommandStore.setState({ byId: { 'bash-bg-x': bgView({}) } });
    render(<ToolCallLine tool={bgTool('bash-bg-x')} settled />);
    expect(screen.queryByText('bash')).toBeNull(); // 两条后台命令必须可分辨——显示命令不显示工具名
    expect(dotOf('npm run dev').className).toContain('animate-pulse');
    expect(screen.getByText(/运行中 1:0[0-9]/)).toBeTruthy();
  });

  it('退出码非 0：红点，不再显示时长', () => {
    useBgCommandStore.setState({
      byId: { 'bash-bg-x': bgView({ status: 'exited', exitCode: 1, finishedAt: Date.now() }) },
    });
    render(<ToolCallLine tool={bgTool('bash-bg-x')} settled />);
    expect(dotOf('npm run dev').className).toContain('bg-danger');
    expect(screen.queryByText(/运行中/)).toBeNull();
  });

  it('正常退出：绿点稳定（不脉冲）', () => {
    useBgCommandStore.setState({
      byId: { 'bash-bg-x': bgView({ status: 'exited', exitCode: 0, finishedAt: Date.now() }) },
    });
    render(<ToolCallLine tool={bgTool('bash-bg-x')} settled />);
    expect(dotOf('npm run dev').className).toContain('bg-success');
    expect(dotOf('npm run dev').className).not.toContain('animate-pulse');
  });

  it('崩溃遗留（crashed）：红点', () => {
    useBgCommandStore.setState({
      byId: { 'bash-bg-x': bgView({ status: 'crashed', finishedAt: Date.now() }) },
    });
    render(<ToolCallLine tool={bgTool('bash-bg-x')} settled />);
    expect(dotOf('npm run dev').className).toContain('bg-danger');
  });

  it('无后台标记的普通 bash：不接登记表，显示工具名、按工具自身状态渲染', () => {
    render(<ToolCallLine tool={bgTool(null)} settled />);
    expect(dotOf('bash').className).toContain('bg-success');
    expect(screen.queryByText(/运行中/)).toBeNull();
  });
});
