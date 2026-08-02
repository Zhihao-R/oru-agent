/**
 * grep AgentTool（只读）—— 在目录下按内容正则搜文件，返回结构化"文件:行:匹配"列表。
 *
 * 为何专门做而非靠 bash grep（决策：高频 + 只读零确认 + 结构化结果）。
 */
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { grepSearch, MAX_FILES_SCANNED } from '../../fs/search';
import { assertReadableSandbox, defaultSearchRoot, SandboxError } from './pathSandbox';

const DEFAULT_HEAD_LIMIT = 250;

const TOOL_DESC = `在一个目录下按内容（正则）搜文件，返回哪些文件、哪几行命中。只读、零确认。

**该用**：用户问"哪个文件里提到了 X"；定位某段文字/某个符号在哪。比 read_file 一个个翻文件高效得多。

入参：
- pattern（必填）：正则表达式。
- path（可选）：搜索目录绝对路径，须在允许范围内；不填默认 active 项目根或 agent 沙盒。
- glob（可选）：文件名过滤如 *.ts、*.{md,txt}。
- output_mode（可选）：files_with_matches（默认，只列命中文件）/ content（列每条命中行）/ count（每文件命中数）。
- -i（可选）：忽略大小写。
- -n（可选，默认 true）：content 模式下命中行是否带行号。
- context（可选）：content 模式下每条命中额外显示的上下文行数（其它模式忽略）。
- head_limit（可选，默认 ${DEFAULT_HEAD_LIMIT}）：结果上限。

自动排除 .git/node_modules 等，跳过二进制文件；PDF 会抽成文本参与搜索（命中带页标记）。超长行（如单行大 HTML）照常匹配，content 模式只回命中片段。
注意：目录过大（扫描超 ${MAX_FILES_SCANNED} 个文件）会停止并标注"结果可能不全"——此时请缩小 path 或加 glob 重搜，别当成搜全了。`;

export function makeGrepTool(): AgentTool {
  return {
    name: 'grep',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（必填）' },
        path: { type: 'string', description: '搜索目录绝对路径；不填用默认根' },
        glob: { type: 'string', description: '文件名过滤如 *.ts' },
        output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: '输出模式' },
        '-i': { type: 'boolean', description: '忽略大小写' },
        '-n': { type: 'boolean', description: 'content 模式是否带行号（默认 true）' },
        context: { type: 'number', description: 'content 模式上下文行数' },
        head_limit: { type: 'number', description: `结果上限（默认 ${DEFAULT_HEAD_LIMIT}）` },
      },
      required: ['pattern'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const args = (input ?? {}) as {
        pattern?: string;
        path?: string;
        glob?: string;
        output_mode?: 'content' | 'files_with_matches' | 'count';
        '-i'?: boolean;
        '-n'?: boolean;
        context?: number;
        head_limit?: number;
      };
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
        return { isError: true, text: 'grep: pattern 不能为空' };
      }

      let root = args.path;
      if (root !== undefined) {
        try {
          await assertReadableSandbox(root, ctx);
        } catch (e) {
          if (e instanceof SandboxError) return { isError: true, text: `grep: ${e.message}` };
          throw e;
        }
      } else {
        const def = await defaultSearchRoot(ctx);
        if (!def) return { isError: true, text: 'grep: 没有可搜的默认目录（无 active 项目、无 agent 沙盒），请显式传 path' };
        root = def;
      }

      const outputMode = args.output_mode ?? 'files_with_matches';
      const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;

      let result;
      try {
        result = await grepSearch({
          pattern: args.pattern,
          root,
          glob: args.glob,
          ignoreCase: args['-i'] ?? false,
          outputMode,
          context: args.context,
          headLimit,
        });
      } catch (e) {
        return { isError: true, text: `grep: 正则非法或搜索失败：${e instanceof Error ? e.message : String(e)}` };
      }

      const withLineNo = args['-n'] ?? true;
      let text: string;
      if (result.mode === 'content') {
        if (result.matches.length === 0) return { text: `grep: 无匹配（pattern=${args.pattern}）` };
        text = result.matches.map((m) => (withLineNo ? `${m.file}:${m.line}:${m.text}` : `${m.file}:${m.text}`)).join('\n');
      } else if (result.mode === 'count') {
        if (result.counts.length === 0) return { text: `grep: 无匹配（pattern=${args.pattern}）` };
        text = result.counts.map((c) => `${c.file}: ${c.count}`).join('\n');
      } else {
        if (result.files.length === 0) return { text: `grep: 无匹配（pattern=${args.pattern}）` };
        text = result.files.join('\n');
      }
      if (result.truncated === 'scan_cap') {
        text += `\n… 目录过大，已扫描前 ${MAX_FILES_SCANNED} 个文件后停止，结果可能不全（请缩小 path 或加 glob 过滤后重搜）`;
      } else if (result.truncated === 'head_limit') {
        text += `\n… 结果已截断（命中超过上限 ${headLimit}，可缩小搜索范围）`;
      }

      return {
        text,
        structured: {
          mode: result.mode,
          truncated: result.truncated !== false,
          truncatedReason: result.truncated === false ? undefined : result.truncated,
        },
      };
    },
  };
}
