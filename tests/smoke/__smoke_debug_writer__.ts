/**
 * debug writer smoke
 *
 * 验证：
 * 1. enqueue 1000 条 records（混合 5 个 conversationId、跨同一 dateKey）→ flushAndClose
 *    后所有 records 完整落盘、每行可解析、seq 单调
 * 2. closed 后再 enqueue 直接被丢弃（不抛错、不落盘）
 * 3. 末行残缺：手动往文件末尾 append 半行 JSON → 简单 try/catch 跳过坏行后剩余 records 完整
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';

import { DebugWriter } from '../../electron/main/debug/writer';
import { debugConvFile } from '../../electron/main/runtime/paths';
import type { DebugRecord } from '@shared/debug/types';

const OWNER = 'local-user';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fakeRound(roundId: string, conversationId: string, seq: number, ts: number): DebugRecord {
  return {
    ts,
    relMs: 0,
    roundId,
    conversationId,
    ownerId: OWNER,
    agentId: 'agent-test',
    agentName: '测试分身',
    type: 'round_done',
    seq,
    payload: {
      totalDurationMs: 100,
      llmCallCount: 1,
      toolCallCount: 0,
      hadError: false,
    },
  };
}

console.log('=== debug_writer smoke ===');

(async () => {
  // ─── case 1: 1000 条混合 conversation ───────────────────
  const writer = new DebugWriter();
  const NOW = Date.now();
  const CONVS = ['c1', 'c2', 'c3', 'c4', 'c5'];

  for (let i = 0; i < 1000; i++) {
    const conv = CONVS[i % CONVS.length];
    writer.enqueue(fakeRound(`r-${i}`, conv, i, NOW));
  }
  await writer.flushAndClose();

  let totalLines = 0;
  for (const conv of CONVS) {
    const file = debugConvFile(OWNER, dateKey(NOW), conv);
    const text = await fs.readFile(file, 'utf-8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    totalLines += lines.length;
    let prevSeq = -1;
    let parseFail = 0;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as DebugRecord;
        if (rec.seq <= prevSeq) {
          assert(false, `${conv} seq 单调`, `prev=${prevSeq} cur=${rec.seq}`);
          break;
        }
        prevSeq = rec.seq;
      } catch {
        parseFail++;
      }
    }
    assert(parseFail === 0, `${conv} 全部行可解析`, `坏行数 ${parseFail}`);
  }
  assert(totalLines === 1000, '总落盘行数 = 1000', `actual=${totalLines}`);

  // ─── case 2: closed 后 enqueue 被丢弃 ──────────────────
  writer.enqueue(fakeRound('r-after-close', 'c1', 9999, NOW));
  // 给一点时间——理论上 closed 标志为 true 直接 return，不会写
  await new Promise((r) => setTimeout(r, 50));
  const c1file = debugConvFile(OWNER, dateKey(NOW), 'c1');
  const text2 = await fs.readFile(c1file, 'utf-8');
  const lines2 = text2.split('\n').filter((l) => l.length > 0);
  assert(lines2.length === 200, 'closed 后 enqueue 被丢弃', `c1 行数=${lines2.length} (应为 200)`);

  // ─── case 3: 末行残缺，简单 try/catch 跳过 ──────────────
  await fs.appendFile(c1file, '{"ts":12345,"this is a broken'); // 不带 \n 的半行
  const text3 = await fs.readFile(c1file, 'utf-8');
  const lines3 = text3.split('\n').filter((l) => l.length > 0);
  let okCount = 0;
  let badCount = 0;
  for (const line of lines3) {
    try {
      JSON.parse(line);
      okCount++;
    } catch {
      badCount++;
    }
  }
  assert(badCount === 1, '末行残缺：1 条坏行', `bad=${badCount}`);
  assert(okCount === 200, '坏行前 200 条仍可解析', `ok=${okCount}`);

  // ─── case 4: 重复调用 flushAndClose 幂等 ─────────────
  await writer.flushAndClose();
  await writer.flushAndClose();
  assert(true, '重复 flushAndClose 不抛错');

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
