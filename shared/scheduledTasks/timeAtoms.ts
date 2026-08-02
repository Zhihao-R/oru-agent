/**
 * 定时任务时间换算原子——纯函数、无副作用、无 i18n。模型路径（resolveSchedule）与界面
 * 路径（specForm.buildSpec）共用同一份，这才是「人话时间 → 机器时刻」的单一事实源。
 *
 * 解析一律「先正则匹配、再逐项范围校验、最后才用 Date 组件构造」：绝不把字符串直接喂
 * `new Date(y, m, d)`——它对 2026-13-05 这类越界**静默翻滚**成合法的另一天（2027-01-05），
 * 会在模型路径上重新埋回「设了个合法但错误的未来时刻、过得了所有闸」的病灶。越界即 throw，
 * 错误当场暴露。throw message 是喂给模型/开发者的诊断（类③，不 i18n），与 schedule.ts
 * 既有的中文校验 message 同语种。
 */
export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** 当月天数（按本地历，含闰年）。 */
function daysInMonth(year: number, month1to12: number): number {
  // new Date(y, month, 0) 的第三参 0 = 上个月最后一天 → 即 month1to12 月的天数
  return new Date(year, month1to12, 0).getDate();
}

/** "08:00" → 480（本地零点起的分钟数）。正则 + 范围校验，越界 throw。 */
export function hhmmToMinutes(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`时间需形如 18:00，收到「${s}」`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23) throw new Error(`小时须 0-23，收到「${s}」`);
  if (min > 59) throw new Error(`分钟须 0-59，收到「${s}」`);
  return h * 60 + min;
}

/** ("2026-06-29", "18:00") → 本地时区该时刻的时间戳。正则 + 范围校验后再用 Date 组件构造。 */
export function parseLocalDateTime(date: string, time: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`日期需形如 2026-06-29，收到「${date}」`);
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]);
  if (month < 1 || month > 12) throw new Error(`月份须 1-12，收到「${date}」`);
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) throw new Error(`日期须 1-${maxDay}（${year}年${month}月），收到「${date}」`);
  const minutesOfDay = hhmmToMinutes(time);
  return new Date(year, month - 1, day, Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0, 0).getTime();
}

/** 「N 分钟/小时/天后」→ 绝对时刻。minute/hour 用毫秒算术；day 走 Date 组件 +N 天（DST 安全）。 */
export function afterToMs(value: number, unit: 'minute' | 'hour' | 'day', now: number): number {
  if (unit === 'minute') return now + value * 60_000;
  if (unit === 'hour') return now + value * 3_600_000;
  const d = new Date(now);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + value,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).getTime();
}

/** 'sun'..'sat' → 0..6（对齐 Date.getDay()）。未知名字 throw。 */
export function weekdayToNumber(w: Weekday): number {
  const i = WEEKDAYS.indexOf(w);
  if (i < 0) throw new Error(`星期名须为 sun..sat，收到「${w}」`);
  return i;
}
