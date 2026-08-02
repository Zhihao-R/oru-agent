/**
 * debug logger 关闭态 smoke
 *
 * 验证：
 * 1. setEnabled(false) 时 beginRound 返回的是 NoOp（所有方法是 no-op）
 * 2. 关闭态下调用 RoundLogger 全部方法不抛错
 * 3. **关闭态下 debug 目录不被创建**——任何 fs 写都不该发生
 * 4. setEnabled(true) 后跑一轮才会落盘
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';

import { debugLogger } from '../../electron/main/debug/logger';
import { debugDir } from '../../electron/main/runtime/paths';
import type { ConversationEvent } from '@shared/agent/backend';

const OWNER = 'local-user';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

console.log('=== debug_disabled smoke ===');

(async () => {
  // ─── 前置：保证默认 disabled ──────────────────────────
  debugLogger.setEnabled(false);
  assert(debugLogger.isEnabled() === false, '默认状态：disabled');

  // ─── case 1: 关闭态 beginRound 返回 NoOp ───────────────
  const round = debugLogger.beginRound({
    roundId: 'r1',
    conversationId: 'c1',
    ownerId: OWNER,
    agentId: 'a1',
    agentName: '测试分身',
    source: 'main_chat',
    userText: 'hi',
  });
  // 调所有方法不抛
  round.promptBuilt({
    durationMs: 1,
    systemContextChars: 0,
    stableSystemContextChars: 0,
    systemContext: '',
  });
  const deriver = round.makeStreamDeriver({
    backendType: 'anthropic',
  });
  assert(deriver === null, '关闭态：makeStreamDeriver 返回 null（NoOp）');
  round.done({ hadError: false });
  round.error({ message: 'should not throw', phase: 'unknown' });

  // ─── case 2: 关闭态绝不创建 debug 目录 ─────────────────
  // 给可能的异步写一点时间
  await new Promise((r) => setTimeout(r, 50));
  const dir = debugDir(OWNER);
  assert(!existsSync(dir), '关闭态：debug 目录未创建', `dir=${dir}`);

  // ─── case 3: setEnabled(true) 后真正落盘 ───────────────
  debugLogger.setEnabled(true);
  assert(debugLogger.isEnabled() === true, '开启后：enabled');

  const realRound = debugLogger.beginRound({
    roundId: 'r2',
    conversationId: 'c2',
    ownerId: OWNER,
    agentId: 'a1',
    agentName: '测试分身',
    source: 'main_chat',
    userText: 'hello',
  });
  const d = realRound.makeStreamDeriver({ backendType: 'anthropic' });
  assert(d !== null, '开启后：makeStreamDeriver 返回真实 deriver');
  // 喂一个最简单 result 让 deriver 走完
  d?.feed({ type: 'result', resultText: 'ok', isError: false } as ConversationEvent);
  realRound.done({ hadError: false });

  // 真等 writer drain 完落盘——不靠 setTimeout 猜时间
  await debugLogger.flushForTest();

  const filesAfter = await fs.readdir(dir).catch(() => [] as string[]);
  assert(filesAfter.length > 0, '开启后：debug 目录存在 + 含日期子目录');

  // ─── case 4: 再次 setEnabled(false) → setEnabled(false) 幂等 ─────
  debugLogger.setEnabled(false);
  debugLogger.setEnabled(false);
  assert(true, '重复 setEnabled(false) 不抛错');

  // ─── 汇总 ──────────────────────────────────────────
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
