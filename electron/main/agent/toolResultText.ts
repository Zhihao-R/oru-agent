/**
 * 把工具结果 content（可能是字符串或 MCP content block 数组）转成给 UI/历史用的纯文本。
 *
 * 关键：带 image 的工具结果（render_html 截图 / image_search 缩略图）回流时把 base64 字节
 * 也带在 content 数组里——绝不 JSON.stringify 进文本，否则几 MB base64 灌爆 JSONL 历史/sidecar。
 * 图本身走 MCP image content 喂模型（不靠这段文本），这里只留一个 [image] 占位。
 *
 * stream.ts（主对话）与 subagentChat/runner.ts（对话期子 agent sidecar）共用，避免两处各写一份
 * 漏掉 image 剥离（系统性一致）。
 */
export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (typeof c === 'object' && c !== null) {
          const obj = c as { type?: string; text?: string };
          if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
          if (obj.type === 'image') return '[image]';
        }
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (content === null || content === undefined) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
