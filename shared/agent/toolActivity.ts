/**
 * subagent 运行态卡底行"当前在干什么"的工具翻译层。
 *
 * 两条派工链路（后台 task 的 tasks/stream.ts、对话期 subagent 的 subagentChat/runner.ts）
 * 共用一套：后端用 `toolObject` 从工具 input 里挑出"宾语"字段一起 emit；前端用
 * `toolActivityText` 把 {工具名, 宾语} 翻成人话（"改 captureScheduler.ts"），不露工具代号。
 *
 * 系统性：工具 → (宾语字段, 动词) 只在 TOOL_SPECS 这一张表里定义，加一种工具就加一行。
 */
import { normalizeToolName } from './toolName';


const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** 取路径最后一段，不依赖 node path（前后端共用） */
const basename = (p?: string): string | undefined =>
  p ? p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || undefined : undefined;

/** 取 url 的 host，失败则原样截短 */
const host = (u?: string): string | undefined => {
  if (!u) return undefined;
  try {
    return new URL(u).host;
  } catch {
    return shorten(u, 32);
  }
};

/** 命令首词（npm / git / …），够表达"在跑什么"又不刷屏 */
const firstWord = (c?: string): string | undefined => {
  const t = c?.trim();
  return t ? shorten(t.split(/\s+/)[0], 24) : undefined;
};

type ToolSpec = {
  /** 从 input 挑"宾语"——缺省 / 取不到则底行只有动词 */
  object?: (input: Record<string, unknown>) => string | undefined;
  /** 人话动词的 i18n key（chat:toolActivity.<verbKey> / <verbKey>Bare）——文案随界面语言。 */
  verbKey: string;
};

const TOOL_SPECS: Record<string, ToolSpec> = {
  Edit: { object: (i) => basename(str(i.file_path)), verbKey: 'edit' },
  MultiEdit: { object: (i) => basename(str(i.file_path)), verbKey: 'edit' },
  Write: { object: (i) => basename(str(i.file_path)), verbKey: 'write' },
  Read: { object: (i) => basename(str(i.file_path)), verbKey: 'read' },
  NotebookEdit: { object: (i) => basename(str(i.notebook_path)), verbKey: 'edit' },
  Grep: { object: (i) => str(i.pattern), verbKey: 'search' },
  Glob: { object: (i) => str(i.pattern), verbKey: 'find' },
  Bash: { object: (i) => firstWord(str(i.command)), verbKey: 'run' },
  WebFetch: { object: (i) => host(str(i.url)), verbKey: 'readUrl' },
  WebSearch: { object: (i) => str(i.query), verbKey: 'search' },
};

/** 截短到 max 字符（…结尾），单行化 */
export function shorten(text: string, max = 80): string {
  const oneline = text.replace(/\s+/g, ' ').trim();
  return oneline.length > max ? oneline.slice(0, max - 3) + '...' : oneline;
}

/** 后端：从工具 input 挑出"宾语"字段（白名单，不外传整个 input） */
export function toolObject(toolName: string, input: unknown): string | undefined {
  const spec = TOOL_SPECS[normalizeToolName(toolName)];
  if (!spec?.object || typeof input !== 'object' || input === null) return undefined;
  return spec.object(input as Record<string, unknown>);
}

/**
 * 前端：{工具名, 宾语} → 一句人话动作；未知工具不露代号，给通用兜底。
 * 文案随界面语言——调用方传 i18next 的 t（绑任意 ns，键用 `chat:` 前缀自解析）。
 */
export function toolActivityText(
  toolName: string,
  object: string | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const spec = TOOL_SPECS[normalizeToolName(toolName)];
  if (!spec) return t('chat:toolActivity.processing');
  return object
    ? t(`chat:toolActivity.${spec.verbKey}`, { object })
    : t(`chat:toolActivity.${spec.verbKey}Bare`);
}
