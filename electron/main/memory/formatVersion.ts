/**
 * 记忆库格式版本哨（理想架构 S06 · G128）——data-durability「每类格式自带版本号」。
 *
 * 记忆库是目录树（md 文件 + 索引），无单一 JSON 可挂 version 字段，版本落在
 * `memory/format.json` 哨文件，语义是「本程序按哪一代结构读写记忆库」。当前 v2 结构
 * （agents/ + user/ + projects/ + trash/，见 paths.ts 头注释）。它是备份还原「按版本
 * 迁移」（G125，S07 消费）与未来结构演进的判读依据——没有它，程序无从知道手里这棵树
 * 该按哪个时代的格式读。
 *
 * 铁律：高版本原样保留、绝不写回降级（旧程序读到新库只能如实认账）；哨文件损坏则隔离
 * 留痕后按当前版本重建——版本信息由程序自身可再生，与「身份数据损坏必须保字节」不同类。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { safeWriteAsync } from '../fs/safeWrite';
import { quarantineCorrupt } from '../runtime/storageCorruption';
import { memoryRoot } from './paths';

/** 与 paths.ts 注释的「v2 结构」同代——目录结构再演进时 +1 并配迁移。 */
export const MEMORY_FORMAT_VERSION = 2;

export function memoryFormatVersionPath(ownerId: string): string {
  return join(memoryRoot(ownerId), 'format.json');
}

/**
 * 建立 / 校验记忆库版本哨，返回盘上生效的版本号。
 * 不存在 → 写 {version: 当前}；同版本 → 幂等不动；高版本 → 原样保留 + warn（S07 还原
 * 路径会消费这个返回值决定拒绝还是迁移）；损坏 → 隔离 sidecar 后按当前版本重建。
 */
export async function ensureMemoryFormatVersion(ownerId: string): Promise<number> {
  const path = memoryFormatVersionPath(ownerId);
  if (existsSync(path)) {
    let content: string | null;
    try {
      content = await fs.readFile(path, 'utf-8');
    } catch {
      // IO 错误（权限/读抖动，非内容损坏）：不动盘、按当前版本应答——隔离或重写都可能
      // 把一个健康的高版本哨文件降级，下次启动读成功即恢复。
      console.warn(`[memory] format.json 读取失败（IO），本次按当前版本 ${MEMORY_FORMAT_VERSION} 继续、不改写`);
      return MEMORY_FORMAT_VERSION;
    }
    try {
      const raw = JSON.parse(content) as { version?: unknown };
      const v = raw?.version;
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1) {
        if (v > MEMORY_FORMAT_VERSION) {
          console.warn(`[memory] 记忆库格式版本 ${v} 高于本程序支持的 ${MEMORY_FORMAT_VERSION}——原样保留，不写回降级`);
        }
        return v;
      }
      // version 字段非法——落到下方隔离重建
      throw new Error(`format.json version 非法: ${JSON.stringify(v)}`);
    } catch {
      await quarantineCorrupt(path, 'memory/formatVersion');
    }
  }
  await safeWriteAsync(path, JSON.stringify({ version: MEMORY_FORMAT_VERSION })); // 内含 mkdir
  return MEMORY_FORMAT_VERSION;
}
