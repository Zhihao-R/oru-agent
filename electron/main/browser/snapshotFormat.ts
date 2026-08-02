/**
 * a11y 快照格式化（S33 浏览器操控 · §6）—— CDP Accessibility.getFullAXTree 的原始节点
 * 压成带 uid 的层级文本。纯函数：不碰 CDP、不持会话，uid 只在单次快照内有意义，
 * uid → backendDOMNodeId 的映射交由 BrowserSession 持有（点按 / 输入按它定位元素）。
 *
 * 行格式 `- role "name" value="v" (checked, disabled) [uid=N]`——value 与非默认状态
 * （checked/disabled/expanded…）是操作承重信息：比价要知道勾没勾、填完要能读回验证，
 * 省掉它们模型只能盲试错、反而更费 token。
 *
 * 剪枝口径：ignored 与无名 generic/none 容器折叠（子节点上提），InlineTextBox/LineBreak
 * 整支剪掉，与父同名的 StaticText 叶子折叠（<button>提交</button> 不占两行）——这些是
 * 渲染细节，对「模型读页面结构」只有噪音。
 *
 * 封顶 + offset 续读是防上下文溢出的承重闸：AX 全树与滚动无关（滚动拿不到树的后半段），
 * 截断部分的唯一续读通道是 offset 分页（对齐 read_file 的 offset 范式）。uid 按全树分配、
 * 与窗口无关——同一棵树任意窗口里的 uid 指同一个元素。阈值初值定性正确（长页 a11y 树可达
 * MB 级），具体待观察真实页面再调。
 */

/** CDP Accessibility.getFullAXTree 返回的节点（只取本层用到的字段） */
export type AXNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
  backendDOMNodeId?: number;
  parentId?: string;
  childIds?: string[];
};

export type SnapshotFormatResult = {
  /** 本窗口的层级文本：一行一节点，两空格缩进 */
  text: string;
  /** uid → backendDOMNodeId（全树分配，仅本次快照内有效） */
  uidToBackendNodeId: Map<number, number>;
  /** 本窗口之后还有未返回的行 */
  truncated: boolean;
  /** 全树总行数（剪枝后） */
  totalLines: number;
  /** 截断时的续读起点（1-based 行号）；未截断为 undefined */
  nextOffset?: number;
};

const DEFAULT_MAX_LINES = 1000;
const DEFAULT_MAX_BYTES = 64 * 1024;
/** value 展示上限：textarea 可能塞整篇文章，快照只需可辨认 */
const VALUE_CHAR_LIMIT = 200;

/** 整支剪掉：纯渲染细节，无结构信息。（role 值大小写依 Blink 实际返回：驼峰） */
const DROP_ROLES = new Set(['InlineTextBox', 'LineBreak']);
/** 无名时折叠（子节点上提）：布局容器，占行不供信息 */
const COLLAPSE_ROLES = new Set(['generic', 'none', 'GenericContainer']);
/** 非默认才输出的状态位：操作承重（disabled 的按钮点不动、checked 决定要不要再点） */
const STATE_PROPS = new Set(['checked', 'selected', 'expanded', 'pressed', 'disabled']);

export function formatAxTree(
  nodes: AXNode[],
  opts?: { maxLines?: number; maxBytes?: number; offset?: number },
): SnapshotFormatResult {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const offset = opts?.offset ?? 1;
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => n.parentId === undefined) ?? nodes[0];

  // 先走全树出全部行与 uid（uid 与窗口无关），再切窗口——树有封顶数量级（页面级），全量可承受
  const lines: string[] = [];
  const uidToBackendNodeId = new Map<number, number>();
  let nextUid = 1;
  const visited = new Set<string>(); // 防畸形 childIds 成环挂死主进程

  const emit = (n: AXNode, depth: number, parentName: string): void => {
    if (visited.has(n.nodeId)) return;
    visited.add(n.nodeId);
    const role = n.role?.value ?? '';
    if (DROP_ROLES.has(role)) return;

    const name = flatten(n.name?.value ?? '');
    // 与父同名的 StaticText 叶子折叠：按钮/链接的文字已在父行，不再占一行
    if (role === 'StaticText' && name !== '' && name === parentName) return;
    const collapse = n.ignored === true || (COLLAPSE_ROLES.has(role) && name === '');
    let childDepth = depth;
    let childParentName = parentName;
    if (!collapse) {
      let line = `${'  '.repeat(depth)}- ${role}`;
      if (name !== '') line += ` "${name}"`;
      const value = flatten(typeof n.value?.value === 'string' || typeof n.value?.value === 'number' ? String(n.value.value) : '');
      if (value !== '') line += ` value="${truncateChars(value, VALUE_CHAR_LIMIT)}"`;
      const states = (n.properties ?? [])
        .filter((p) => STATE_PROPS.has(p.name) && isNonDefault(p.value.value))
        .map((p) => (p.value.value === true || p.value.value === 'true' ? p.name : `${p.name}=${p.value.value}`));
      if (states.length > 0) line += ` (${states.join(', ')})`;
      if (n.backendDOMNodeId !== undefined) {
        uidToBackendNodeId.set(nextUid, n.backendDOMNodeId);
        line += ` [uid=${nextUid}]`;
        nextUid += 1;
      }
      lines.push(line);
      childDepth = depth + 1;
      childParentName = name;
    }
    for (const id of n.childIds ?? []) {
      const child = byId.get(id);
      if (child) emit(child, childDepth, childParentName);
    }
  };

  if (root) emit(root, 0, '');

  // 切窗口：从 offset 行起，行数与字节双封顶
  const start = Math.max(0, offset - 1);
  const windowLines: string[] = [];
  let bytes = 0;
  for (let i = start; i < lines.length && windowLines.length < maxLines; i += 1) {
    bytes += Buffer.byteLength(lines[i], 'utf-8') + 1;
    if (bytes > maxBytes) break;
    windowLines.push(lines[i]);
  }
  const end = start + windowLines.length;
  const truncated = end < lines.length;
  return {
    text: windowLines.join('\n'),
    uidToBackendNodeId,
    truncated,
    totalLines: lines.length,
    nextOffset: truncated ? end + 1 : undefined,
  };
}

function flatten(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim();
}

function truncateChars(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** 状态位非默认才算：false/'false'/undefined 是默认态，不输出 */
function isNonDefault(v: unknown): boolean {
  return v !== undefined && v !== false && v !== 'false' && v !== null && v !== '';
}
