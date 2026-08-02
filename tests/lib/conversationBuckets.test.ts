import { describe, expect, it } from 'vitest';
import { bucketOf } from '@/lib/conversationBuckets';

// 锚定 now = 2026-06-17（周三）15:00 本地；本周周首 = 2026-06-15（周一）00:00
const NOW = new Date(2026, 5, 17, 15, 0, 0).getTime();

describe('bucketOf', () => {
  it('同一自然日 → today（含当日 00:00 边界）', () => {
    expect(bucketOf(new Date(2026, 5, 17, 9, 0, 0).getTime(), NOW)).toBe('today');
    expect(bucketOf(new Date(2026, 5, 17, 0, 0, 0).getTime(), NOW)).toBe('today');
  });

  it('本周内但非今天 → week（昨天）', () => {
    expect(bucketOf(new Date(2026, 5, 16, 23, 0, 0).getTime(), NOW)).toBe('week');
  });

  it('周一 00:00 = 本周周首 → week（边界归本周）', () => {
    expect(bucketOf(new Date(2026, 5, 15, 0, 0, 0).getTime(), NOW)).toBe('week');
  });

  it('上周日 23:59 → earlier（落在周首之前）', () => {
    expect(bucketOf(new Date(2026, 5, 14, 23, 59, 0).getTime(), NOW)).toBe('earlier');
  });

  it('更久之前 → earlier', () => {
    expect(bucketOf(new Date(2026, 5, 1, 0, 0, 0).getTime(), NOW)).toBe('earlier');
  });
});
