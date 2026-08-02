/**
 * deck `.history/versions/vNNN.html` → fileHistory 中央仓的一次性迁移（项目B 第一期，生死线-2）。
 *
 * 触发于 deck 首次在新代码下打开（router artifact.activate）。把存量旧版字节灌进中央仓、给 manifest
 * 每条版本补 snapshotId——currentVersion / 版本 id（vNNN）/ summary / changedPages 全不变（指针语义层保留）。
 *
 * 承重纪律（前置阻塞#5 / §5）：
 * - 整段进 runExclusive(deckKey)，与 commit/checkout/applyTextEdit 串行；迁移期 unregisterSampling，
 *   不被周期取样插入交错（deck 锁 key 已归一 resolve，见 deckLockKey）。
 * - 幂等 + sentinel 原子：sentinel 不在就一律走旧存储；中央仓全写完才落 sentinel；重试前清半套残留。
 * - 失败兜底：任一步抛 → 不写 sentinel、不动旧 vNNN.html → 读路径据 snapshotId 缺失退回 legacy，
 *   下次打开重试。per-deck 回滚（rollbackDeck）恢复 .bak、删 sentinel、走 legacy。
 *
 * 这是 PRD §六-4「烤熟后摘除」的脚手架：旧 .history/versions 冻结只读作回滚基线，三期稳定 +
 * 不丢闸门过后连同本模块一并删除，不留双轨。
 */
import { promises as fs } from 'node:fs';
import type { HistoryManifest } from '@shared/types';
import {
  deckLockKey,
  deckVersionFile,
  deckMigratedSentinelPath,
  deckManifestBakPath,
  deckRollbackFlagPath,
} from './pathResolver';
import { resolveDeckPath } from './store';
import { readManifestByPath, writeManifestByPath } from './history';
import { safeWriteAsync } from '../fs/safeWrite';
import { runExclusive } from '../fs/runExclusive';
import { unregisterSampling } from '../fs/historySampler';
import * as fileHistory from '../fs/fileHistory';

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 迁移一个 deck（若需要）。已迁移（sentinel 在）/ 已回滚（rollback 标记在）→ no-op。
 * 失败上抛由 caller 吞（deck 自动退回 legacy 读路径）。
 */
export async function migrateDeckIfNeeded(artifactId: string): Promise<void> {
  const deckPath = await resolveDeckPath(artifactId);
  const deckKey = deckLockKey(deckPath);
  // 锁外快速短路（已迁移/已回滚不进锁）
  if (await fileExists(deckRollbackFlagPath(deckPath))) return;
  if (await fileExists(deckMigratedSentinelPath(deckPath))) return;

  await runExclusive(deckKey, async () => {
    // await 后重检：并发可能已迁完（CLAUDE.md「await 后重检共享状态」）
    if (await fileExists(deckRollbackFlagPath(deckPath))) return;
    if (await fileExists(deckMigratedSentinelPath(deckPath))) return;
    unregisterSampling(deckKey); // 迁移期不被周期取样交错

    const manifest = await readManifestByPath(deckPath);
    if (!manifest) {
      // 无历史的 deck（从未 commit 过）——空迁移，直接落 sentinel（之后走新路径）
      await writeSentinel(deckPath);
      return;
    }

    // 已是新路径的判别：全版本带 snapshotId ⇒ 中央仓已灌满（manifest 在灌入完成后才原子写回，
    // 中途崩溃只会留下全旧 manifest 走 legacy 路径，两条路都收敛）。新代码建的 deck（initManifest
    // 直接进中央仓、从不落 sentinel）在这里一次 activate 落 sentinel 永不再进 migration——
    // 缺了它，下面的「幂等清残」会误删 v001 中央仓字节、此后提交静默抛错，版本历史停摆
    //（走查二批该修 14，2026-08-01）。
    if (manifest.versions.every((v) => v.snapshotId)) {
      await writeSentinel(deckPath);
      return;
    }

    // 真 legacy：先把所有版本文件读入内存——读失败（真损坏）在此抛出时中央仓尚未被 clear，
    // 不会「先删数据再发现读不出来」。错误带缺失 versionId 便于定位。
    const legacyContents: string[] = [];
    for (const v of manifest.versions) {
      try {
        legacyContents.push(await fs.readFile(deckVersionFile(deckPath, v.id), 'utf-8'));
      } catch (err) {
        throw new Error(
          `deck migration: legacy 版本文件缺失/不可读 ${v.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 幂等清残：上次迁一半崩（无 sentinel）会在中央仓留半套——重试前清掉，杜绝重复堆叠（前置阻塞#5）
    if ((await fileHistory.list(deckKey)).length > 0) await fileHistory.clear(deckKey);

    // 备份迁移前 manifest 作回滚基线（只读）
    await safeWriteAsync(deckManifestBakPath(deckPath), JSON.stringify(manifest, null, 2));

    // **先设 retainAll** 再逐版灌入——否则灌入时 GC 以 retainAll=undefined 跑封顶淘汰，>cap 个版本的
    // deck 会被删掉旧版字节、snapshotId 悬空，击穿生死线-2（承重，reviewer 收敛结论）。
    await fileHistory.setRetention(deckKey, { retainAll: true });
    // 逐版按时间序灌进中央仓，给版本条目补 snapshotId（commitSnapshot 去重：相邻同内容共享一版）
    for (const [i, v] of manifest.versions.entries()) {
      const ref = await fileHistory.commitSnapshot(deckKey, v.kind, legacyContents[i]!);
      v.snapshotId = ref.id;
    }
    await writeManifestByPath(deckPath, manifest); // 原地升级（versions 加了 snapshotId）

    // 全部写完（含上面的原子写）才落 sentinel——读路径只认 sentinel，半态一律走 legacy
    await writeSentinel(deckPath);
  });
  // 注：deck retainAll=true → 任何版本都不自动淘汰，currentVersion/提交组 before/after 天然不丢
  //（生死线-3 trivially 成立，无需单独 pin 机制——见 reviewer 收敛结论）。
}

/**
 * per-deck 回滚（应急脚手架，§六-4）：恢复 .bak（丢弃 post-migration 版本，§六-2 不双写的必然），
 * 删 sentinel、标 rollback flag、清中央仓该 deck 残留 → 该 deck 回到 legacy 读写老路径，旧数据都在。
 */
export async function rollbackDeck(artifactId: string): Promise<void> {
  const deckPath = await resolveDeckPath(artifactId);
  const deckKey = deckLockKey(deckPath);
  await runExclusive(deckKey, async () => {
    const bakPath = deckManifestBakPath(deckPath);
    if (await fileExists(bakPath)) {
      const bak = JSON.parse(await fs.readFile(bakPath, 'utf-8')) as HistoryManifest;
      await writeManifestByPath(deckPath, bak); // 恢复迁移前 manifest（版本无 snapshotId → 读退回 legacy）
    }
    await fs.rm(deckMigratedSentinelPath(deckPath), { force: true });
    await fileHistory.clear(deckKey); // 清中央仓残留（回滚后不再用，避免 GC/pin 误留）
    await safeWriteAsync(deckRollbackFlagPath(deckPath), '1'); // 防再次自动迁移
  });
}

async function writeSentinel(deckPath: string): Promise<void> {
  await safeWriteAsync(
    deckMigratedSentinelPath(deckPath),
    JSON.stringify({ schemaVersion: 1, migratedAt: Date.now() }),
  );
}
