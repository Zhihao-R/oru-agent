/**
 * 硬编码中文（CJK）守卫扫描器——抓"该走 i18n 却没走"的裸中文字符串。
 *
 * 现有 key-alignment 门槛只管"locales 里已有键的 en 覆盖"，抓不到"中文从没抽进 i18n"
 * （describeFrequency / toolActivity 漏过半年就是这类）。本扫描器补这道：
 *   剥注释（块/行/JSX）→ 剥 console.* 诊断行 → 剩余 CJK = 字符串字面量（display/data）。
 *
 * scope：src/**（渲染层，几乎全是 UI）+ shared/**（被两端复用的 formatter / 类型）。
 *   electron/main 不扫——那里 prompt（喂 AI 类③）/日志/诊断占绝大多数，信噪比太低，
 *   其真·用户文案靠 Phase 4 式人工甄别（见 docs/tech/2026-06-24-language-switch-tech-design.md）。
 *
 * 豁免（显式）：合法中文（数据哨兵 / 枚举值 / 固定语言标识）在行内或上一行加
 *   `i18n-exempt` 标记（任意注释里含该词即可），并写明缘由。
 *
 * 用法：node scripts/i18n/scanHardcodedCjk.mjs        列出全部违规（合并适配清单生成器）
 *   被 tests/i18n/noHardcodedCjk.test.ts 复用做 CI 门槛（对账 baseline）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCAN_DIRS = ['src', 'shared'];
const EXT = /\.(ts|tsx)$/;
const SKIP = /(\.test\.|\.spec\.|\.d\.ts$)/;
const CJK = /[一-鿿㐀-䶿]/;
const EXEMPT = /i18n-exempt/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === 'node_modules') continue;
      walk(p, out);
    } else if (EXT.test(name) && !SKIP.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** 剥行注释（// …），尊重字符串引号——不误剥字符串里的 //。块注释已在 stripBlock 全局剥过。 */
function stripLineComment(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** 把块注释 / JSX 注释整体替成等长空白（保留行号），再逐行剥行注释。 */
function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.split('\n').map(stripLineComment);
}

export function scanFile(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const rawLines = raw.split('\n');
  const codeLines = stripComments(raw);
  const hits = [];
  for (let i = 0; i < codeLines.length; i++) {
    const code = codeLines[i];
    if (!CJK.test(code)) continue; // 注释里的中文已被剥掉，剩下的 CJK 在字符串字面量里
    if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(code)) continue; // 诊断日志，非 UI
    if (EXEMPT.test(rawLines[i]) || (i > 0 && EXEMPT.test(rawLines[i - 1]))) continue; // 显式豁免
    hits.push({ line: i + 1, text: rawLines[i].trim() });
  }
  return hits;
}

/** 全量扫描，返回 { 'rel/path': [{line,text}] }。 */
export function scanAll() {
  const result = {};
  for (const d of SCAN_DIRS) {
    for (const f of walk(join(ROOT, d))) {
      const hits = scanFile(f);
      if (hits.length) result[relative(ROOT, f)] = hits;
    }
  }
  return result;
}

/**
 * 扁平化成稳定 key（`相对路径去空白文本`）——baseline 对账用。刻意不带行号：
 * 行号随编辑漂移，按"文件+文本"判定即可（同文本多处算一项，棘轮不计数只计存在）。
 */
export function flatKeys(all = scanAll()) {
  const keys = new Set();
  for (const f of Object.keys(all)) for (const h of all[f]) keys.add(`${f}${h.text}`);
  return [...keys].sort();
}

// 直接运行：打印清单（合并后即待 i18n 适配清单）；--write-baseline 刷新基线棘轮。
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const { writeFileSync } = await import('node:fs');
    const out = join(ROOT, 'tests/i18n/cjk-baseline.json');
    writeFileSync(out, JSON.stringify(flatKeys(), null, 0) + '\n');
    console.log(`baseline 写入 ${relative(ROOT, out)}：${flatKeys().length} 项`);
  } else {
    const all = scanAll();
    const files = Object.keys(all).sort();
    let total = 0;
    for (const f of files) {
      console.log(`\n${f}`);
      for (const h of all[f]) {
        console.log(`  ${h.line}: ${h.text}`);
        total++;
      }
    }
    console.log(`\n— 共 ${total} 处硬编码中文，分布 ${files.length} 个文件 —`);
  }
}
