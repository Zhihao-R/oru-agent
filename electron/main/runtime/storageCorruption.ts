/**
 * 存储损坏隔离与留痕（data-durability §Deg「按件隔离 · 能读多少恢复多少 · 如实告知」）。
 *
 * 两件事、一处收口，供各持久化 store 读盘遇损坏时共用（对话索引 / config / 文件历史 manifest …）：
 *  - 隔离（quarantineCorrupt）：把损坏的存储移出正常读取路径、原样保留供修复，杜绝「损坏→当空读→
 *    下次写盘物理覆盖」这条不可逆丢数据链——推广 identity/profile.ts 的「corrupt 不覆盖」范式。
 *  - 留痕（noteCorruption）：损坏 / 隔离 / 半截行等事件绝不静默吞。console.warn 留诊断痕，同时升起
 *    一条系统信号（S14 · G127）——用户可感知的「如实告知」由通知中心的系统信号段承接，「假装完整比
 *    承认残缺更有害」。此函数是该通道的唯一接入点：任何 store 读盘遇损坏经它，改这里即全站生效。
 */
import { promises as fs } from 'node:fs';
import { raiseSystemSignal } from '../notifications/systemSignals';

/** 损坏事件留痕（不静默）+ 升系统信号如实告知。where=损坏位置（如 'conversations/index'），detail=可诊断细节。 */
export function noteCorruption(where: string, detail: string): void {
  console.warn(`[storage:corruption] ${where}: ${detail}`);
  // 同 where 复发只更新不新增（去重键）；损坏是数据完整性问题 → critical
  raiseSystemSignal({
    id: `storage-corruption:${where}`,
    kind: 'storage-corruption',
    severity: 'critical',
    params: { where },
    detail,
  });
}

/**
 * 隔离一处损坏的文件 / 目录：改名到 `<path>.corrupt-<ts>` sidecar，原字节原样保留供人工恢复，
 * 而非留在原处被下一次写盘覆盖。best-effort——隔离本身失败（已不在 / 无权限）只留痕不抛：隔离是
 * 止损补救，绝不该把「读到损坏」升级成「进程崩溃」（无权限时同一目录的写盘同样会失败，不会静默覆盖）。
 * 返回 sidecar 路径，或 null（未隔离）。
 */
export async function quarantineCorrupt(path: string, where: string): Promise<string | null> {
  const sidecar = `${path}.corrupt-${Date.now()}`;
  try {
    await fs.rename(path, sidecar);
    noteCorruption(where, `已隔离损坏存储 ${path} → ${sidecar}（原字节保留，可人工恢复）`);
    return sidecar;
  } catch (e) {
    // 源已不在（并发路径已抢先隔离 / 文件被移走）——不是隔离失败，别误报「仍在原处」
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    noteCorruption(where, `隔离失败 ${path}（${String(e)}）——损坏文件仍在原处待人工处理`);
    return null;
  }
}
