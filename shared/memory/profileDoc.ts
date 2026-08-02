/**
 * 常驻认知档案的文档模型：印象 + 自由章节
 *
 * 档案就是一份 markdown 文档。第一个 `## ` 之前的正文 = 印象（preamble），
 * 其后每个 `## 标题` 块 = 一个章节。系统不再为「事实 / 画像」建模——它们只是普通章节。
 *
 * 解析器只在**读**时把文档拆成 { 印象, 章节[] } 供界面与注入用；**没有「丢弃」分支**——
 * 任何未识别的内容都落进它所在章节的 body，从根上堵住「整理一次就抹掉用户手写小节」
 * （2026-06-26 把含 6 个自定义小节的 user/profile.md 压成两段、丢 5 节的事故根因）。
 *
 * 核心不变量：renderProfileDoc(parseProfileDoc(x)) 幂等（再 parse→render 逐字节不变）、
 * 且零丢失。写完全通用（write/edit_memory 直接动正文），不认识任何固定区段。
 *
 * 设计见 docs/tech/2026-06-27-memory-document-model-tech-design.md §1。
 */

/** 读模型（仅用于显示与注入，不用于写） */
export type ProfileDoc = {
  impression: string; // 第一个 ## 之前的前言，去掉首尾空行
  sections: { title: string; body: string }[]; // 按出现顺序
};

/** `## 标题`（恰两个 #，不含 ### 等更深标题——那些算 body 内容） */
const SECTION_HEADER = /^## (.+)$/;

/** 去掉首尾空行，保留内部空行与每行缩进（只裁「环绕的空白行」，不动实质内容） */
function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

export function parseProfileDoc(body: string): ProfileDoc {
  const lines = body.split('\n');
  const preamble: string[] = [];
  const sections: { title: string; bodyLines: string[] }[] = [];
  let current: { title: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const m = SECTION_HEADER.exec(line);
    if (m) {
      current = { title: m[1].trim(), bodyLines: [] };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    } else {
      preamble.push(line);
    }
  }

  return {
    impression: trimBlankLines(preamble),
    sections: sections.map((s) => ({ title: s.title, body: trimBlankLines(s.bodyLines) })),
  };
}

/**
 * 预览时跳过的开头行：结构性标题（`# 我是谁` 只是小节名）、`last-updated-by-dream:` 系统哨兵
 * （dream 复盘时间戳，非给人看的正文）、空行——它们都不是内容精髓。
 */
const LEADING_NON_CONTENT = /^\s*(#{1,6}\s|last-updated-by-dream:|$)/;

/** 单段文本跳掉开头非正文行后，按空行切成正文段落（各自 trim、去空段）。 */
function contentParagraphs(text: string): string[] {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && LEADING_NON_CONTENT.test(lines[i])) i += 1;
  return lines
    .slice(i)
    .join('\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 手帐卡片预览：卡片眉标已说明「这是谁的档案」，预览要的是内容精髓而非结构标记。
 * 把印象与各章节 body 展平成正文段落序列（跳掉各自开头的标题/哨兵），从头累积——
 * 印象只有光标题（如自我档案 `# 我是谁`）时天然从第一章节起。不足 minChars 就跨段/跨章节续接，
 * 超过 maxChars 截断加省略号。续接的多段用换行分隔（`\n`），供渲染层分段显示、不拼成一坨。
 */
export function profileDocPreview(
  doc: ProfileDoc,
  { minChars = 80, maxChars = 160 }: { minChars?: number; maxChars?: number } = {},
): string {
  const paragraphs = [doc.impression, ...doc.sections.map((s) => s.body)].flatMap(contentParagraphs);
  let out = '';
  for (const p of paragraphs) {
    out = out ? `${out}\n${p}` : p;
    if (out.length >= minChars) break;
  }
  return out.length > maxChars ? `${out.slice(0, maxChars).trimEnd()}…` : out;
}

export function renderProfileDoc(doc: ProfileDoc): string {
  const parts: string[] = [];
  if (doc.impression.trim()) parts.push(doc.impression.trim());
  for (const s of doc.sections) {
    parts.push(s.body ? `## ${s.title}\n${s.body}` : `## ${s.title}`);
  }
  return parts.length === 0 ? '' : parts.join('\n\n') + '\n';
}
