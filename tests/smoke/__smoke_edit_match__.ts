/**
 * edit 匹配算法 smoke（移植 claude code FileEditTool/utils.ts）
 *
 * - findActualString：精确命中 / 弯引号↔直引号归一命中且截出原样弯引号片段 / 没命中返回 null
 * - countMatches：多处出现计数正确
 * - preserveQuoteStyle：把 new 的直引号改回文件弯引号风格；缩写撇号转 ’（不误转成开引号 ‘）
 * - applyEdit：replace / replaceAll；new 含 $ 不被当替换模式
 */
import {
  findActualString,
  preserveQuoteStyle,
  applyEdit,
  countMatches,
} from '../../electron/main/fs/editMatch';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== edit match smoke ===');

// ① 精确命中
assert(findActualString('abc def ghi', 'def') === 'def', '① 精确命中返回原片段');

// ② 文件含弯引号、search 用直引号 → 命中且 actualOld 保留弯引号
const fileCurly = '他说“你好”世界';
const actual = findActualString(fileCurly, '说"你好"世');
assert(actual === '说“你好”世', '② 弯引号归一命中且截出原样弯引号片段', String(actual));

// ③ 没命中返回 null
assert(findActualString('abc', 'xyz') === null, '③ 没命中返回 null');

// ④ countMatches 多处计数
assert(countMatches('a foo b foo c foo', 'foo') === 3, '④ countMatches 多处=3');
assert(countMatches('only once', 'once') === 1, '④ countMatches 单处=1');

// ⑤ preserveQuoteStyle：双引号开/闭 + 缩写撇号
//   文件双弯引号：new 的直引号按开/闭还原弯引号
const oldD = 'the "best" way';
const actualD = 'the “best” way';
assert(
  preserveQuoteStyle(oldD, actualD, 'the "good" way') === 'the “good” way',
  '⑤ 双引号 new 直引号还原为开/闭弯引号',
  preserveQuoteStyle(oldD, actualD, 'the "good" way'),
);
//   文件单弯引号（撇号场景）：缩写 can't 的撇号转 ’，不误转成开引号 ‘
const oldS = "don't go";
const actualS = 'don’t go';
const preservedS = preserveQuoteStyle(oldS, actualS, "can't stay");
assert(preservedS === 'can’t stay', '⑤ 缩写撇号转 ’ 不误转成 ‘', preservedS);
//   中文引号紧贴字符（无空格）：按序位映射还原字形，开/闭启发式判不出来也对
const oldCJK = '说"你好"收';
const actualCJK = '说“你好”收';
const preservedCJK = preserveQuoteStyle(oldCJK, actualCJK, '说"再见"收');
assert(preservedCJK === '说“再见”收', '⑤ 中文弯引号按序位还原（开/闭启发失效场景）', preservedCJK);
//   oldString === actualOldString（没归一）→ new 原样返回
assert(preserveQuoteStyle('abc', 'abc', 'x"y"') === 'x"y"', '⑤ 未归一时 new 原样返回');

// ⑥ applyEdit
assert(applyEdit('a foo b foo', 'foo', 'BAR', false) === 'a BAR b foo', '⑥ 单替换只换第一处');
assert(applyEdit('a foo b foo', 'foo', 'BAR', true) === 'a BAR b BAR', '⑥ replaceAll 全换');
assert(applyEdit('price X', 'X', '$5', false) === 'price $5', '⑥ new 含 $ 不被当替换模式');

const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== edit match smoke: ${RESULTS.length - failed.length}/${RESULTS.length} PASS ===`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL: ${r.name} — ${r.detail ?? ''}`);
  process.exit(1);
}
