/**
 * changelog.md（dream 整理记录）解析——按 `## YYYY-MM-DD` 分夜。
 * 节内先是 dream 自写的夜记段落（叙述体，面向用户），后是逐条机器明细（`- ` 行）。
 * 展示按最近的夜在前（文件按时间正序追加，这里 reverse）。
 *
 * 主页「昨夜」节 / 往期夜记浮层共用；测试见 tests/components/nightlogParse.test.ts。
 */
export type Night = {
  date: string; // YYYY-MM-DD
  note: string; // 夜记段落（可能为空——老格式只有明细）
  details: string[]; // 去掉 '- ' 前缀的明细行
};

export function parseChangelog(content: string): Night[] {
  const nights: Night[] = [];
  let cur: Night | null = null;
  const noteLines: string[] = [];
  const flushNote = () => {
    if (cur) cur.note = noteLines.join(' ').trim();
    noteLines.length = 0;
  };
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    const m = /^## (\d{4}-\d{2}-\d{2})\s*$/.exec(line.trim());
    if (m) {
      flushNote();
      cur = { date: m[1], note: '', details: [] };
      nights.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('- ')) {
      cur.details.push(line.slice(2));
    } else if (line.trim().length > 0) {
      noteLines.push(line.trim());
    }
  }
  flushNote();
  return nights.reverse(); // 文件按时间正序追加 → 展示最近的夜在前
}
