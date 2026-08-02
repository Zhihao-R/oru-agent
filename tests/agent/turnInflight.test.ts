/**
 * 流式实时落盘 · 崩溃恢复兜底（S03 / G22）。
 *
 * 承重方向（与 steering 崩溃盘记同范式，对称的另一侧——AI 产出侧草稿）：
 *  1. 流式进行中把已成形的 partial（文字 + 悬空工具调用）镜像进 <convId>.turn-inflight.json；
 *     进程崩溃（既不走成功落盘、也不走优雅中断 catch）→ 重启扫描把草稿合成一条 incomplete
 *     assistant 消息补进对话 jsonl（interrupted='crashed'），已产出部分不随整轮蒸发。
 *  2. 正式落盘（成功 / 优雅中断）后同步清草稿——崩在「正式落盘后、清草稿前」→ 重启按 messageId
 *     幂等，不重复补（宁可依赖幂等、不可重复落一条）。
 *  3. 一个 token 都没产出（空 partial）不写草稿——不留空壳、扫描无可补。
 *
 * ORU_DIR 范式：顶层先设 env，被测模块全动态 import；「模拟进程重启」= vi.resetModules() 后重新
 * import（全新内存，读同一 ORU_DIR 磁盘）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PartialTurn, TurnMeta } from '../../electron/main/agent/interrupted';

const ORU_DIR = join(tmpdir(), `oru-test-turn-inflight-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

const meta: TurnMeta = {
  backendType: 'anthropic',
  toolProtocol: 'anthropic-native',
  modelId: 'm',
  providerId: 'p',
};

function inflightFilePath(agentId: string, convId: string): string {
  return join(ORU_DIR, 'users', 'local-user', 'conversations', agentId, `${convId}.turn-inflight.json`);
}

async function bootModules() {
  vi.resetModules();
  const t = await import('../../electron/main/agent/turnInflight');
  const store = await import('../../electron/main/conversations/store');
  return { ...t, ...store };
}

describe('草稿写盘：流式镜像 partial，空 partial 不留壳', () => {
  it('write 后落一份草稿；stop 后草稿仍在盘上（等重启扫描）', async () => {
    const m = await bootModules();
    const w = m.makeInflightWriter({ agentId: 'agtA', convId: 'cnvWrite', messageId: 'msg1', meta });
    const partial: PartialTurn = { resultText: '写到一半', toolCalls: [] };
    w.write(partial);
    await w.stop();
    expect(existsSync(inflightFilePath('agtA', 'cnvWrite'))).toBe(true);
    const draft = JSON.parse(await fs.readFile(inflightFilePath('agtA', 'cnvWrite'), 'utf-8'));
    expect(draft.messageId).toBe('msg1');
    expect(draft.partial.resultText).toBe('写到一半');
  });

  // 恢复消息按 createdAt 参与信息流排序：草稿 startedAt 必须是「回合开始」而非 writer 构造
  // 时刻——writer 在回合起点压缩（organizeContext 落卡）之后才建，构造时刻晚于压缩卡的
  // createdAt，崩溃恢复后压缩卡会错序到 assistant 前（与 runChatAndPersist 盖开始时刻同一不变量）。
  it('传入 startedAt 时草稿原样落盘（供恢复消息盖回合开始时刻）', async () => {
    const m = await bootModules();
    const w = m.makeInflightWriter({
      agentId: 'agtA',
      convId: 'cnvStarted',
      messageId: 'msg1',
      meta,
      startedAt: 12345,
    });
    w.write({ resultText: '写到一半', toolCalls: [] });
    await w.stop();
    const draft = JSON.parse(await fs.readFile(inflightFilePath('agtA', 'cnvStarted'), 'utf-8'));
    expect(draft.startedAt).toBe(12345);
  });

  it('空 partial（一个 token 都没产出）不写草稿', async () => {
    const m = await bootModules();
    const w = m.makeInflightWriter({ agentId: 'agtA', convId: 'cnvEmpty', messageId: 'msg1', meta });
    w.write({ resultText: '', toolCalls: [] });
    await w.stop();
    expect(existsSync(inflightFilePath('agtA', 'cnvEmpty'))).toBe(false);
  });
});

describe('崩溃恢复：重启扫描草稿 → 合成 crashed 半截补进历史（目标问题本身）', () => {
  it('有草稿未清 → 模拟重启扫描 → 对话 jsonl 多一条 interrupted=crashed 的半截（含文字+悬空工具），草稿删除', async () => {
    const m1 = await bootModules();
    const w = m1.makeInflightWriter({ agentId: 'agtC', convId: 'cnvCrash', messageId: 'msgCrash', meta });
    const partial: PartialTurn = {
      resultText: '正在装依赖',
      toolCalls: [{ id: 'tc1', name: 'bash', input: { cmd: 'npm i' }, status: 'running', startedAt: 1 }],
    };
    w.write(partial);
    await w.stop();

    // 崩溃重启：草稿仍在，进程内存清零
    const m2 = await bootModules();
    await m2.scanTurnInflightOnBoot();

    const history = await m2.readHistory('agtC', 'cnvCrash');
    const recovered = history.find((h) => h.id === 'msgCrash');
    expect(recovered).toBeDefined();
    expect(recovered!.interrupted).toBe('crashed');
    expect(recovered!.text).toBe('正在装依赖');
    expect(recovered!.toolCalls).toHaveLength(1);
    expect(recovered!.toolCalls[0].result).toBeUndefined(); // 悬空调用如实保留无 result
    expect(existsSync(inflightFilePath('agtC', 'cnvCrash'))).toBe(false); // 草稿补完即删
  });

  it('空草稿（partial 全空但文件存在）不补壳，只删草稿', async () => {
    const m1 = await bootModules();
    // 直接造一份空 partial 草稿（绕过 writer 的空判，模拟极端残留）
    await fs.mkdir(join(ORU_DIR, 'users', 'local-user', 'conversations', 'agtE'), { recursive: true });
    await fs.writeFile(
      inflightFilePath('agtE', 'cnvEmptyDraft'),
      JSON.stringify({ version: 1, messageId: 'mE', partial: { resultText: '', toolCalls: [] }, meta, startedAt: 1 }),
    );
    const m2 = await bootModules();
    await m2.scanTurnInflightOnBoot();
    const history = await m2.readHistory('agtE', 'cnvEmptyDraft');
    expect(history.find((h) => h.id === 'mE')).toBeUndefined(); // 空壳不补
    expect(existsSync(inflightFilePath('agtE', 'cnvEmptyDraft'))).toBe(false);
  });
});

describe('幂等：崩在「正式落盘后、清草稿前」不重复补', () => {
  it('该 messageId 已在历史里 → 扫描不重复 append，只删草稿', async () => {
    const m1 = await bootModules();
    // 先把「正式落盘」的完整消息写进历史
    await m1.appendMessage('agtD', 'cnvDup', {
      id: 'msgDup',
      conversationId: 'cnvDup',
      role: 'assistant',
      text: '完整回答',
      toolCalls: [],
      createdAt: 1,
      done: true,
    });
    // 又残留一份同 messageId 的草稿（崩在清草稿前）
    await fs.writeFile(
      inflightFilePath('agtD', 'cnvDup'),
      JSON.stringify({ version: 1, messageId: 'msgDup', partial: { resultText: '半截', toolCalls: [] }, meta, startedAt: 1 }),
    );

    const m2 = await bootModules();
    await m2.scanTurnInflightOnBoot();

    const history = await m2.readHistory('agtD', 'cnvDup');
    expect(history.filter((h) => h.id === 'msgDup')).toHaveLength(1); // 不重复
    expect(history.find((h) => h.id === 'msgDup')!.text).toBe('完整回答'); // 保留正式版、不被半截覆盖
    expect(existsSync(inflightFilePath('agtD', 'cnvDup'))).toBe(false);
  });
});

describe('对话删除：草稿随对话销毁（与 steering 盘记对称，不留孤儿/不补进已删对话）', () => {
  it('deleteConversation 连带删 turn-inflight 草稿', async () => {
    const m = await bootModules();
    const conv = await m.createConversation({ agentId: 'agtDel', title: '将删', kind: 'sub' });
    const w = m.makeInflightWriter({ agentId: 'agtDel', convId: conv.id, messageId: 'mDel', meta });
    w.write({ resultText: '半截', toolCalls: [] });
    await w.stop();
    expect(existsSync(inflightFilePath('agtDel', conv.id))).toBe(true);

    await m.deleteConversation('agtDel', conv.id);
    expect(existsSync(inflightFilePath('agtDel', conv.id))).toBe(false);
  });
});

describe('清除：正式落盘后清草稿，重启不再补', () => {
  it('clearTurnInflight 后草稿消失，重启扫描补不出东西', async () => {
    const m1 = await bootModules();
    const w = m1.makeInflightWriter({ agentId: 'agtF', convId: 'cnvClear', messageId: 'msgClr', meta });
    w.write({ resultText: '产出中', toolCalls: [] });
    await w.stop();
    expect(existsSync(inflightFilePath('agtF', 'cnvClear'))).toBe(true);

    await m1.clearTurnInflight('agtF', 'cnvClear');
    expect(existsSync(inflightFilePath('agtF', 'cnvClear'))).toBe(false);

    const m2 = await bootModules();
    await m2.scanTurnInflightOnBoot();
    expect((await m2.readHistory('agtF', 'cnvClear')).find((h) => h.id === 'msgClr')).toBeUndefined();
  });
});
