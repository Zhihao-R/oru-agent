/**
 * BoardTaskStatus（值即中文：'待办'|'进行中'|'待验收'|'已完成'）→ 显示 label 的统一 i18n 取词。
 *
 * 关键：status 值是**数据枚举**（存进任务、用于 === 判断），绝不本地化；只翻给人看的 label。
 * 用 latin key 映射（不用中文原文当 key），整个 taskboard 共用此助手，避免每处重写映射。
 */
import type { TFunction } from 'i18next';
import type { BoardTaskStatus } from '@shared/types';

const STATUS_KEY: Record<BoardTaskStatus, string> = {
  '待办': 'todo',
  '进行中': 'inProgress',
  '待验收': 'review',
  '已完成': 'done',
};

// t 由调用方按 taskboard ns 绑定传入，故键不带 ns 前缀（status.* 即 taskboard:status.*）
export function statusLabel(status: BoardTaskStatus, t: TFunction): string {
  return t(`status.${STATUS_KEY[status]}`);
}
