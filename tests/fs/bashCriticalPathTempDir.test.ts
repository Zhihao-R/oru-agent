/**
 * PT-005 回归：bash 审批告警不把用户临时目录误标为"关键系统路径，极高风险"。
 *
 * `/var` 在 macOS 是混合区——`/var/folders`（$TMPDIR）、`/var/tmp` 是用户可写临时区，
 * 修复前会被 `/var` 前缀误判进"极高风险系统路径"。修复加 SAFE_TEMP_PREFIXES 短路豁免。
 * 注意：只放宽告警**文案**——rm -rf 等命令本身仍判破坏（门控不变）；`/var/db` 等真系统子树仍标。
 */
import { describe, it, expect } from 'vitest';
import { analyzeBashCommand } from '../../electron/main/fs/bashCommand';

const CWD = '/Users/me/proj';
const reasons = (cmd: string): string =>
  analyzeBashCommand(cmd, CWD).segments.map((s) => s.reason ?? '').join(' | ');

describe('PT-005 · 临时目录不误标关键系统路径', () => {
  it('rm 命中 /var/folders（$TMPDIR）仍判破坏，但不标"命中关键系统路径"', () => {
    const a = analyzeBashCommand('rm -rf /var/folders/ab/cd/T/x', CWD);
    expect(a.isDestructive).toBe(true); // rm -rf 恒破坏，门控不变
    expect(reasons('rm -rf /var/folders/ab/cd/T/x')).not.toContain('命中关键系统路径');
  });

  it('/var/tmp、/tmp、/private/var/folders 等临时区同样豁免告警', () => {
    for (const p of ['/var/tmp/x', '/tmp/x', '/private/tmp/y', '/private/var/folders/a/b']) {
      expect(reasons(`rm -rf ${p}`), p).not.toContain('命中关键系统路径');
    }
  });

  it('真系统路径仍标"命中关键系统路径，极高风险"（含 /var 的系统子树 /var/db）', () => {
    expect(reasons('rm -rf /etc/foo')).toContain('命中关键系统路径');
    expect(reasons('rm -rf /usr/bin/x')).toContain('命中关键系统路径');
    expect(reasons('rm -rf /var/db/x')).toContain('命中关键系统路径');
  });
});
