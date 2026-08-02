/**
 * glob AgentTool（只读）—— 按文件名 pattern 找文件，返回相对路径列表（按修改时间倒序）。
 */
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { globSearch } from '../../fs/search';
import { assertReadableSandbox, defaultSearchRoot, SandboxError } from './pathSandbox';

const LIMIT = 100;

const TOOL_DESC = `按文件名 pattern 找文件，返回匹配的文件路径（最近修改的在前）。只读、零确认。

**该用**：用户问"把所有 markdown 列出来""找找叫 xxx 的文件"；按扩展名/名字模式批量定位文件。

入参：
- pattern（必填）：文件名 glob，如 **/*.md、src/**/*.ts、*.txt。
- path（可选）：搜索根绝对路径，须在允许范围内；不填默认 active 项目根或 agent 沙盒。

**精确无匹配时自动降级模糊**：把 pattern 里的实义字符当子序列匹配文件名（"dck" 命中 "deck-export.ts"），
按接近度返回候选并标注"模糊"——记不全确切名字时直接搜个大概即可，不必先试精确再改。模糊结果需自行
甄别是否为目标（工具只按名字接近度排，不判断语义）。

自动排除 .git/node_modules 等。结果上限 ${LIMIT}，超出会截断并标注。`;

export function makeGlobTool(): AgentTool {
  return {
    name: 'glob',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名 glob，如 **/*.md' },
        path: { type: 'string', description: '搜索根绝对路径；不填用默认根' },
      },
      required: ['pattern'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const args = (input ?? {}) as { pattern?: string; path?: string };
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
        return { isError: true, text: 'glob: pattern 不能为空' };
      }

      let root = args.path;
      if (root !== undefined) {
        try {
          await assertReadableSandbox(root, ctx);
        } catch (e) {
          if (e instanceof SandboxError) return { isError: true, text: `glob: ${e.message}` };
          throw e;
        }
      } else {
        const def = await defaultSearchRoot(ctx);
        if (!def) return { isError: true, text: 'glob: 没有可搜的默认目录，请显式传 path' };
        root = def;
      }

      const { files, truncated, fuzzy } = globSearch(args.pattern, root, LIMIT);
      if (files.length === 0) return { text: `glob: 无匹配（pattern=${args.pattern}）` };
      let text = files.join('\n');
      if (fuzzy) {
        // 精确无果、自动降级来的候选——明确标出，让调用方甄别哪个（若有）才是要找的目标
        text = `（精确无匹配，以下按名字接近度模糊列出，最像的在前——需自行判断是否为目标）\n${text}`;
      }
      if (truncated) text += `\n… 结果已截断（超过上限 ${LIMIT}）`;
      return { text, structured: { count: files.length, truncated, fuzzy } };
    },
  };
}
