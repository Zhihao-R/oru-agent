// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';
import type { LoopCardPayload } from '@shared/types';
import { loopCardStatus } from '../../src/components/chat/loopCardStatus';

// loopCardStatus 经 i18n 取 statusText——用真实 zh 资源、chat ns 绑定的 t 验证 phase→中文映射端到端。
let t: TFunction;
beforeAll(async () => {
  const i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
  t = i18n.getFixedT('zh', 'chat');
});

function card(over: Partial<LoopCardPayload>): Pick<LoopCardPayload, 'phase' | 'round' | 'stopReason'> {
  return { phase: 'running', round: 0, stopReason: undefined, ...over };
}

describe('loopCardStatus', () => {
  it('编译态 → running 基调 + 转圈', () => {
    expect(loopCardStatus(card({ phase: 'compiling' }), t)).toMatchObject({
      statusText: '拆解验收标准中',
      tone: 'running',
      spinning: true,
    });
  });

  it('运行态：首轮前显示「循环进行中」，round≥1 显示第几轮（不带分母——上限是护栏不是目标）', () => {
    expect(loopCardStatus(card({ phase: 'running', round: 0 }), t).statusText).toBe('循环进行中');
    expect(loopCardStatus(card({ phase: 'running', round: 2 }), t).statusText).toBe('第 2 轮');
  });

  it('收敛（all-satisfied）→ done 基调「循环完成 · 第 N 轮达标」', () => {
    expect(loopCardStatus(card({ phase: 'done', round: 3, stopReason: 'all-satisfied' }), t)).toMatchObject({
      statusText: '循环完成 · 第 3 轮达标',
      tone: 'done',
      spinning: false,
    });
  });

  it('到轮数上限 → warn 基调「已到轮数上限」', () => {
    expect(loopCardStatus(card({ phase: 'done', stopReason: 'max-rounds' }), t)).toMatchObject({
      statusText: '已到轮数上限',
      tone: 'warn',
    });
  });

  it('用户停 → muted 基调「已停止」（与到上限区分）', () => {
    expect(loopCardStatus(card({ phase: 'done', stopReason: 'user-stopped' }), t)).toMatchObject({
      statusText: '已停止',
      tone: 'muted',
    });
  });

  it('拆解反问收场（clarify）→ muted 安静终态「没开跑 · 有个问题等你补充」，不翻红', () => {
    expect(loopCardStatus(card({ phase: 'done', stopReason: 'clarify' }), t)).toMatchObject({
      statusText: '没开跑 · 有个问题等你补充',
      tone: 'muted',
      spinning: false,
    });
  });

  it('失败 → failed 基调「失败」', () => {
    expect(loopCardStatus(card({ phase: 'failed' }), t)).toMatchObject({ statusText: '失败', tone: 'failed' });
  });

  it('跨重启 → warn 基调纯陈列「被打断 · 停在第 N 轮」（T3：不再等决定）', () => {
    expect(loopCardStatus(card({ phase: 'interrupted', round: 2 }), t)).toMatchObject({
      statusText: '被打断 · 停在第 2 轮',
      tone: 'warn',
      spinning: false,
    });
  });
});
