/**
 * 工具名前缀归一（shared/agent/toolName）单测。
 *
 * 背景：claude-code 后端把 Oru 自有工具桥成 'oru' MCP server，事件名带 mcp__oru__
 * 前缀；anthropic / openai 后端给裸名。所有按工具名消费事件的地方统一走 normalizeToolName。
 *
 * attacker 场景：mcp__<其他 server>__ 是真外部 MCP 工具的注册名（mcp/reflectTool.ts），
 * 归一成裸名会让外部工具冒充 Oru 自有工具（名字撞上就走错分支）——必须原样保留。
 */
import { describe, expect, it } from 'vitest';
import { isExternalMcpToolName, normalizeToolName } from '../../shared/agent/toolName';

describe('normalizeToolName', () => {
  it('剥 mcp__oru__ 前缀取裸名', () => {
    expect(normalizeToolName('mcp__oru__ask_user_choice')).toBe('ask_user_choice');
    expect(normalizeToolName('mcp__oru__record_memory')).toBe('record_memory');
  });

  it('裸名与 SDK 内置名原样保留', () => {
    expect(normalizeToolName('read_file')).toBe('read_file');
    expect(normalizeToolName('Edit')).toBe('Edit');
  });

  it('attacker：外部 MCP 工具名（非 oru 前缀）不归一——不能冒充 Oru 自有工具', () => {
    expect(normalizeToolName('mcp__github__record_memory')).toBe('mcp__github__record_memory');
    expect(normalizeToolName('mcp__other__ask_user_choice')).toBe('mcp__other__ask_user_choice');
  });

  it('前缀出现在中间不剥（只认开头）', () => {
    expect(normalizeToolName('x_mcp__oru__y')).toBe('x_mcp__oru__y');
  });
});

describe('isExternalMcpToolName（只读闸 fail-closed 判定）', () => {
  it('外部 MCP 工具名 → true', () => {
    expect(isExternalMcpToolName('mcp__github__create_issue')).toBe(true);
  });
  it('Oru 自有桥名 / 裸名 / SDK 内置名 → false', () => {
    expect(isExternalMcpToolName('mcp__oru__bash')).toBe(false);
    expect(isExternalMcpToolName('read_file')).toBe(false);
    expect(isExternalMcpToolName('Edit')).toBe(false);
  });
});

/**
 * 双前缀归一：外部 MCP 改走反射后（2026-07-27），反射工具桥进 'oru' MCP server，
 * SDK 再加一层前缀，wire 名成 mcp__oru__mcp__<serverId>__<tool>。
 * 「归一名 == AgentTool 注册名」这条不变量从此承重——只读闸、断路器分桶、查表全靠它。
 */
describe('双前缀 wire 名（外部 MCP 反射工具桥接后）', () => {
  it('只剥外层 mcp__oru__，归一结果正是反射工具的注册名', () => {
    expect(normalizeToolName('mcp__oru__mcp__chrome-devtools__click')).toBe(
      'mcp__chrome-devtools__click',
    );
  });

  it('归一后仍认得出是外部 MCP 工具（剥两层会让它冒充 Oru 自有工具）', () => {
    const wire = 'mcp__oru__mcp__filesystem__write_file';
    expect(isExternalMcpToolName(wire)).toBe(false); // 未归一时被外层前缀骗过
    expect(isExternalMcpToolName(normalizeToolName(wire))).toBe(true); // 归一后才判得对
  });
});
