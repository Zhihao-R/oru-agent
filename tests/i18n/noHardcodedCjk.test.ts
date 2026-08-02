// @vitest-environment node

/**
 * 硬编码中文守卫——抓"该走 i18n 却没走"的裸中文（key-alignment 门槛抓不到这类：它只管已抽键
 * 的 en 覆盖）。扫 src/** + shared/**，剥注释/console 诊断/显式 i18n-exempt 后剩余 CJK 即违规。
 *
 * baseline 棘轮：现存的合法/历史中文（数据哨兵、枚举值、写盘文件名、诊断、wire 前缀等）记在
 * cjk-baseline.json，门槛只 fail「基线外的新增」——开发新功能 / 合并别的分支引入的裸中文当场红。
 * 收紧办法：把基线项逐一 i18n 化或加 `i18n-exempt` 注释后，跑
 *   `node scripts/i18n/scanHardcodedCjk.mjs --write-baseline` 刷新（棘轮只减不增）。
 * 全量清单（合并适配用）：`node scripts/i18n/scanHardcodedCjk.mjs`。
 */
import { describe, it, expect } from 'vitest';
import { flatKeys } from '../../scripts/i18n/scanHardcodedCjk.mjs';
import baseline from './cjk-baseline.json';

const SEP = String.fromCharCode(1); // flatKeys 用  连 file 与 text

describe('硬编码中文守卫（src/ + shared/）', () => {
  it('不得新增基线外的硬编码中文（要么 t() 化、要么加 i18n-exempt 注释说明缘由）', () => {
    const allowed = new Set(baseline as string[]);
    const violations = flatKeys()
      .filter((k) => !allowed.has(k))
      .map((k) => k.split(SEP).join('  →  ')); // 仅失败时的可读输出
    expect(violations).toEqual([]);
  });
});
