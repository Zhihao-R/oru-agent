/**
 * Loop 伴随卡的状态呈现映射（纯函数，单独 TDD）。
 * 把内核阶段 + 轮数 + 收工原因 收成卡面的「状态词 + 基调 + 是否转圈」——基调驱动颜色，让组件只管渲染。
 * v3：砍掉确认门/交棒/超时态，只剩编译 / 运行 / 三种终态（达标·到上限·你停）/ 失败 / 跨重启。
 */
import type { TFunction } from 'i18next';
import type { LoopCardPayload } from '@shared/types';

export type LoopCardTone = 'running' | 'done' | 'warn' | 'muted' | 'failed';

export function loopCardStatus(
  card: Pick<LoopCardPayload, 'phase' | 'round' | 'stopReason'>,
  t: TFunction,
): { statusText: string; tone: LoopCardTone; spinning: boolean } {
  const { phase, round, stopReason } = card;
  switch (phase) {
    case 'compiling':
      return { statusText: t('loop.status.compiling'), tone: 'running', spinning: true };
    case 'running':
      // 轮次不带分母（2026-07-28 拍板）：上限是护栏不是目标，展示「第几轮」就够。
      return {
        statusText: round >= 1 ? t('loop.status.round', { round }) : t('loop.status.running'),
        tone: 'running',
        spinning: true,
      };
    case 'interrupted':
      // 跨重启：纯陈列终态（停在第几轮）——想继续再发一条，卡不再等决定（T3 恢复路径退役）。
      return { statusText: t('loop.status.interrupted', { round }), tone: 'warn', spinning: false };
    case 'failed':
      return { statusText: t('loop.status.failed'), tone: 'failed', spinning: false };
    case 'done':
      // 拆解反问收场——安静终态：没开跑，Oru 的问题在对话流里等用户补充（非失败不翻红）。
      if (stopReason === 'clarify') {
        return { statusText: t('loop.status.clarify'), tone: 'muted', spinning: false };
      }
      // 用户主动停——中性措辞「已停止」（你叫停的，不是花超了、也不是没达标）。
      if (stopReason === 'user-stopped') {
        return { statusText: t('loop.status.stoppedByUser'), tone: 'muted', spinning: false };
      }
      // 到轮数上限中止——warn 基调，与达标区分。
      if (stopReason === 'max-rounds') {
        return { statusText: t('loop.status.stoppedAtLimit'), tone: 'warn', spinning: false };
      }
      // 收敛：全达标。
      return { statusText: t('loop.status.doneAllMet', { round }), tone: 'done', spinning: false };
  }
}
