/**
 * search —— grep（按内容正则搜）/ glob（按文件名 pattern 找）的底层实现。
 *
 * 决策 7 落地：oru 无 ripgrep 依赖，且仓库当前无 electron-builder/asarUnpack 打包配置，
 * 跨平台带 ripgrep 二进制的基建尚不存在。故本期取**退化方案**：
 *   - glob：Node 内建 `fs.globSync`（Node 22+，零依赖）
 *   - grep：自写递归遍历 + RegExp，排除版本控制/依赖目录、跳过二进制与超长行、结果上限护栏；
 *           `.pdf` 走 `pdfText` 抽成带页标记的纯文本再搜（PDF 内容不再是死角）
 * 接口对调用方（grep.ts/glob.ts）后端无感——将来若引入 ripgrep，只换本文件实现即可（系统性）。
 *
 * 适用前提：oru 面向个人文档/项目，非 chromium 级巨树；上限护栏防极端目录拖垮。
 */
import { globSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { extractPdfText } from '../agent/agentTools/pdfText';

const IGNORED_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.DS_Store']);
// PDF 抽取上限：超过就跳过（不让一堆大 PDF 把 grep 拖垮）。个人文档场景 20MB 足够覆盖常规 PDF。
const PDF_MAX_BYTES = 20 * 1024 * 1024;
// 命中片段半径：截断时命中区间两侧各保留这么多字符。单行 deck 里命中（如 class="slide"）后面紧跟标题，
// 留够右侧才能让 agent 透过片段看清"这页讲什么"；业界单行上限落在 ~500，取半径 200（窗口 ≈400）对齐。
const CLIP_RADIUS = 200;
// 展示截断阈值：命中行短于它就原样给，超过才截成片段。用片段窗口（≈2*CLIP_RADIUS）的倍数表达——
// 只有当一行显著长于窗口时，截断才省得了输出又不丢命中上下文。精确值不敏感：真正决定「给多长」的是
// CLIP_RADIUS，这个数只是「截不截」的开关。
const LINE_CLIP_THRESHOLD = CLIP_RADIUS * 8;
export const MAX_FILES_SCANNED = 20000; // 防爆护栏：扫描文件数上限
// 模糊排序里 basename 长度的 tiebreak 权重。跨度是整数、不同跨度至少差 1；权重远小于 1 保证
// 「跨度主导、长度只在同跨度时破平局」这个不变量——常规 basename（<100 字符）贡献恒 <1，绝不越过跨度。
const FUZZY_LENGTH_TIEBREAK = 0.01;

// 截断原因——两种语义截然不同，必须让调用方区分：
//   'head_limit'：命中结果太多，只给前 N 条（缩小搜索即可，结果方向是对的）
//   'scan_cap'  ：目录文件过多，扫到上限就放弃（结果可能整块缺失，得换更小目录重搜）
export type Truncation = false | 'head_limit' | 'scan_cap';

export type GrepMatch = { file: string; line: number; text: string };
export type GrepResult =
  | { mode: 'content'; matches: GrepMatch[]; truncated: Truncation }
  | { mode: 'files_with_matches'; files: string[]; truncated: Truncation }
  | { mode: 'count'; counts: Array<{ file: string; count: number }>; truncated: Truncation };

export type GrepOpts = {
  pattern: string;
  root: string;
  glob?: string; // 文件名过滤如 *.ts（按 basename 匹配）
  ignoreCase?: boolean;
  outputMode: 'content' | 'files_with_matches' | 'count';
  context?: number; // content 模式上下文行数
  headLimit: number;
  maxFilesScanned?: number; // 扫描文件数上限，默认 MAX_FILES_SCANNED（可注入以便测试触发 scan_cap，免造两万文件）
};

/** 按内容正则搜。pattern 非法时由调用方 catch（new RegExp 抛错）。PDF 需异步抽取，故整体 async。 */
export async function grepSearch(opts: GrepOpts): Promise<GrepResult> {
  // g flag 是关键：deck 常被导出成单行 HTML，一行里挤着几十处命中。按行只取首个会让整篇坍缩成 1 条，
  // grep 形同失效（见 search 单测「单行多命中」）。用 g + lastIndex 循环把一行内所有命中逐个吐出。
  // 已知代价（有意接受）：普通源码里「一行内同名多次」（如 foo(); foo()）也会各回一条而非 1 条——
  // 这类行罕见且有 headLimit 兜底，不值得为它退回「每行首个」而打回 deck 单行场景。
  const re = new RegExp(opts.pattern, opts.ignoreCase ? 'gi' : 'g');
  const globRe = opts.glob ? globToBasenameRegExp(opts.glob) : null;
  const ctxN = Math.max(0, opts.context ?? 0);
  const scanCap = opts.maxFilesScanned ?? MAX_FILES_SCANNED;

  const matches: GrepMatch[] = [];
  const filesWithMatches: string[] = [];
  const counts: Array<{ file: string; count: number }> = [];
  let truncated: Truncation = false;
  let scanned = 0;

  outer: for (const file of walkFiles(opts.root)) {
    if (++scanned > scanCap) {
      truncated = 'scan_cap';
      break;
    }
    if (globRe && !globRe.test(basename(file))) continue;

    const content = await readForGrep(file);
    if (content === null) continue; // 读失败 / 二进制 / 超大 PDF / PDF 解析失败——跳过

    const lines = content.split('\n');
    const rel = relative(opts.root, file);

    // files_with_matches：只问"这文件有没有命中"，一处即够，不必逐命中跑。
    if (opts.outputMode === 'files_with_matches') {
      let hit = false;
      for (const line of lines) {
        re.lastIndex = 0;
        if (re.test(line)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        filesWithMatches.push(rel);
        if (filesWithMatches.length >= opts.headLimit) {
          truncated = 'head_limit';
          break;
        }
      }
      continue;
    }

    // content / count：逐行循环出该行**所有**命中（单行 deck 全靠这步把多命中铺开）。
    let fileCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const len = m[0].length;
        if (len === 0) {
          // 零宽命中（如 x* 在空位）：贪婪量词已吞掉真实内容，这里只是尾随空匹配。
          // 推进 lastIndex 防死循环，且不计数——否则超长行上每个空位都计一次会爆量。
          re.lastIndex += 1;
          continue;
        }
        fileCount++;
        if (opts.outputMode === 'content') {
          const hit = clipLine(line, m.index, m.index + len); // 按本次命中区间截片段
          let text: string;
          if (ctxN > 0) {
            const lo = Math.max(0, i - ctxN);
            // 命中行替换成截断后的片段，上下文行原样（它们不含命中，不该按命中点截）
            text = lines.slice(lo, i + ctxN + 1).map((l, k) => (lo + k === i ? hit : l)).join('\n');
          } else {
            text = hit;
          }
          matches.push({ file: rel, line: i + 1, text });
          if (matches.length >= opts.headLimit) {
            truncated = 'head_limit';
            break outer;
          }
        }
      }
    }
    if (opts.outputMode === 'count' && fileCount > 0) {
      counts.push({ file: rel, count: fileCount });
      if (counts.length >= opts.headLimit) {
        truncated = 'head_limit';
        break;
      }
    }
  }

  if (opts.outputMode === 'content') return { mode: 'content', matches, truncated };
  if (opts.outputMode === 'count') return { mode: 'count', counts, truncated };
  return { mode: 'files_with_matches', files: filesWithMatches, truncated };
}

export type GlobResult = { files: string[]; truncated: boolean; fuzzy: boolean };

/**
 * 按文件名找文件，相对 root、最近改的在前。两档，自动降级：
 *   1. 精确 glob（globSync）。命中 > 0 → 返回精确结果（fuzzy=false），零噪音，行为同旧版。
 *   2. 精确零命中 → 子序列模糊兜底（fuzzy=true）：把 pattern 的实义字符当子序列匹配 basename，
 *      按接近度排序，最像的在前。
 * 为何降级而非直接返回空：搜不到多半是没记全确切名字，给最接近的候选比给空有用得多。但
 * "这是不是要找的目标"是语义判断，工具不猜——只把候选摊开并**标明 fuzzy**，由调用方甄别。
 */
export function globSearch(pattern: string, root: string, limit: number): GlobResult {
  const exact = exactGlobSearch(pattern, root, limit);
  if (exact.files.length > 0) return { ...exact, fuzzy: false };
  return { ...fuzzyGlobSearch(pattern, root, limit), fuzzy: true };
}

/** 精确 glob：Node globSync + 排除依赖目录 + symlink 越界校验 + mtime 倒序。 */
function exactGlobSearch(pattern: string, root: string, limit: number): { files: string[]; truncated: boolean } {
  let hits: string[];
  try {
    hits = globSync(pattern, { cwd: root }) as string[];
  } catch {
    hits = [];
  }
  // 排除版本控制/依赖目录的命中
  hits = hits.filter((p) => !p.split(sep).some((seg) => IGNORED_DIRS.has(seg)));

  // 防 symlink 越界：globSync 默认跟随符号链接，沙箱内 symlink 指向外部时会返回外部路径——
  // 用 realpath 校验每个命中仍在 root 实路径之下，逃逸的丢弃（不泄露沙箱外路径）。
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }

  const withMtime: Array<{ p: string; mtime: number }> = [];
  for (const p of hits) {
    try {
      const full = join(root, p);
      const real = realpathSync(full);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) continue; // 逃逸沙箱，丢弃
      const st = statSync(full);
      if (st.isFile()) withMtime.push({ p, mtime: st.mtimeMs });
    } catch {
      // stat/realpath 失败（断链等）——跳过
    }
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);

  const truncated = withMtime.length > limit;
  return { files: withMtime.slice(0, limit).map((x) => x.p), truncated };
}

/**
 * 子序列模糊：pattern 去掉 glob 元字符后的实义字符作为子序列，大小写不敏感匹配每个文件 basename。
 * 排序：接近度（子序列命中的首末跨度越紧凑越像）为主，basename 越短、改得越近做 tiebreak。
 * 走 walkFiles（不跟随 symlink，天然不越界），受 MAX_FILES_SCANNED 护栏。pattern 全是通配符
 * （实义字符为空，如 ** 之类纯通配）时无从模糊，返回空。
 */
function fuzzyGlobSearch(pattern: string, root: string, limit: number): { files: string[]; truncated: boolean } {
  const needle = pattern.replace(/[*?{}[\]\\/,]/g, '');
  if (needle.length === 0) return { files: [], truncated: false };

  const scored: Array<{ p: string; score: number; mtime: number }> = [];
  let scanned = 0;
  for (const file of walkFiles(root)) {
    if (++scanned > MAX_FILES_SCANNED) break;
    const score = subsequenceScore(needle, basename(file));
    if (score === null) continue; // 子序列没配全，不是候选
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      // stat 失败——mtime 记 0，排最后
    }
    scored.push({ p: relative(root, file), score, mtime });
  }
  scored.sort((a, b) => a.score - b.score || b.mtime - a.mtime); // 越像越前，同像度按最近改

  const truncated = scored.length > limit;
  return { files: scored.slice(0, limit).map((x) => x.p), truncated };
}

/**
 * needle 是否为 hay 的子序列；是则回"接近度分"（越小越像），否则 null。
 * 分 = 命中首末字符的跨度 + basename 长度 * FUZZY_LENGTH_TIEBREAK（跨度主导：字符挨得越近越像；同跨度短名优先）。
 */
function subsequenceScore(needle: string, hay: string): number | null {
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  let hi = 0;
  let first = -1;
  let last = -1;
  for (const c of n) {
    let found = -1;
    while (hi < h.length) {
      const same = h[hi] === c;
      hi += 1;
      if (same) {
        found = hi - 1;
        break;
      }
    }
    if (found < 0) return null;
    if (first < 0) first = found;
    last = found;
  }
  return last - first + 1 + h.length * FUZZY_LENGTH_TIEBREAK;
}

/** 递归遍历 root 下所有普通文件，跳过版本控制/依赖目录，不跟随 symlink。 */
function* walkFiles(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        yield join(dir, e.name);
      }
      // symlink 等不跟随
    }
  }
}

/**
 * 超长行（单行大 HTML / minified）展示截断：只对命中行用，按主循环已 exec 出的命中区间 [from,to)
 * 两端各留 CLIP_RADIUS，保证完整命中词落在片段内（长匹配也不切断）。短行原样返回。
 * 命中位置由调用方传入，clipLine 不重新匹配、不持有正则状态。
 */
function clipLine(line: string, from: number, to: number): string {
  if (line.length <= LINE_CLIP_THRESHOLD) return line;
  const start = Math.max(0, from - CLIP_RADIUS);
  const end = Math.min(line.length, to + CLIP_RADIUS);
  return (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
}

/**
 * 把一个文件读成可被正则搜的文本，不可搜就回 null（调用方 continue 跳过）：
 *   - `.pdf`：超过 PDF_MAX_BYTES 跳过（防一堆大 PDF 拖垮）；否则 pdfText 抽成带页标记的纯文本。
 *     解析失败（加密 / 损坏 / 非标准）不整趟中断，只跳过这一份。
 *   - 其余：按字节读，首 8KB 含 NUL 视作二进制跳过（PDF 之外的二进制仍走这条）。
 * 单份 PDF 抽取会打开并 destroy 各自的 pdfjs 实例；grep 一趟连抽多份也互不影响（见 pdfGrep 回归）。
 */
async function readForGrep(file: string): Promise<string | null> {
  if (extname(file).toLowerCase() === '.pdf') {
    try {
      if (statSync(file).size > PDF_MAX_BYTES) return null;
      return await extractPdfText(file);
    } catch {
      return null;
    }
  }
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return null;
  }
  if (isBinary(buf)) return null;
  return buf.toString('utf-8');
}

/** 二进制探测：首 8KB 含 NUL 字节即视为二进制，跳过。 */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 把文件名 glob（*.ts / *.{ts,tsx} / data?.json）转成 basename 匹配的 RegExp。 */
function globToBasenameRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else if ('.+^$()[]\\|'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
