import { describe, it, expect } from 'vitest';
import { resolveOruName, ORU_SPECIES_NAME } from '@/lib/oruName';

/** 称呼收敛单一源：个体名优先，空/纯空白/未设回落物种名 Oru（见 PRD 三层命名体系）。 */
describe('resolveOruName', () => {
  it('有个体名用个体名', () => {
    expect(resolveOruName('阿果')).toBe('阿果');
    expect(resolveOruName('Ada')).toBe('Ada');
  });

  it('空 / 纯空白 / undefined / null 回落物种名 Oru', () => {
    expect(resolveOruName('')).toBe('Oru');
    expect(resolveOruName('   ')).toBe('Oru');
    expect(resolveOruName(undefined)).toBe('Oru');
    expect(resolveOruName(null)).toBe('Oru');
    expect(ORU_SPECIES_NAME).toBe('Oru');
  });

  it('个体名两侧空白被 trim', () => {
    expect(resolveOruName('  阿果  ')).toBe('阿果');
  });
});
