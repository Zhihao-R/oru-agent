/**
 * 测试 ORU_DIR 全局兜底：worker 里 ORU_DIR 未显式注入时指到一次性 tmpdir——保证任何测试
 * 都不可能默认读写真实 ~/.oru（2026-07-10 backup 测试污染真实数据事故的防线，与
 * electron/main/runtime/paths.ts 的 VITEST 硬护栏成对）。
 * 要断言落盘内容的测试仍应自行注入独立目录；mock electron 的文件必须用 vi.hoisted 同相位
 * 注入（否则 paths.ts 在 vi.mock 提升时提前求值，捕获的是这里的兜底目录而非测试自己的）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORU_DIR ??= mkdtempSync(join(tmpdir(), 'oru-vitest-'));
