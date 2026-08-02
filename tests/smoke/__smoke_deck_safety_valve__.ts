/**
 * __smoke_deck_safety_valve__ —— 验打地鼠兜底不死循环（PRD 验收 4）：
 *
 * 模型**每轮都在改 deck**（readDeck 每轮返不同串 = 它一直在改），但 validate 每轮返**不同**项
 * （改掉 A 又冒 B，不收敛）→ 早停信号"deck 内容没变"永不触发 → loop 撞 MAX_FIX_ROUNDS 后停、
 * 收工、残留中性标注交回。验"模型一直改却不收敛"这条路径被死上限兜住、不无限烧。
 *
 * 直接驱动 runFixLoop，注入 mock：validate 每轮不同 + readDeck 每轮变。
 */
import './__smoke_isolate__';
import { runFixLoop } from '../../electron/main/tasks/subagentRunner';
import type { DeckValidationError } from '../../electron/main/deck/validateDeck';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const MAX = 3;

async function main(): Promise<void> {
  const convCalls: string[] = [];
  let adviseEmitted = 0;
  let deckVersion = 0; // 模型每轮都改 deck

  let n = 0;
  const outcome = await runFixLoop({
    maxRounds: MAX,
    // 每轮返不同项（漂移打地鼠：改掉 A 又冒 B）
    validate: async () => {
      n += 1;
      return [{ page: n, kind: 'blank', message: `第 ${n} 轮新冒的空白页` }];
    },
    // 模型每轮都改 deck → "内容没变"早停永不触发，只能靠 maxRounds 兜
    readDeck: async () => `DECK_V${deckVersion}`,
    runConversation: async (m) => {
      convCalls.push(m);
      deckVersion += 1;
      return { summary: `r#${convCalls.length}` };
    },
    onAdvise: () => {
      adviseEmitted += 1;
      return 'ADVISE_MSG';
    },
  });

  // 撞上限停：正好 MAX 轮回喊，不无限
  assert(convCalls.length === MAX, `撞上限停：正好 ${MAX} 轮回喊（不无限）`, `convCalls=${convCalls.length}`);
  assert(adviseEmitted === MAX, `正好 ${MAX} 轮回喂进度`, `advise=${adviseEmitted}`);
  assert(outcome.rounds === MAX, `rounds=${MAX}`, `rounds=${outcome.rounds}`);
  assert(outcome.residual !== null && outcome.residual.length > 0, '残留客观项交回（中性标注）');
  // 不再有"额外的安全阀说明轮"——撞顶即停、不多喊一轮
  assert(convCalls.every((m) => m === 'ADVISE_MSG'), '每轮都是建议式回喊（无单独残留说明轮）');

  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\nTotal: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke fatal:', e);
  process.exit(1);
});
