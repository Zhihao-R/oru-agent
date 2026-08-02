/**
 * i18n 抽取批次验证（第 2 期每批通用）——把"中文界面零回退"变成可机检的两条不变量：
 *
 *   ① 键存在：组件里引用的每个静态 t('ns:key' / 'key') 都能在 zh 资源里解析到值
 *      （否则界面会渲染出裸 key 字符串 = 可见变化）。动态键 t(`a.${x}`) 只能人工核，单独列出。
 *   ② 零回退：本批 git diff 里**移除**的每个中文串字面量，都原样出现在 zh 资源的某个值里
 *      （证明字符串是"搬运"而非"改写"——这是中文零回退最硬的一条）。
 *
 * 用法：node scripts/i18nVerifyBatch.mjs <file.tsx> [file2.tsx ...]
 * 退出码非 0 表示有未覆盖项，CI / 提交前自查用。
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法：node scripts/i18nVerifyBatch.mjs <file.tsx> [...]');
  process.exit(2);
}

// ── 载入全部 zh 资源，扁平化成 value 集合 + 按 "ns:点路径" 可查 ──
const localesDir = 'locales/zh';
const flatByKey = new Map(); // "ns:a.b" -> value
const allValues = new Set(); // 全部字符串叶子值（含数组元素）
for (const f of readdirSync(localesDir)) {
  if (!f.endsWith('.json')) continue;
  const nsName = f.replace(/\.json$/, '');
  const obj = JSON.parse(readFileSync(join(localesDir, f), 'utf8'));
  const walk = (node, path) => {
    if (typeof node === 'string') {
      flatByKey.set(`${nsName}:${path}`, node);
      allValues.add(node);
    } else if (Array.isArray(node)) {
      node.forEach((v) => typeof v === 'string' && allValues.add(v));
      flatByKey.set(`${nsName}:${path}`, node);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(obj, '');
}

const hasChinese = (s) => /[一-鿿]/.test(s);
// 迭代剥掉模板插值——从最内层 ${...}（内无花括号）逐层往外，处理嵌套模板字面量。
// 刻意保留反引号：它在下游分段里当字符串边界（去掉会把 return/; 等代码卷进片段）。
const stripTemplates = (s) => {
  let prev;
  do {
    prev = s;
    s = s.replace(/\$\{[^{}]*\}/g, ' ');
  } while (s !== prev);
  return s;
};
// 剥两种插值（i18next {{x}} 与模板 ${x}）并归一空白，让"搬运前后"可比。
// 源码里是字面 "\n"（反斜杠+n），JSON 解析出的是真实换行——都当空白处理，两侧才可比。
const norm = (s) =>
  stripTemplates(s.replace(/\{\{[^}]+\}\}/g, ' '))
    .replace(/\\[nt]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const normalizedValues = new Set([...allValues].map(norm));

let problems = 0;
const dynamicKeys = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');

  // ── 检查 ①：静态 t() 键存在 ──
  // 文件自带 useTranslation('ns')（可能多处，不同组件绑不同 ns）→ 无前缀键按任一绑定 ns 查；
  // 无（如接收 t 作参数的 helper）→ 跨所有 ns 查存在性（t 由调用方按某 ns 绑定传入，落在哪个 ns 这里无从得知）。
  const boundNs = [...src.matchAll(/useTranslation\(['"]([^'"]+)['"]\)/g)].map((x) => x[1]);
  const tCall = /\bt\(\s*(['"`])([^'"`]+)\1/g;
  let m;
  while ((m = tCall.exec(src))) {
    const raw = m[2];
    if (m[1] === '`' || raw.includes('${')) {
      dynamicKeys.push(`${file}: t(\`${raw}\`)`);
      continue;
    }
    let exists;
    if (raw.includes(':')) exists = flatByKey.has(raw);
    else if (boundNs.length) exists = boundNs.some((ns) => flatByKey.has(`${ns}:${raw}`));
    else exists = [...flatByKey.keys()].some((k) => k.endsWith(`:${raw}`));
    if (!exists) {
      console.error(`✗ 键缺失：${file} 引用 t('${raw}')，zh 资源里不存在`);
      problems++;
    }
  }

  // ── 检查 ②：本批移除的中文串都在 zh 值里 ──
  let diff = '';
  try {
    diff = execSync(`git diff HEAD -- "${file}"`, { encoding: 'utf8' });
  } catch {
    /* 文件可能是新增/已提交，跳过 diff 检查 */
  }
  for (const line of diff.split('\n')) {
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    const rawBody = line.slice(1);
    const trimmed = rawBody.trim();
    // 跳过注释行（注释中文不翻）
    if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed) || trimmed.startsWith('*/')) continue;
    // 剥行尾 // 注释（注释中文不翻；但避免误剥 http:// 等——只在前面有空白或行首时剥）
    const noComment = rawBody.replace(/(^|\s)\/\/.*$/, '$1');
    if (!hasChinese(noComment)) continue;
    // 先剥模板插值（含嵌套），再按引号/标签边界切片，避免在 ${...} 处截断留下悬空片段
    const body = stripTemplates(noComment);
    const segs = body.match(/[^'"`<>{}\n]*[一-鿿][^'"`<>{}\n]*/g) || [];
    for (const seg of segs) {
      const needle = norm(seg);
      if (!needle || !hasChinese(needle)) continue;
      // 单向：zh 资源值必须**完整包含**被移除片段——贴合"搬运非改写"判据。
      // （刻意不用 needle.includes(v) 反向：那样只要资源里有个短值是片段子串就放行，会让改写冒充搬运。）
      const found = [...normalizedValues].some((v) => v.includes(needle));
      if (!found) {
        console.error(`✗ 零回退存疑：${file} 移除的中文片段「${seg.trim()}」未在 zh 资源值中找到`);
        problems++;
      }
    }
  }
}

if (dynamicKeys.length) {
  console.log('\n⚠ 动态 t() 键（需人工核对各分支键都在 zh 资源里）：');
  dynamicKeys.forEach((k) => console.log('  ' + k));
}

if (problems === 0) {
  console.log(`\n✓ 校验通过：${files.length} 个文件，所有静态键存在、移除的中文片段均在 zh 资源中`);
  process.exit(0);
} else {
  console.error(`\n✗ 发现 ${problems} 处问题`);
  process.exit(1);
}
