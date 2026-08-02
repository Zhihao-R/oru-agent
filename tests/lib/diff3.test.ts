/**
 * diff3 三方合并纯函数（块②核心，tech §3.2/§7/§8）。
 *
 * 契约：以 base 为共同出发版，分别比对 mine / theirs 的行级改动再归并——
 *  - 不同段各改 → 自动合并、无冲突；
 *  - 同段都改且不同 → 冲突块；merged 在冲突处保留 mine 版（PRD「未做选择前文件保持你的版本」），
 *    conflict.range 标该冲突段在 merged 中的字符区间（供编辑器挂对照卡），三版文本各自带上；
 *  - 同段都改且改成一样 → 不算冲突（取其一）。
 * AI 全量重写 vs 局部 edit 只要 theirs 最终内容相同，合并结果一致（合并只认最终内容 vs base）。
 */
import { describe, expect, it } from 'vitest';
import { diff3 } from '../../shared/diff3';

describe('diff3 三方合并', () => {
  it('两边无改动 → merged 即 base，无冲突', () => {
    const r = diff3('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nc\n');
    expect(r.merged).toBe('a\nb\nc\n');
    expect(r.conflicts).toHaveLength(0);
  });

  it('只有 mine 改 → 取 mine，无冲突', () => {
    const r = diff3('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n');
    expect(r.merged).toBe('a\nB\nc\n');
    expect(r.conflicts).toHaveLength(0);
  });

  it('只有 theirs 改 → 取 theirs，无冲突', () => {
    const r = diff3('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nC\n');
    expect(r.merged).toBe('a\nb\nC\n');
    expect(r.conflicts).toHaveLength(0);
  });

  it('不同段各改 → 两边改动都保留、自动合并、无冲突', () => {
    const r = diff3('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n');
    expect(r.merged).toBe('A\nb\nc\nd\nE\n');
    expect(r.conflicts).toHaveLength(0);
  });

  it('同段都改且不同 → 冲突；merged 保留 mine 版，range 命中冲突段', () => {
    const r = diff3('a\nb\nc\n', 'a\nMINE\nc\n', 'a\nTHEIRS\nc\n');
    expect(r.conflicts).toHaveLength(1);
    const cf = r.conflicts[0];
    expect(cf.mineText).toBe('MINE\n');
    expect(cf.theirsText).toBe('THEIRS\n');
    expect(cf.baseText).toBe('b\n');
    // merged 在冲突处保留 mine 版
    expect(r.merged).toBe('a\nMINE\nc\n');
    // range 命中 merged 中的 mine 版冲突段
    expect(r.merged.slice(cf.range.from, cf.range.to)).toBe('MINE\n');
  });

  it('同段都改成相同内容 → 不算冲突（取其一）', () => {
    const r = diff3('a\nb\nc\n', 'a\nSAME\nc\n', 'a\nSAME\nc\n');
    expect(r.conflicts).toHaveLength(0);
    expect(r.merged).toBe('a\nSAME\nc\n');
  });

  it('AI 全量重写 vs 局部改：theirs 最终内容相同 → 合并结果一致', () => {
    const base = 'a\nb\nc\n';
    const mine = 'a\nMINE\nc\n';
    const theirsFinal = 'a\nb\nC\n'; // 不论 theirs 是全量给出还是只改末行，最终态相同
    const r = diff3(base, mine, theirsFinal);
    expect(r.merged).toBe('a\nMINE\nC\n');
    expect(r.conflicts).toHaveLength(0);
  });

  it('行增删致偏移：mine 在前面插入行、theirs 改后面的行 → 都保留、落点正确', () => {
    const base = 'a\nb\nc\n';
    const mine = 'NEW\na\nb\nc\n'; // 开头插一行
    const theirs = 'a\nb\nC\n'; // 改末行
    const r = diff3(base, mine, theirs);
    expect(r.merged).toBe('NEW\na\nb\nC\n');
    expect(r.conflicts).toHaveLength(0);
  });

  it('多处冲突 → 各自成块，range 互不重叠且命中各自 mine 段', () => {
    const base = 'a\nb\nc\nd\ne\n';
    const mine = 'a\nB1\nc\nD1\ne\n';
    const theirs = 'a\nB2\nc\nD2\ne\n';
    const r = diff3(base, mine, theirs);
    expect(r.conflicts).toHaveLength(2);
    for (const cf of r.conflicts) {
      expect(r.merged.slice(cf.range.from, cf.range.to)).toBe(cf.mineText);
    }
    expect(r.conflicts[0].range.to).toBeLessThanOrEqual(r.conflicts[1].range.from);
    expect(r.merged).toBe('a\nB1\nc\nD1\ne\n');
  });

  it('mine 删一行、theirs 不动 → 删除保留', () => {
    const r = diff3('a\nb\nc\n', 'a\nc\n', 'a\nb\nc\n');
    expect(r.merged).toBe('a\nc\n');
    expect(r.conflicts).toHaveLength(0);
  });

  it('两边删同一行 → 不冲突（都同意删）', () => {
    const r = diff3('a\nb\nc\n', 'a\nc\n', 'a\nc\n');
    expect(r.merged).toBe('a\nc\n');
    expect(r.conflicts).toHaveLength(0);
  });

  it('空 base、两边各自新增不同内容 → 视改动区段；同点新增不同 → 冲突或都留，merged 非空', () => {
    const r = diff3('', 'X\n', 'Y\n');
    // 同一空 base 上两边都加了不同内容——要么冲突（range 命中）、要么都留，但绝不丢内容
    const all = r.merged + r.conflicts.map((c) => c.theirsText).join('');
    expect(all).toContain('X');
    expect(all).toContain('Y');
  });

  it('末行无换行符：不同段各改也能合并、不吞字符', () => {
    const r = diff3('a\nb\nc', 'A\nb\nc', 'a\nb\nC');
    expect(r.merged).toBe('A\nb\nC');
    expect(r.conflicts).toHaveLength(0);
  });

  it('mine 在中间插入多行、theirs 改另一处 → 都保留', () => {
    const r = diff3('a\nb\nc\n', 'a\nX\nY\nb\nc\n', 'a\nb\nC\n');
    expect(r.merged).toBe('a\nX\nY\nb\nC\n');
    expect(r.conflicts).toHaveLength(0);
  });
});
