/**
 * 「本机 Claude 登录」显式模型分配的 sentinel 解析——UI 存 `local:<sdkModel>`，
 * factory / ownership 镜像共用此解析拦截它 → ClaudeCodeBackend。
 */
import { describe, it, expect } from 'vitest';
import {
  LOCAL_CLAUDE_MODELS,
  localClaudeAssignment,
  parseLocalClaudeAssignment,
} from '@shared/agent/localClaudeModels';

describe('parseLocalClaudeAssignment', () => {
  it('三款白名单模型往返', () => {
    for (const m of LOCAL_CLAUDE_MODELS) {
      expect(parseLocalClaudeAssignment(localClaudeAssignment(m.sdkModel))).toBe(m.sdkModel);
    }
  });

  it('null / 空 / 注册模型 id / 无前缀 → null', () => {
    expect(parseLocalClaudeAssignment(null)).toBeNull();
    expect(parseLocalClaudeAssignment(undefined)).toBeNull();
    expect(parseLocalClaudeAssignment('')).toBeNull();
    expect(parseLocalClaudeAssignment('mdl_abc123')).toBeNull();
    expect(parseLocalClaudeAssignment('claude-opus-4-8')).toBeNull();
  });

  it('带前缀但不在白名单 → null（脏 sentinel 当未识别，回落默认档）', () => {
    expect(parseLocalClaudeAssignment('local:claude-opus-9-9')).toBeNull();
    expect(parseLocalClaudeAssignment('local:')).toBeNull();
  });
});
