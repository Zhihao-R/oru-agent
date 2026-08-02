/**
 * 文件引用匹配 —— 判断一段文本（bash 命令 / 写入路径）是否引用了某个文件。
 *
 * AI 出口闸门（main 的 tableGate）与提案卡阻断态（renderer 的 dirtyFiles）共用这一份
 * 口径——修匹配规则只改一处。带边界判定：裸 includes 会让「报表.csv」的草稿误拦
 * 「月报表.csv」的操作（中文文件名没有 \b 可用，自定义边界字符集）。
 *
 * 诚实声明：文本匹配判定"以哪个文件为输入"不可能完备，这里是近似不是围栏。
 */

const BOUNDARY_BEFORE = /[\s"'`=:,;|&()<>[\]{}/]/;
const BOUNDARY_AFTER = /[\s"'`=:,;|&()<>[\]{}，。、；：）（]/;

function hitWithBoundary(text: string, needle: string): boolean {
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    const before = idx === 0 ? '' : text[idx - 1]!;
    const after = idx + needle.length >= text.length ? '' : text[idx + needle.length]!;
    if ((before === '' || BOUNDARY_BEFORE.test(before)) && (after === '' || BOUNDARY_AFTER.test(after))) {
      return true;
    }
    idx = text.indexOf(needle, idx + 1);
  }
  return false;
}

/** texts 中是否引用了 relPath（按完整相对路径或裸文件名，带边界）。 */
export function textsReferenceFile(texts: string[], relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const needles = relPath === name ? [name] : [relPath, name];
  return texts.some((t) => needles.some((n) => hitWithBoundary(t, n)));
}
