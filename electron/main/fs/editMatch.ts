/**
 * editMatch —— edit_file 的匹配/回写算法（移植 claude code `FileEditTool/utils.ts`）。
 *
 * 设计要点（对应 PRD「局部编辑只动该动的，且不靠猜」）：
 *   - 匹配以精确为准；唯一被容忍的差异是弯引号↔直引号（AI 几乎必然输不一致的一类）。
 *   - 弯引号归一命中后，从原文截出**原样**片段（保留弯引号），回写时把 new_string 的
 *     引号改回文件原弯引号风格——不引入排版污染。
 *   - 除此之外不做任何近似（不忽略空格/大小写/相似度）。
 */

// Claude 无法直接输出弯引号——这里常量化，匹配时把弯引号归一为直引号比较。
const LEFT_SINGLE = '‘'; // ‘
const RIGHT_SINGLE = '’'; // ’
const LEFT_DOUBLE = '“'; // “
const RIGHT_DOUBLE = '”'; // ”

/** 把弯引号（单/双）归一为直引号。 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE, "'")
    .replaceAll(RIGHT_SINGLE, "'")
    .replaceAll(LEFT_DOUBLE, '"')
    .replaceAll(RIGHT_DOUBLE, '"');
}

/**
 * 在 fileContent 里找到与 searchString 对应的**原样**片段：
 *   ① 先精确 includes；② 失败再试弯引号归一后 indexOf，命中则按原文截出原样片段；
 *   ③ 仍不中返回 null（不做任何其他近似）。
 */
export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;

  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const idx = normalizedFile.indexOf(normalizedSearch);
  if (idx !== -1) {
    // 归一只替换单字符弯引号→直引号，长度不变，故原文同位置同长度即原样片段
    return fileContent.substring(idx, idx + searchString.length);
  }
  return null;
}

/**
 * old_string 经弯引号归一才命中时（actualOldString 含弯引号），把 new_string 的对应直引号
 * 改回文件弯引号风格，保留排版。开/闭判断用简单启发：前为空白/起始/开括号视为开引号。
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) return newString; // 没归一，原样

  const hasDouble =
    actualOldString.includes(LEFT_DOUBLE) || actualOldString.includes(RIGHT_DOUBLE);
  const hasSingle =
    actualOldString.includes(LEFT_SINGLE) || actualOldString.includes(RIGHT_SINGLE);
  if (!hasDouble && !hasSingle) return newString;

  let result = newString;
  if (hasDouble) result = applyCurlyDouble(result, collectGlyphs(actualOldString, [LEFT_DOUBLE, RIGHT_DOUBLE]));
  if (hasSingle) result = applyCurlySingle(result, collectGlyphs(actualOldString, [LEFT_SINGLE, RIGHT_SINGLE]));
  return result;
}

/** 按出现顺序收集 actualOld 里指定弯引号字形——回写时按相同序位映射，精确还原文件原本字形。 */
function collectGlyphs(str: string, glyphs: string[]): string[] {
  const out: string[] = [];
  for (const ch of str) if (glyphs.includes(ch)) out.push(ch);
  return out;
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '—' || // em dash
    prev === '–' // en dash
  );
}

/**
 * 把 new 里的直双引号还原为弯引号：优先按序位映射到 actualOld 的实际字形（available）——
 * 这对中文文本（引号紧贴字符、无空格，开/闭启发式判不出来）才正确；available 用尽后才
 * 退回开/闭启发式（new 比 old 多出的引号）。
 */
function applyCurlyDouble(str: string, available: string[]): string {
  const chars = [...str];
  const out: string[] = [];
  let k = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      if (k < available.length) out.push(available[k++]!);
      else out.push(isOpeningContext(chars, i) ? LEFT_DOUBLE : RIGHT_DOUBLE);
    } else {
      out.push(chars[i]!);
    }
  }
  return out.join('');
}

function applyCurlySingle(str: string, available: string[]): string {
  const chars = [...str];
  const out: string[] = [];
  let k = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      if (k < available.length) {
        out.push(available[k++]!);
      } else {
        // available 用尽：字母间撇号是缩写（don't / it's），用右单弯引号 ’，否则按开/闭启发
        const prev = i > 0 ? chars[i - 1] : undefined;
        const next = i < chars.length - 1 ? chars[i + 1] : undefined;
        const prevLetter = prev !== undefined && /\p{L}/u.test(prev);
        const nextLetter = next !== undefined && /\p{L}/u.test(next);
        if (prevLetter && nextLetter) out.push(RIGHT_SINGLE);
        else out.push(isOpeningContext(chars, i) ? LEFT_SINGLE : RIGHT_SINGLE);
      }
    } else {
      out.push(chars[i]!);
    }
  }
  return out.join('');
}

/**
 * 应用替换。用 `() => replace` 回调形式，避免 new_string 含 `$&`/`$1` 等被当成
 * 正则替换模式（移植 claude code）。new 为空时处理尾随换行，避免留空行。
 */
export function applyEdit(content: string, actualOld: string, newStr: string, replaceAll: boolean): string {
  const f = replaceAll
    ? (c: string, s: string) => c.replaceAll(s, () => newStr)
    : (c: string, s: string) => c.replace(s, () => newStr);

  if (newStr !== '') return f(content, actualOld);

  // 删除片段时：若 old 不以 \n 结尾但其后紧跟 \n，连同那个 \n 一起删，避免留空行
  const stripTrailingNewline = !actualOld.endsWith('\n') && content.includes(actualOld + '\n');
  return stripTrailingNewline ? f(content, actualOld + '\n') : f(content, actualOld);
}

/** 命中次数 = split(actualOld).length - 1（移植 claude code 唯一性判定）。 */
export function countMatches(content: string, actualOld: string): number {
  if (actualOld === '') return 0;
  return content.split(actualOld).length - 1;
}
