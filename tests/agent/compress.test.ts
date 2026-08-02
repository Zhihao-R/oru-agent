/**
 * compress 两阶段压缩回归：摘要范围必须与压缩范围同源。
 *
 * 老 bug：摘要 LLM 只对 N=5 边界的 startToCompress 生成，递减循环落在 n<5 时
 * finalToCompress 范围更大——多出的轮次进了 compressedMessageIds、从 trimmedHistory
 * 消失、却不在摘要里，内容静默丢失。修后两阶段：先用 SUMMARY_TOKEN_BUDGET 占位选 n，
 * 再按该 n 的范围调摘要并用真实 token 终校验。本文件断言：
 *   1. 递减到 n<5 时，摘要 prompt 覆盖完整 finalToCompress（含递减多出的轮次）
 *   2. compressedMessageIds 与 trimmedHistory 完全互补于原 history（无丢失 / 无重叠）
 *   3. 终校验失败 → 用真实 summaryTokens 重选 n 并按新范围重新生成摘要（2 次 LLM 调用）
 *   4. 第二次仍超 / 摘要 LLM 失败 → buildFallback 按当前 n 的范围硬丢，互补性依然成立
 *
 * mock 模式对齐 tests/smoke/__smoke_compress__.ts：__setBackendFactoryForTest 替换 backend。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend } from '@shared/agent/backend';
import type { ChatMessage } from '@shared/types';

// paths.ts 在模块加载时固化 ORU_DIR——必须先设环境变量再动态 import
if (!process.env.ORU_DIR) {
  process.env.ORU_DIR = mkdtempSync(join(tmpdir(), 'oru-compress-test-'));
}
const { compressIfNeeded } = await import('../../electron/main/agent/context/compress');
const { __setBackendFactoryForTest } = await import(
  '../../electron/main/agent/backends/factory'
);

// ─── 测试常量 ────────────────────────────────────────────────
// effectiveWindow=10000 → 阈值 8000；SUMMARY_TOKEN_BUDGET=2250（compress.ts 内部常量）
// estimateTokens 对 ASCII 是 0.28 token/char：'x'.repeat(2000) ≈ 560 token
const WINDOW = 10_000;

function mkMsg(id: string, role: 'user' | 'assistant', text: string): ChatMessage {
  return { id, conversationId: 'c1', role, text, toolCalls: [], createdAt: 0, done: true };
}

function makeMockBackend(onCall: (prompt: string, callIdx: number) => string): AgentBackend {
  let calls = 0;
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'mdl_summary',
    providerId: 'prv_summary',
    runConversation: () => {
      throw new Error('not used');
    },
    runOneShot: async (input) => {
      const idx = calls;
      calls += 1;
      return { text: onCall(input.prompt, idx) };
    },
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  };
}

/** 断言 compressedMessageIds 与 trimmedHistory（去掉通知卡）完全互补于原 history。 */
function expectComplementary(
  history: ChatMessage[],
  compressedIds: string[],
  trimmedHistory: ChatMessage[],
): void {
  const keptIds = trimmedHistory.filter((m) => m.kind !== 'context-compressed').map((m) => m.id);
  // 无重叠
  expect(compressedIds.filter((id) => keptIds.includes(id))).toEqual([]);
  // 无丢失：并集 = 全部原 history id
  expect([...compressedIds, ...keptIds].sort()).toEqual(history.map((m) => m.id).sort());
}

describe('compress 两阶段（摘要范围与压缩范围同源）', () => {
  it('递减到 n=4：摘要 prompt 覆盖完整 finalToCompress，compressedMessageIds 与 trimmedHistory 互补', async () => {
    // u3（最近第 5 个 user）巨大：base(5)≈7000+2250 > 8000 装不下 → n=4
    // 老 bug 下摘要只盖 [u1..a2]，u3/a3 进 compressedMessageIds 却不在摘要里
    const history: ChatMessage[] = [
      mkMsg('u1', 'user', 'MARK_U1 ' + 'x'.repeat(100)),
      mkMsg('a1', 'assistant', 'MARK_A1 ' + 'x'.repeat(100)),
      mkMsg('u2', 'user', 'MARK_U2 ' + 'x'.repeat(100)),
      mkMsg('a2', 'assistant', 'MARK_A2 ' + 'x'.repeat(100)),
      mkMsg('u3', 'user', 'MARK_U3 ' + 'h'.repeat(25_000)), // ≈7000 token
      mkMsg('a3', 'assistant', 'MARK_A3 ' + 'x'.repeat(100)),
      mkMsg('u4', 'user', 'MARK_U4 ' + 'x'.repeat(100)),
      mkMsg('a4', 'assistant', 'MARK_A4 ' + 'x'.repeat(100)),
      mkMsg('u5', 'user', 'x'.repeat(100)),
      mkMsg('a5', 'assistant', 'x'.repeat(100)),
      mkMsg('u6', 'user', 'x'.repeat(100)),
      mkMsg('a6', 'assistant', 'x'.repeat(100)),
      mkMsg('u7', 'user', '当前'),
    ];
    const prompts: string[] = [];
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend((p) => {
        prompts.push(p);
        return '压缩摘要v1';
      }),
    );
    try {
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        threshold: WINDOW * 0.8,
        force: true,
        ownerId: 'owner1',
      });
      expect(result).not.toBeNull();
      expect(result?.fallback).toBe(false);
      // 终校验通过路径：只调一次摘要 LLM
      expect(prompts).toHaveLength(1);
      // 摘要范围 = 最终 n=4 的 finalToCompress（u1..a3），含递减多出的 u3/a3
      expect(prompts[0]).toContain('MARK_U3');
      expect(prompts[0]).toContain('MARK_A3');
      expect(prompts[0]).not.toContain('MARK_U4');
      const compressedIds =
        result!.notificationMessage.contextCompressed!.compressedMessageIds;
      expect(compressedIds).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
      // 保留段从 u4 起（n=4）
      expect(result!.trimmedHistory[1].id).toBe('u4');
      expectComplementary(history, compressedIds, result!.trimmedHistory);
      // 通知卡按最终范围算轮数（u1/u2/u3 = 3 user）
      expect(result!.notificationMessage.text).toContain('3 轮');
    } finally {
      restore();
    }
  });

  it('终校验失败：用真实 summaryTokens 重选 n 并按新范围重新生成摘要（LLM 调 2 次）', async () => {
    // 13 条消息各 ≈560 token：base(5)=5040+2250 ≤ 8000 → firstN=5
    // 第一次摘要 4200 token：5040+4200 > 8000 终校验失败 → 重选 n=3（2800+4200 ≤ 8000）
    // 第二次按 n=3 的更大范围重新生成，摘要变短 → 通过
    const history: ChatMessage[] = [];
    for (let i = 1; i <= 7; i += 1) {
      history.push(mkMsg(`u${i}`, 'user', `MARK_U${i} ` + 'x'.repeat(2000)));
      if (i < 7) history.push(mkMsg(`a${i}`, 'assistant', `MARK_A${i} ` + 'x'.repeat(2000)));
    }
    const prompts: string[] = [];
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend((p, idx) => {
        prompts.push(p);
        return idx === 0 ? 'S'.repeat(15_000) : '第二次摘要';
      }),
    );
    try {
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        threshold: WINDOW * 0.8,
        force: true,
        ownerId: 'owner1',
      });
      expect(result).not.toBeNull();
      expect(result?.fallback).toBe(false);
      expect(prompts).toHaveLength(2);
      // 第一次按 n=5（u1..a2），第二次范围扩到 n=3（u1..a4）
      expect(prompts[0]).not.toContain('MARK_U3');
      expect(prompts[1]).toContain('MARK_U3');
      expect(prompts[1]).toContain('MARK_A4');
      // 落盘的必须是按扩大范围重新生成的第二次摘要（只降 n 不重生成会复现丢轮）
      expect(result!.notificationMessage.contextCompressed!.summaryText).toBe('第二次摘要');
      const compressedIds =
        result!.notificationMessage.contextCompressed!.compressedMessageIds;
      expect(compressedIds).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
      expect(result!.trimmedHistory[1].id).toBe('u5');
      expectComplementary(history, compressedIds, result!.trimmedHistory);
    } finally {
      restore();
    }
  });

  it('重选后第二次摘要仍超 → buildFallback 硬丢，互补性依然成立', async () => {
    const history: ChatMessage[] = [];
    for (let i = 1; i <= 7; i += 1) {
      history.push(mkMsg(`u${i}`, 'user', 'x'.repeat(2000)));
      if (i < 7) history.push(mkMsg(`a${i}`, 'assistant', 'x'.repeat(2000)));
    }
    let calls = 0;
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend(() => {
        calls += 1;
        // 第一次 4200 token（败在 n=5），第二次 5600 token（败在 n=3）
        return calls === 1 ? 'S'.repeat(15_000) : 'S'.repeat(20_000);
      }),
    );
    try {
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        threshold: WINDOW * 0.8,
        force: true,
        ownerId: 'owner1',
      });
      expect(result).not.toBeNull();
      expect(calls).toBe(2); // LLM 调用上界 2 次
      expect(result?.fallback).toBe(true);
      expect(result!.notificationMessage.contextCompressed!.summaryText).toBe('');
      // fallback 按重选后的 n=3 范围硬丢，互补性不破
      const compressedIds =
        result!.notificationMessage.contextCompressed!.compressedMessageIds;
      expect(compressedIds).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
      expectComplementary(history, compressedIds, result!.trimmedHistory);
    } finally {
      restore();
    }
  });

  it('摘要 LLM 失败：fallback 按当前 n 的范围硬丢（不退回 N=5 范围），互补性成立', async () => {
    // 复用首个用例的形状：u3 巨大使 firstN=4。LLM 抛错 → fallback 必须用 n=4 范围
    // （u1..a3）；若退回 N=5 范围（u1..a2），保留段含 7000 token 的 u3，无摘要也超窗
    const history: ChatMessage[] = [
      mkMsg('u1', 'user', 'x'.repeat(100)),
      mkMsg('a1', 'assistant', 'x'.repeat(100)),
      mkMsg('u2', 'user', 'x'.repeat(100)),
      mkMsg('a2', 'assistant', 'x'.repeat(100)),
      mkMsg('u3', 'user', 'h'.repeat(25_000)), // ≈7000 token
      mkMsg('a3', 'assistant', 'x'.repeat(100)),
      mkMsg('u4', 'user', 'x'.repeat(100)),
      mkMsg('a4', 'assistant', 'x'.repeat(100)),
      mkMsg('u5', 'user', 'x'.repeat(100)),
      mkMsg('a5', 'assistant', 'x'.repeat(100)),
      mkMsg('u6', 'user', 'x'.repeat(100)),
      mkMsg('a6', 'assistant', 'x'.repeat(100)),
      mkMsg('u7', 'user', '当前'),
    ];
    const restore = __setBackendFactoryForTest(async () =>
      makeMockBackend(() => {
        throw new Error('summary backend down');
      }),
    );
    try {
      const result = await compressIfNeeded({
        conversationId: 'c1',
        history,
        systemContext: '',
        threshold: WINDOW * 0.8,
        force: true,
        ownerId: 'owner1',
      });
      expect(result).not.toBeNull();
      expect(result?.fallback).toBe(true);
      const compressedIds =
        result!.notificationMessage.contextCompressed!.compressedMessageIds;
      // n=4 范围含 u3/a3——退回 N=5 范围的老行为会只丢 ['u1','a1','u2','a2']
      expect(compressedIds).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
      expectComplementary(history, compressedIds, result!.trimmedHistory);
    } finally {
      restore();
    }
  });
});
