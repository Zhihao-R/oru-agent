/**
 * WebSocket origin 白名单回归 smoke。
 *
 * 验证：
 * - 无 origin 连接 → 拒（403）
 * - 'https://evil.com' → 拒
 * - 'null' → 拒（攻击页常用）
 * - 'file://' → 允（Electron renderer 来源）
 * - 'http://localhost:5173' → 允（dev vite）
 */
import './__smoke_isolate__';
import WebSocket from 'ws';
import { startWsServer, stopWsServer } from '../../electron/main/ws/server';

const RESULTS: { name: string; ok: boolean }[] = [];
function assert(name: string, ok: boolean) {
  RESULTS.push({ name, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
}

function tryConnect(url: string, opts?: { origin?: string }): Promise<'open' | 'reject'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    const cleanup = () => {
      try { ws.close(); } catch { /* noop */ }
    };
    ws.once('open', () => { cleanup(); resolve('open'); });
    ws.once('error', () => { cleanup(); resolve('reject'); });
    ws.once('unexpected-response', () => { cleanup(); resolve('reject'); });
  });
}

async function main() {
  const port = await startWsServer();
  const url = `ws://127.0.0.1:${port}`;

  assert('无 origin → 拒', (await tryConnect(url)) === 'reject');
  assert('evil.com → 拒', (await tryConnect(url, { origin: 'https://evil.com' })) === 'reject');
  assert('null → 拒', (await tryConnect(url, { origin: 'null' })) === 'reject');
  // 关键 regression：非浏览器客户端可任意设置 Origin，必须挡住伪 file:// host
  assert(
    'file://attacker.evil 伪 host → 拒',
    (await tryConnect(url, { origin: 'file://attacker.evil' })) === 'reject',
  );
  assert('file:// → 允', (await tryConnect(url, { origin: 'file://' })) === 'open');
  assert(
    'file:///path → 允（三斜杠路径形态）',
    (await tryConnect(url, { origin: 'file:///Users/foo/index.html' })) === 'open',
  );
  assert('localhost:5173 → 允', (await tryConnect(url, { origin: 'http://localhost:5173' })) === 'open');

  await stopWsServer();

  const passed = RESULTS.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${RESULTS.length} PASSED ===`);
  process.exit(passed === RESULTS.length ? 0 : 1);
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
