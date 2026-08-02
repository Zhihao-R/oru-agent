import i18n from '@/lib/i18n';

/**
 * 相对时间格式化：刚刚 / N 分钟前 / N 小时前 / N 天前；超过 7 天给本地完整时间。
 * 回收站、评论行等多处共用同一口径，不各自手抄。
 * 纯函数（非 React），按调用时的当前界面语言取词（与 aside/deckClick 同款 i18n 单例先例）。
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(ts: number): string {
  // 用 {{count}}（仓库统一约定）：中文 CLDR 只有 other 一档、回落裸键行为不变；英文期靠它自动选单复数。
  const diff = Date.now() - ts;
  if (diff < MINUTE) return i18n.t('common:relativeTime.justNow');
  if (diff < HOUR) return i18n.t('common:relativeTime.minutesAgo', { count: Math.floor(diff / MINUTE) });
  if (diff < DAY) return i18n.t('common:relativeTime.hoursAgo', { count: Math.floor(diff / HOUR) });
  if (diff < 7 * DAY) return i18n.t('common:relativeTime.daysAgo', { count: Math.floor(diff / DAY) });
  // 超 7 天走系统 locale 完整时间（非硬编码中文）；英文期需改 toLocaleString(i18n.language) 对齐界面语言。
  return new Date(ts).toLocaleString();
}
