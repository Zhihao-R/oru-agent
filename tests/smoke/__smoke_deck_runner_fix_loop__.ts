/**
 * __smoke_deck_runner_fix_loop__ —— 验建议式回路（PRD 验收 2/3，取代旧的"硬卡逃不掉"）：
 *
 *  ① 回喂硬保证 + 模型停手即收工：mock validate 恒返同一项、模型回喂后 **deck 内容不变**
 *     （readDeck 返同串）→ runner **一定回喂一次**（emit 进度 + 重跑会话，堵闭眼交付），
 *     然后**不无限循环**、收工，残留交回作中性标注（不臆断原因）。
 *  ② 修干净路径：模型改了 deck（readDeck 返新内容）→ 下一轮 validate 返 0 → 收工、无残留。
 *  ③ 退化：validate 恒空（任务 7 stub）→ 零额外轮次 = 同现状。
 *  ④ abort 透传：runConversation throw 不被 runFixLoop 吞。
 *
 * 直接驱动 runFixLoop（runner 抽出的格式无关骨架），注入 mock validate / readDeck / runConversation，
 * 不经 git/auth/provision——稳健地验循环本身。
 */
import './__smoke_isolate__';
import { runFixLoop } from '../../electron/main/tasks/subagentRunner';
import type { DeckValidationError } from '../../electron/main/deck/validateDeck';
import { buildAdvisePrompt } from '../../electron/main/deck/deckFixPrompts';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const ERRORS: DeckValidationError[] = [
  { page: 3, kind: 'overflow', message: '标题溢出' },
  { page: 5, kind: 'broken-image', message: 'images/x.png 裂图' },
];

async function main(): Promise<void> {
  // ① 回喂硬保证 + 模型停手即收工：validate 恒返同一项；模型回喂后不动 deck（readDeck 恒返同串）
  {
    const convCalls: string[] = [];
    const progress: string[] = [];
    let validateCalls = 0;
    const deckContent = 'DECK_V0'; // 模型不改 → 始终同一串

    const outcome = await runFixLoop({
      maxRounds: 3,
      validate: async () => {
        validateCalls += 1;
        return ERRORS; // 恒返同一项
      },
      readDeck: async () => deckContent,
      runConversation: async (userMessage) => {
        convCalls.push(userMessage);
        return { summary: `round #${convCalls.length}` };
      },
      onAdvise: (round, errors) => {
        progress.push(`advise#${round}`);
        return buildAdvisePrompt(errors, 'RAW_PLAN');
      },
    });

    // 硬保证：第一次见到发现一定回喂一次（堵闭眼交付），不靠模型调任何工具
    assert(convCalls.length === 1, '回喂硬保证：第一次发现即回喂一次', `convCalls=${convCalls.length}`);
    assert(progress.length === 1 && progress[0] === 'advise#1', '发了 1 轮回喂进度文字（文本进度）', progress.join(','));
    assert(
      convCalls[0].includes('第 3 页') && convCalls[0].includes('第 5 页') && convCalls[0].includes('RAW_PLAN'),
      '回喂消息带清单 + 原任务意图(rawPlan 透传)',
    );
    assert(convCalls[0].includes('建议'), '回喂措辞是建议式（非硬卡）');
    // 停手即收工：模型没动 deck → 不无限循环，收工、残留交回
    assert(validateCalls === 2, '回喂后再校验一次即停（共 2 次 validate，不无限）', `validateCalls=${validateCalls}`);
    assert(outcome.residual !== null && outcome.residual.length === 2, '残留客观项交回作中性标注', JSON.stringify(outcome.residual));
    assert(outcome.rounds === 1, 'rounds=1', `rounds=${outcome.rounds}`);
    assert(outcome.result?.summary === 'round #1', '收工用最后一轮 result', JSON.stringify(outcome.result));
  }

  // ② 修干净路径：模型改了 deck → 下一轮 validate 全绿 → 收工无残留
  {
    const convCalls: string[] = [];
    let validateCalls = 0;
    let deckContent = 'DECK_V0';

    const outcome = await runFixLoop({
      maxRounds: 3,
      validate: async () => {
        validateCalls += 1;
        return validateCalls === 1 ? ERRORS : []; // 改完后全绿
      },
      readDeck: async () => deckContent,
      runConversation: async (m) => {
        convCalls.push(m);
        deckContent = 'DECK_V1'; // 模型这轮改了 deck
        return { summary: 'fixed' };
      },
      onAdvise: () => 'ADVISE',
    });

    assert(convCalls.length === 1, '修干净：回喂一轮即改好', `convCalls=${convCalls.length}`);
    assert(validateCalls === 2 && outcome.residual === null, '改后复检全绿 → 无残留收工', `validateCalls=${validateCalls}`);
    assert(outcome.rounds === 1, '修干净：rounds=1', `rounds=${outcome.rounds}`);
  }

  // ③ 退化：validate 恒空（任务 7 stub）→ 零额外轮次 = 同现状
  {
    const calls: string[] = [];
    const o = await runFixLoop({
      maxRounds: 3,
      validate: async () => [],
      readDeck: async () => 'X',
      runConversation: async (m) => { calls.push(m); return { summary: 'x' }; },
      onAdvise: () => 'advise',
    });
    assert(calls.length === 0 && o.rounds === 0 && o.residual === null, 'stub(validate 恒空)：循环零额外轮次=同现状');
  }

  // ④ abort 透传：runConversation throw（非 resolve）必须透传出 runFixLoop（包裹会吞掉用户取消）
  {
    let threw = false;
    try {
      await runFixLoop({
        maxRounds: 3,
        validate: async () => ERRORS,
        readDeck: async () => 'X',
        runConversation: async () => {
          throw new Error('AbortError: 渲染已取消');
        },
        onAdvise: () => 'advise',
      });
    } catch (e) {
      threw = /取消|Abort/.test(e instanceof Error ? e.message : String(e));
    }
    assert(threw, 'abort：runConversation throw 透传出 runFixLoop（不被吞）');
  }

  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\nTotal: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke fatal:', e);
  process.exit(1);
});
