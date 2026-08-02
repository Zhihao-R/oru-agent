/**
 * 在飞回合打标登记表（连发合并 S1）——「无产出才撤」的判定与撤起链 origins custody。
 *
 * 承重口径：
 *  - 「无产出」= 无 chat.delta 且无 chat.toolCall，装配层单点打标，队列/入口只读。
 *  - 撤起不交手还：被撤回合已消费 origins 由本表 custody 过户给重起回合。
 *  - token 归属：被撤回合的迟到收尾（旧 token）一律不得动新回合的条目。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerOrigin } from '@shared/types';
import {
  RESTART_WINDOW_MS,
  beginLiveTurn,
  drainLiveTurn,
  endLiveTurn,
  isLiveTurnRestartable,
  isLiveTurnSuperseded,
  markLiveTurnProduced,
  noteLiveTurnOrigin,
  peekLiveTurnOrigins,
  supersedeLiveTurn,
} from '../../electron/main/agent/liveTurnMark';

// 登记表是模块级单例：每个用例取独立 key，杜绝跨用例污染。
let keySeq = 0;
let K: string;
const originOf = (messageId: string): TriggerOrigin => ({
  platform: 'feishu',
  chatId: 'oc_1',
  platformMessageId: messageId,
});

beforeEach(() => {
  K = `a:c${(keySeq += 1)}`;
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('liveTurnMark · 可撤判定（窗口 × 无产出）', () => {
  it('起跑后窗口内且无产出 → 可撤', () => {
    beginLiveTurn(K, 1);
    expect(isLiveTurnRestartable(K)).toBe(true);
    vi.setSystemTime(10_000 + RESTART_WINDOW_MS);
    expect(isLiveTurnRestartable(K)).toBe(true); // 边界含端点
  });

  it('窗口外 → 不可撤（即便一直无产出）', () => {
    beginLiveTurn(K, 1);
    vi.setSystemTime(10_000 + RESTART_WINDOW_MS + 1);
    expect(isLiveTurnRestartable(K)).toBe(false);
  });

  it('流过产出（delta/tool_use 打标）→ 立即不可撤', () => {
    beginLiveTurn(K, 1);
    markLiveTurnProduced(K, 1);
    expect(isLiveTurnRestartable(K)).toBe(false);
  });

  it('无条目（回合未起跑 / 已终结）→ 不可撤（安全方向）', () => {
    expect(isLiveTurnRestartable('never:seen')).toBe(false);
  });

  it('回合终了销条后 → 不可撤', () => {
    beginLiveTurn(K, 1);
    endLiveTurn(K, 1);
    expect(isLiveTurnRestartable(K)).toBe(false);
  });
});

describe('liveTurnMark · token 归属（旧回合迟到收尾不得动新条）', () => {
  it('旧 token 的 markProduced / endLiveTurn 在新 token 条目上一律 no-op', () => {
    beginLiveTurn(K, 1);
    supersedeLiveTurn(K, 2); // 撤起过户：条目改属 token 2
    markLiveTurnProduced(K, 1); // 被撤回合的流尾声——不得打脏新回合
    expect(isLiveTurnRestartable(K)).toBe(true);
    endLiveTurn(K, 1); // 被撤回合的迟到 finally——不得删新回合的条
    expect(isLiveTurnRestartable(K)).toBe(true);
  });

  it('新回合起跑（begin）重置产出标记与窗口锚', () => {
    beginLiveTurn(K, 1);
    markLiveTurnProduced(K, 1);
    supersedeLiveTurn(K, 2);
    vi.setSystemTime(11_500);
    beginLiveTurn(K, 2); // 重起回合真正起跑
    expect(isLiveTurnRestartable(K)).toBe(true); // produced 已重置
    vi.setSystemTime(11_500 + RESTART_WINDOW_MS + 1);
    expect(isLiveTurnRestartable(K)).toBe(false); // 窗口锚在重起时刻
  });
});

describe('liveTurnMark · origins custody（撤起链过户）', () => {
  it('回合消费的 origin 入账，撤起过户时保留并追加新消息 origin', () => {
    beginLiveTurn(K, 1);
    noteLiveTurnOrigin(K, 1, originOf('om_1'));
    supersedeLiveTurn(K, 2, originOf('om_2'));
    expect(peekLiveTurnOrigins(K)).toEqual([originOf('om_1'), originOf('om_2')]);
  });

  it('重起回合 begin 继承 custody；旧回合迟到的 endLiveTurn 删不到', () => {
    beginLiveTurn(K, 1);
    noteLiveTurnOrigin(K, 1, originOf('om_1'));
    supersedeLiveTurn(K, 2, originOf('om_2'));
    beginLiveTurn(K, 2); // 重起回合起跑：继承 origins
    endLiveTurn(K, 1); // 被撤回合迟到收尾：no-op
    expect(peekLiveTurnOrigins(K)).toEqual([originOf('om_1'), originOf('om_2')]);
  });

  it('重复 origin（同一消息经 supersede 入账后又被新回合 seed）按三元组去重', () => {
    beginLiveTurn(K, 1);
    supersedeLiveTurn(K, 2, originOf('om_2'));
    beginLiveTurn(K, 2);
    noteLiveTurnOrigin(K, 2, originOf('om_2')); // 新回合 seed firstOrigin——不再入第二条
    expect(peekLiveTurnOrigins(K)).toEqual([originOf('om_2')]);
  });

  it('token 不符的 noteOrigin 不入账（被撤回合的迟到 drain）', () => {
    beginLiveTurn(K, 1);
    supersedeLiveTurn(K, 2);
    noteLiveTurnOrigin(K, 1, originOf('om_late'));
    expect(peekLiveTurnOrigins(K)).toEqual([]);
  });

  it('自然终结的回合销条后，下一回合不继承旧 origins', () => {
    beginLiveTurn(K, 1);
    noteLiveTurnOrigin(K, 1, originOf('om_1'));
    endLiveTurn(K, 1);
    beginLiveTurn(K, 2);
    expect(peekLiveTurnOrigins(K)).toEqual([]);
  });
});

describe('liveTurnMark · 撤起判据与终止兜底（S1 review · I1/I2）', () => {
  it('isLiveTurnSuperseded：条目过户（或新回合开条翻新）后旧 token 判 true，同 token 判 false', () => {
    beginLiveTurn(K, 1);
    expect(isLiveTurnSuperseded(K, 1)).toBe(false);
    supersedeLiveTurn(K, 2);
    expect(isLiveTurnSuperseded(K, 1)).toBe(true); // 被撤回合收尾据此不抢清表情
    expect(isLiveTurnSuperseded(K, 2)).toBe(false);
  });

  it('isLiveTurnSuperseded：无条目判 false（Esc 清场后被撤回合收尾照常清表情）', () => {
    expect(isLiveTurnSuperseded(K, 1)).toBe(false);
  });

  it('drainLiveTurn：无条件销条并返回 custody origins；空调用返回空', () => {
    beginLiveTurn(K, 1);
    noteLiveTurnOrigin(K, 1, originOf('om_1'));
    supersedeLiveTurn(K, 2, originOf('om_2'));
    expect(drainLiveTurn(K)).toEqual([originOf('om_1'), originOf('om_2')]);
    expect(isLiveTurnRestartable(K)).toBe(false); // 已销条
    expect(drainLiveTurn(K)).toEqual([]); // 再空调用安全
  });
});
