/**
 * 渲染 unified diff——块头（accent 竖标 + 文件名 + 增删计数）+ 单栏行内染色正文。
 * 文件写审批卡（FileWriteProposalCard）与工具详情浮层（ToolCallLine）共用，入参只有 diff。
 */

// 增/删这对语义色走 success/danger 三件套（soft 底 + deep 字 + base 行标），随主题与夜间走。
const DIFF_COLORS = {
  add: { bg: 'var(--success-soft)', text: 'var(--success-deep)', gutter: 'var(--success)' },
  del: { bg: 'var(--danger-soft)', text: 'var(--danger-deep)', gutter: 'var(--danger)' },
} as const;

type Row =
  | { kind: 'add'; content: string }
  | { kind: 'del'; content: string }
  | { kind: 'ctx'; content: string; lineNo: number };

/**
 * 从 diff 里解析出待渲染的行 + 文件名 + 增删计数。
 * 丢弃协议噪音行（Index:/===/+++/---）；@@ 行不渲染，只用来重置新侧行号计数器。
 * 行号：解析 `@@ -a,b +c,d @@` 的 c 作为新侧起始行号；上下文行占用并递增新侧行号，
 * `+` 行推进新侧行号但行号槽显示标记，`-` 行不推进新侧行号。
 * 无 @@ 的退化输入（isUnifiedDiff 为假）仍能渲染：+/- 照常上色，上下文行行号槽留空。
 */
function parseDiff(diff: string): { name: string | null; rows: Row[]; add: number; del: number } {
  let name: string | null = null;
  const rows: Row[] = [];
  let add = 0;
  let del = 0;
  let newLine = 0; // 当前新侧行号；未遇到 @@ 时为 0，上下文行则留空行号槽

  for (const line of diff.split('\n')) {
    if (line.startsWith('Index:')) {
      // 取末段 basename 作为文件名；正反斜杠都算路径分隔符
      const path = line.slice('Index:'.length).trim();
      const seg = path.split(/[/\\]/).pop();
      if (seg) name = seg;
      continue;
    }
    if (line.startsWith('===') || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      if (m) newLine = Number(m[1]);
      continue;
    }
    if (line.startsWith('+')) {
      add += 1;
      rows.push({ kind: 'add', content: line.slice(1) });
      if (newLine) newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      del += 1;
      rows.push({ kind: 'del', content: line.slice(1) });
      continue;
    }
    // 上下文行：以空格开头（去掉前缀）或无前缀
    const content = line.startsWith(' ') ? line.slice(1) : line;
    rows.push({ kind: 'ctx', content, lineNo: newLine });
    if (newLine) newLine += 1;
  }

  return { name, rows, add, del };
}

export function DiffBlock({ diff }: { diff: string }) {
  const { name, rows, add, del } = parseDiff(diff);

  return (
    <div className="overflow-hidden rounded-sm border border-border bg-elevated">
      {/* 块头 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="h-3.5 w-[3px] shrink-0 rounded-[2px] bg-accent" />
        {name && (
          <span className="truncate font-mono text-xs text-text-tertiary">{name}</span>
        )}
        {/* 用真减号 U+2212，非 ASCII 连字符 */}
        <span className="ml-auto shrink-0 text-2xs tabular-nums text-text-quaternary">
          +{add} −{del}
        </span>
      </div>

      {/* 染色正文 */}
      <div className="max-h-72 overflow-y-auto py-2 font-mono text-xs leading-relaxed">
        {rows.map((row, i) => {
          if (row.kind === 'ctx') {
            // 上下文行：正文/行号槽走 token，随主题走
            return (
              <div key={i} className="flex gap-3 px-3">
                <span className="w-[18px] shrink-0 text-right text-text-quaternary">
                  {row.lineNo ? String(row.lineNo) : ''}
                </span>
                <span className="text-text-secondary">{row.content || ' '}</span>
              </div>
            );
          }
          const c = row.kind === 'add' ? DIFF_COLORS.add : DIFF_COLORS.del;
          return (
            <div key={i} className="flex gap-3 px-3" style={{ background: c.bg }}>
              <span className="w-[18px] shrink-0 text-right" style={{ color: c.gutter }}>
                {row.kind === 'add' ? '+' : '−'}
              </span>
              <span style={{ color: c.text }}>{row.content || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 判定一段文本是不是 makePatch 输出的 unified diff——据此决定 chip 是否着色渲染。
 * makePatch 恒为「Index: 行 + 全等号分隔线 + ---/+++ + @@」结构；同时要求 `Index: ` 开头
 * 与 `@@` hunk 标记，避免普通命令输出（如某行恰好以 `Index:` 起头）被误当 diff 着色。
 */
export function isUnifiedDiff(text: string): boolean {
  const s = text.trimStart();
  return s.startsWith('Index: ') && /\n@@ /.test(s);
}
