/**
 * HTTP 后端（anthropic / openaiCompatible）不读 input.userMessage 的跨 backend 契约——显式化为 fail-fast。
 *
 * 背景：只有 claudeCode 后端兜底读 userMessage；anthropic/openaiCompatible 只 replay history。
 * 历史上 dream 传 `history:[] + userMessage` 到 HTTP 后端 → prompt 被静默丢弃、模型只收到 system
 * prompt 空转（记忆 project_oru_backend_usermessage_contract_trap）。契约此前只活在注释里，抓不住回归。
 *
 * 本测试钉住 assertCurrentTurnInHistory：当前 user 轮必须在 history 末尾，否则 throw（把静默丢 prompt
 * 变成起流前就炸的显式错误），并验证两个 HTTP 后端的 runConversation 入口确实接了这道闸。
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@shared/types';
import type { ConversationInput } from '@shared/agent/backend';
import {
  assertCurrentTurnInHistory,
  ensureCurrentTurnInHistory,
  CONTINUE_NOTE,
} from '../../electron/main/agent/backends/historyContract';
import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';

function userMsg(text: string): ChatMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'user',
    text,
    toolCalls: [],
    createdAt: 0,
    done: true,
  };
}
function assistantMsg(text: string): ChatMessage {
  return { ...userMsg(text), id: 'm2', role: 'assistant' };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) void _;
}

describe('assertCurrentTurnInHistory 契约', () => {
  it('history 末尾是 user 轮 → 不抛', () => {
    expect(() =>
      assertCurrentTurnInHistory({ history: [userMsg('hi')], userMessage: 'hi' }, 'anthropic'),
    ).not.toThrow();
  });

  it('空 history + userMessage → 抛（dream 空转的确切场景）', () => {
    expect(() =>
      assertCurrentTurnInHistory({ history: [], userMessage: '复盘一下今天' }, 'anthropic'),
    ).toThrow(/anthropic/);
  });

  it('history 未定义 + userMessage → 抛', () => {
    expect(() =>
      assertCurrentTurnInHistory({ userMessage: 'x' }, 'openaiCompatible'),
    ).toThrow(/openaiCompatible/);
  });

  it('history 末尾是 assistant 轮 → 抛（当前 user 轮没落进 history 末尾）', () => {
    expect(() =>
      assertCurrentTurnInHistory(
        { history: [userMsg('hi'), assistantMsg('回答')], userMessage: undefined },
        'anthropic',
      ),
    ).toThrow();
  });

  it('抛错信息点名 userMessage 会被静默丢弃（可诊断）', () => {
    expect(() =>
      assertCurrentTurnInHistory({ history: [], userMessage: 'lost prompt' }, 'anthropic'),
    ).toThrow(/userMessage/);
  });
});

// ─── ensureCurrentTurnInHistory：契约的兑现层（runner 起流前把违约 history 补成合规）──────────
//
// 七条「非用户发起」路径（[重试] / loop 干活轮 / 审批续跑 / 断线自动接续 / 任务播报 /
// 后台命令播报 / 冲突裁决回报）都把当前轮输入只放在 userText（或干脆没有），history 末尾
// 停在 assistant 轮——HTTP 后端只 replay history，撞 assert 或静默失败。兑现层统一补齐。
describe('ensureCurrentTurnInHistory 兑现层', () => {
  it('claude-code → 原样返回（它读 userMessage / 续 session，不需要补）', () => {
    const history = [userMsg('hi'), assistantMsg('半截')];
    expect(ensureCurrentTurnInHistory(history, '继续引导', 'claude-code', 'c1')).toBe(history);
  });

  it('HTTP + 末尾 assistant + 有 nudge → 追加 nudge 作末尾 user 轮（loop/播报形态）', () => {
    const history = [userMsg('hi'), assistantMsg('第一轮产出')];
    const out = ensureCurrentTurnInHistory(history, '第一轮差一项，补齐', 'openai-compatible', 'c1');
    const tail = out[out.length - 1];
    expect(tail.role).toBe('user');
    expect(tail.text).toBe('第一轮差一项，补齐');
    expect(out).toHaveLength(3);
    expect(history).toHaveLength(2); // 不改原数组（history 是共享读取视图）
  });

  it('HTTP + 末尾 assistant + 无 nudge → 追加系统记续跑轮（[重试]/审批续跑形态）', () => {
    const history = [userMsg('hi'), assistantMsg('被打断的半截')];
    const out = ensureCurrentTurnInHistory(history, undefined, 'anthropic', 'c1');
    const tail = out[out.length - 1];
    expect(tail.role).toBe('user');
    expect(tail.text).toBe(CONTINUE_NOTE);
  });

  it('HTTP + 末尾 user 文本等于 userText → 不动（chat.send 正常形态，别喂两遍）', () => {
    const history = [userMsg('hi')];
    expect(ensureCurrentTurnInHistory(history, 'hi', 'openai-compatible', 'c1')).toBe(history);
  });

  it('HTTP + 末尾 user + 无 userText → 不动（拒绝提案后的系统记续跑，末尾已合规）', () => {
    const history = [userMsg('（系统记：用户拒绝了提案 x）')];
    expect(ensureCurrentTurnInHistory(history, undefined, 'anthropic', 'c1')).toBe(history);
  });

  it('HTTP + 末尾 user 文本 ≠ userText → 追加（残余盲区：新 nudge 撞遗留 user 末尾也不静默丢）', () => {
    const history = [userMsg('用户上一句没被回应的话')];
    const out = ensureCurrentTurnInHistory(history, '后台任务完成，去播报', 'openai-compatible', 'c1');
    expect(out).toHaveLength(2);
    expect(out[1].text).toBe('后台任务完成，去播报');
  });

  it('HTTP + 空 history + 有 userText → 追加（dream 形态的兑现层兜底）', () => {
    const out = ensureCurrentTurnInHistory([], '复盘一下今天', 'anthropic', 'c1');
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].text).toBe('复盘一下今天');
    expect(out[0].conversationId).toBe('c1');
  });

  it('补齐后的 history 过 assert 不抛（兑现层与断言层口径一致）', () => {
    const out = ensureCurrentTurnInHistory([userMsg('hi'), assistantMsg('a')], undefined, 'anthropic', 'c1');
    expect(() =>
      assertCurrentTurnInHistory({ history: out, userMessage: undefined }, 'anthropic'),
    ).not.toThrow();
  });
});

// ─── wiring：两个 HTTP 后端入口确实接了这道闸（起流前抛，先于任何网络调用）──────────
function badInput(overrides: Partial<ConversationInput> = {}): ConversationInput {
  return {
    agentId: 'a1',
    conversationId: 'c1',
    userMessage: '会被静默丢的 prompt',
    history: [], // 空 history —— 违约
    cwd: process.cwd(),
    abortController: new AbortController(),
    ...overrides,
  };
}

describe('HTTP 后端 runConversation 入口接闸', () => {
  it('AnthropicBackend 空 history + userMessage → drain 时抛（无网络）', async () => {
    const backend = new AnthropicBackend({ apiKey: 'sk-test', defaultModel: 'claude-x' });
    const handle = backend.runConversation(badInput());
    await expect(drain(handle.events)).rejects.toThrow(/anthropic/i);
  });

  it('OpenAICompatibleBackend 空 history + userMessage → drain 时抛（无网络）', async () => {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-test',
      defaultModel: 'gpt-x',
      baseURL: 'https://example.invalid/v1',
      providerType: 'openai',
    });
    const handle = backend.runConversation(badInput());
    await expect(drain(handle.events)).rejects.toThrow(/openaiCompatible|openai/i);
  });
});
