/**
 * bashCommand —— 命令拆分 + 破坏性判定（本期最重、风险最高的安全核心）。
 *
 * 判定默认方向 = **证明安全，看不透就判破坏性**（tech design 决策 6.3）。这纠正一个反直觉
 * 但致命的陷阱：claude code 的 BashTool 默认"拆段→看前缀→没匹配破坏性 pattern 就算安全"，
 * 背后有 20+ 校验器 + "开发者盯着终端"兜底。oru 是无审批助手、没人盯，照搬会让大量静态
 * 看不透的命令形态被误判安全而静默执行。故采用反向默认：举证责任在"证明安全"。
 *
 * 分层（第 0 层最先判、最关键）：
 *   0. 保守兜底：含任何无法可靠静态分析的结构（后台&/子shell/命令替换/eval/sh -c/
 *      xargs/find -exec|-delete/env 包装/ANSI-C/$IFS/未配对引号）→ 整条直接破坏，不再细究。
 *   1. splitCommand：仅当无第 0 层结构时，按 换行/;/&&/||/管道 拆段（引号内不拆，逐段判定）。
 *   2. 每段：剥包装(timeout/nice/nohup/stdbuf)+前导 env var → 取基命令 → 查破坏性 pattern。
 *   3. 路径硬防线：rm/mv 目标（相对路径按 cwd 解析成绝对）命中关键系统路径 → 强化告警。
 *
 * 已知风险（显式接受，tech 6.7）：黑名单防不死"形态普通却语义危险"的长尾；以"宁可错判破坏性、
 * 不放过"贯穿——兜底层 + pattern 持续补充，而非假装风险不存在。
 */
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DeliveryTarget } from '@shared/types';

// opaque：第 0 层兜底判定——整条「看不透」（含子shell/命令替换/eval 等无法静态分析的结构）。
// 卡片据此区分文案：opaque 段统一显示「危险命令」；非 opaque 的具体危险段显示具体 reason。
// delivery：对外投递识别（S04 投递档）——与破坏性两轴正交，一段可同时命中。
export type BashSegment = {
  text: string;
  destructive: boolean;
  reason?: string;
  opaque?: boolean;
  delivery?: { channel: string; recipient: string | null; addresses: string[] };
};
export type BashAnalysis = { isDestructive: boolean; segments: BashSegment[] };

/**
 * 破坏性 pattern 单一常量（文档不另列第二份，避免漂移）。在每段的「去引号骨架」上匹配。
 * 写/删/覆盖归破坏性（决策 6.4：与文件守卫同安全水位，堵 bash 绕过文件保护）。
 */
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // 删除
  { re: /\brm\b/, reason: 'rm 删除文件' },
  { re: /\brmdir\b/, reason: 'rmdir 删除目录' },
  { re: /\bunlink\b/, reason: 'unlink 删除文件' },
  { re: /\bshred\b/, reason: 'shred 安全擦除' },
  // 移动/覆盖/写文件（决策 6.4：凡改文件一律破坏，与文件守卫同安全水位）
  { re: /\bmv\b/, reason: 'mv 移动/覆盖' },
  { re: /\bcp\b/, reason: 'cp 复制/覆盖文件' },
  { re: /\bln\b/, reason: 'ln 建链接/覆盖目标' },
  { re: /\binstall\b/, reason: 'install 覆盖文件' },
  { re: /\brsync\b/, reason: 'rsync 同步写文件（--delete 会镜像删除）' },
  { re: /\btruncate\b/, reason: 'truncate 截断文件' },
  { re: /\btee\b/, reason: 'tee 写文件' },
  { re: /\bpatch\b/, reason: 'patch 原地改文件' },
  // 原地编辑（in-place）
  { re: /\b(g?sed)\b[^|;&]*\s-[a-zA-Z]*i/, reason: 'sed -i 原地改写文件' },
  { re: /\bperl\b[^|;&]*\s-[a-zA-Z]*i/, reason: 'perl -i 原地改写文件' },
  // 磁盘/格式化
  { re: /\bdd\b/, reason: 'dd 直写磁盘' },
  { re: /\bmkfs\S*/, reason: 'mkfs 格式化' },
  { re: /\bdiskutil\s+(erase|reformat|partition|apfs)/, reason: 'diskutil 抹盘/改分区' },
  // 提权/权限
  { re: /\bsudo\b/, reason: 'sudo 提权' },
  { re: /\bdoas\b/, reason: 'doas 提权' },
  { re: /\bchmod\b/, reason: 'chmod 改权限' },
  { re: /\bchown\b/, reason: 'chown 改属主' },
  { re: /\bchgrp\b/, reason: 'chgrp 改属组' },
  // 进程/服务/定时
  { re: /\b(p?kill|killall)\b/, reason: 'kill 杀进程' },
  { re: /\bcrontab\b/, reason: 'crontab 改定时任务' },
  { re: /\blaunchctl\b/, reason: 'launchctl 改服务' },
  { re: /\bsystemctl\b/, reason: 'systemctl 改服务' },
  { re: /\bdefaults\s+(delete|write|import)/, reason: 'defaults 改系统/应用配置' },
  // 解压（写/覆盖任意路径）
  { re: /\btar\b[^|;&]*\s-?[a-zA-Z]*[xc]/, reason: 'tar 解压/打包（写文件）' },
  // 装卸软件包 / 远程执行
  {
    re: /\b(brew|npm|pnpm|yarn|pip|pip3|apt|apt-get|gem|cargo|go|gradle|gh)\s+(install|uninstall|remove|rm|add)\b/,
    reason: '装卸软件包',
  },
  { re: /\b(npx|pnpx|bunx|dlx)\b/, reason: '下载并执行远程包（≈ curl|sh）' },
  // git 丢数据/改历史
  {
    re: /\bgit\s+(reset\s+--hard|push\b[^|;&]*(--force|--force-with-lease|-f)\b|clean\b[^|;&]*-[a-zA-Z]*f|checkout\s+(--\s+)?\.|restore\b[^|;&]*\.|stash\s+(drop|clear)|branch\b[^|;&]*-D|update-ref\b[^|;&]*\s-d|reflog\s+expire|gc\b[^|;&]*--prune)/,
    reason: 'git 破坏性操作（丢改动/改历史）',
  },
];

/** 关键系统路径前缀——rm/mv 命中则强化告警（路径硬防线，决策 6.3.4）。
 *  注：`/var` 在 macOS 是混合区——`/var/db`、`/var/log` 是系统区，而 `/var/folders`（$TMPDIR）、`/var/tmp`
 *  是用户可写临时区、非系统关键。后者由 SAFE_TEMP_PREFIXES 在判定前短路豁免，避免把临时目录误标"极高风险"。 */
const CRITICAL_PREFIXES = ['/', '/etc', '/usr', '/bin', '/sbin', '/var', '/Library', '/System', '/boot', '/dev'];

/** 用户可写临时目录——非系统关键，命中即不算高危。列 macOS `/var`→`/private/var` 软链两形。 */
const SAFE_TEMP_PREFIXES = ['/tmp', '/var/tmp', '/var/folders', '/private/tmp', '/private/var/tmp', '/private/var/folders'];

/** shell 解释器——执行任意代码（含管道喂 stdin 的 `curl … | sh`、跑脚本的 `bash x.sh`）。看不透就判破坏。 */
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** 代码解释器——带内联代码 flag（-e/-c/--eval/-r 加载即执行…）时执行静态看不透的脚本，判破坏。 */
const CODE_INTERPRETERS = new Set([
  'perl', 'python', 'python2', 'python3', 'ruby', 'node', 'nodejs', 'php', 'osascript', 'deno', 'bun',
]);
// -e/-c/-E 内联代码、--eval/--command、--require/-r（node 加载即执行模块顶层代码，绕过 -e）
const INLINE_CODE_FLAG = /(^|\s)-([a-zA-Z]*[ecE])\b|--eval\b|--command\b|--require\b|(^|\s)-r\b/;
/** awk 族——图灵完整、能 system() 调 shell、能 print>"file" 写盘。仅当脚本含 system( 或 > 时判破坏，
 *  保留 `ls | awk '{print $1}'` 这类高频只读用法顺畅。 */
const AWK_FAMILY = new Set(['awk', 'gawk', 'mawk', 'nawk']);

/**
 * 主入口：拆分 + 破坏性判定。cwd 用于把 rm/mv 的相对路径解析成绝对再判路径硬防线。
 */
export function analyzeBashCommand(command: string, cwd: string = process.cwd()): BashAnalysis {
  // ── 第 0 层：保守兜底 ──
  const suspicious = findSuspiciousStructure(command);
  if (suspicious) {
    return { isDestructive: true, segments: [{ text: command.trim(), destructive: true, reason: suspicious, opaque: true }] };
  }

  // ── 第 1 层：拆段 ──
  const parts = splitCommand(command);
  const segments: BashSegment[] = parts.map((text) => classifySegment(text, cwd));
  const isDestructive = segments.some((s) => s.destructive);
  return { isDestructive, segments };
}

/**
 * 第 0 层：检测无法可靠静态分析的结构，命中返回中文原因；干净返回 null。
 * 引号感知——引号内的分隔符/危险词不触发（echo "a; b" / echo "rm -rf /" 不误判）。
 */
function findSuspiciousStructure(command: string): string | null {
  let inS = false;
  let inD = false;
  let unquoted = ''; // 引号外的字符骨架，供后续词级检查
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (inS) {
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === '\\') {
        i++; // 跳过转义字符
        continue;
      }
      if (c === '"') inD = false;
      else if (c === '$' && command[i + 1] === '(') return '双引号内命令替换 $()';
      else if (c === '`') return '双引号内反引号命令替换';
      continue;
    }
    // 引号外
    if (c === '$') {
      const nx = command[i + 1];
      if (nx === '(') return '含命令替换 $()';
      if (nx === "'") return "含 ANSI-C 转义 $'...'";
      if (command.startsWith('IFS', i + 1) || command.startsWith('{IFS', i + 1)) return '含 $IFS（混淆）';
      unquoted += c;
      continue;
    }
    if (c === '`') return '含反引号命令替换';
    if (c === '(' || c === ')') return '含子 shell / 分组 ( )';
    if (c === "'") {
      inS = true;
      continue;
    }
    if (c === '"') {
      inD = true;
      continue;
    }
    unquoted += c;
  }
  if (inS || inD) return '引号未配对（畸形命令）';

  // 词级间接执行检查（在引号外骨架上）。eval 要求作为命令出现，避免 node --eval / medieval 误中
  if (/(^|[\s;|&(])eval\b/.test(unquoted)) return '含 eval 间接执行';
  if (/\bxargs\b/.test(unquoted)) return '含 xargs 间接执行';
  if (/\b(sh|bash|zsh|ksh|dash)\s+-[a-zA-Z]*c\b/.test(unquoted)) return '含 shell -c 间接执行';
  if (/(^|[;&|]\s*)env\s+\S/.test(unquoted)) return '含 env 包装器';
  if (/\bfind\b/.test(unquoted) && /\s-(exec|execdir|delete|fdelete|ok|fprint0?)\b/.test(unquoted)) {
    // -exec/-delete 间接执行/删除；-fprint/-fprint0 是 find 原生写文件 action（不经 shell 重定向）
    return 'find 带 -exec/-delete/-fprint';
  }

  // 后台执行 &：去掉 fd 复制(2>&1/>&2)、&&、&> 后仍有 & → 后台
  const noFd = unquoted.replace(/\d*>&\d*/g, ' ').replace(/&&/g, ' ').replace(/&>/g, ' ');
  if (noFd.includes('&')) return '含后台执行 &';

  return null;
}

/**
 * 第 1 层：按顶层分隔符 换行/;/&&/||/管道 拆段（引号内不拆）。换行与 ; 等价当命令分隔，让纯
 * 多行命令逐段判定、而非整条因换行就判破坏；引号内换行（多行字符串）不拆。
 * 调用前提：已过第 0 层（无子 shell/命令替换/后台），故顶层分隔符可安全识别。
 */
export function splitCommand(command: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let inS = false;
  let inD = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (inS) {
      cur += c;
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      cur += c;
      if (c === '"') inD = false;
      continue;
    }
    if (c === "'") {
      inS = true;
      cur += c;
      continue;
    }
    if (c === '"') {
      inD = true;
      cur += c;
      continue;
    }
    // 顶层分隔符（换行与 ; 等价，都是命令分隔）
    if (c === ';' || c === '\n') {
      segs.push(cur);
      cur = '';
      continue;
    }
    if (c === '&' && command[i + 1] === '&') {
      segs.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '|' && command[i + 1] === '|') {
      segs.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '|') {
      // 排除 fd 复制 >&… 不会出现 |；这里的 | 即管道
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 第 2/3 层：破坏性判定 + 投递识别（两轴正交：一段可同时是破坏性与对外投递）。 */
function classifySegment(text: string, cwd: string): BashSegment {
  const seg = classifySegmentBase(text, cwd);
  const delivery = detectSegmentDelivery(text);
  return delivery ? { ...seg, delivery } : seg;
}

/** 第 2/3 层：判定单段是否破坏性。 */
function classifySegmentBase(text: string, cwd: string): BashSegment {
  const bare = stripQuotes(stripWrappersAndEnv(text));
  const baseTok = bare.trim().split(/\s+/)[0] ?? '';
  const baseName = baseTok.split('/').pop() ?? baseTok; // 剥 /bin/sh → sh

  // 动态命令名（变量展开/命令替换）——基命令看不透，无法静态判定（堵 `${RM_CMD} x` / `$CMD x`）
  if (baseTok.includes('$') || baseTok.includes('`')) {
    return { text, destructive: true, reason: '动态命令名（变量展开/替换），无法静态判定' };
  }
  // shell 解释器——执行任意代码（含 `curl … | sh` 的 sh 段、`bash x.sh`）
  if (SHELL_INTERPRETERS.has(baseName)) {
    return { text, destructive: true, reason: `${baseName} 执行任意代码（看不透）` };
  }
  // 代码解释器带内联代码 flag（node -e / python -c / perl -e / node -r …）——脚本内容静态看不透
  if (CODE_INTERPRETERS.has(baseName) && INLINE_CODE_FLAG.test(bare)) {
    return { text, destructive: true, reason: `${baseName} 内联代码/加载执行（看不透）` };
  }
  // awk 族：脚本含 system( 或重定向 > 时判破坏（在 raw text 上查——脚本体在引号内，stripQuotes 会清空）
  if (AWK_FAMILY.has(baseName) && /system\s*\(|>/.test(text)) {
    return { text, destructive: true, reason: 'awk system()/重定向写文件（看不透）' };
  }
  // lark-cli 写飞书内容——在 raw text 上按命令结构识别（抗引号绕过，见 larkWriteCommand）
  const larkReason = larkWriteCommand(text);
  if (larkReason) return { text, destructive: true, reason: larkReason };

  for (const { re, reason } of DESTRUCTIVE_PATTERNS) {
    if (re.test(bare)) {
      // 路径硬防线：rm/mv 命中关键系统路径 → 强化告警
      if ((/\brm\b/.test(bare) || /\bmv\b/.test(bare) || /\brmdir\b/.test(bare)) && hitsCriticalPath(bare, cwd)) {
        return { text, destructive: true, reason: `${reason}（命中关键系统路径，极高风险）` };
      }
      return { text, destructive: true, reason };
    }
  }

  // 写文件重定向：去掉 fd 复制(2>&1)和丢弃到 /dev/null（无害且高频）后仍有 > → 写文件（决策 6.4）
  if (hasWriteRedirect(bare)) {
    return { text, destructive: true, reason: '输出重定向写文件' };
  }

  return { text, destructive: false };
}

/** lark-cli 可执行名（npx 形式 `npx @larksuite/cli …` 已被装包 pattern 判破坏，无需在此重复）。 */
const LARK_BASES = new Set(['lark-cli', 'lark']);
/**
 * 写动作词根——覆盖 +create / +update / resource-delete / +media-insert / +media-upload /
 * +whiteboard-update / batch_create 等长短与连字符变体。读类（+fetch/+search/+media-download/
 * +media-preview/resource-download/list/get/view/status/read…）不含这些词根，自然放过。
 */
const LARK_WRITE_ROOT = /(^|[-_+])(create|update|delete|insert|upload|remove|patch|import)([-_]|$)/;

/**
 * lark-cli 写命令识别（三方平台 §7）——按命令结构、抗引号绕过：写子命令永远在「base 之后、
 * 第一个 flag 之前」的位置参数上，绝不在 --flag 的值里。故只扫这些位置 token（逐 token 去引号
 * 字符，挡住 `docs "+create"` 这类绕过），按写动作词根判定；api 域按 HTTP 方法（非 GET/HEAD 即写）。
 * 命中返回中文原因；非 lark-cli 或读命令返回 null。在 raw text 上跑（stripQuotes 会清空引号内容）。
 */
function larkWriteCommand(text: string): string | null {
  const toks = stripWrappersAndEnv(text).trim().split(/\s+/);
  const base = (toks[0] ?? '').split('/').pop() ?? '';
  if (!LARK_BASES.has(base)) return null;

  // 全局扫描带：+写动作子命令（+create/+media-upload…）不会作为 --flag 的值出现，故全 token 扫描
  // 安全无误判——兜住「子命令前塞全局 flag」绕过（lark-cli --token x docs +create）。
  for (const t of toks.slice(1)) {
    const bare = t.replace(/['"]/g, '');
    if (bare.startsWith('+') && LARK_WRITE_ROOT.test(bare.slice(1))) return `lark-cli ${bare} 写飞书内容（破坏性）`;
  }

  // 位置参数（base 之后、第一个 flag 之前）：裸写动词 / api 方法只在此判——裸词若全 token 扫描
  // 会误伤 --query "create" 这类 flag 值，故限定在位置参数上。
  const positionals: string[] = [];
  for (const t of toks.slice(1)) {
    if (t.startsWith('-')) break;
    positionals.push(t.replace(/['"]/g, ''));
  }
  if (positionals[0] === 'api') {
    const method = (positionals[1] ?? '').toUpperCase();
    if (method && method !== 'GET' && method !== 'HEAD') return `lark-cli api ${method} 写操作`;
    return null;
  }
  for (const p of positionals) {
    if (LARK_WRITE_ROOT.test(p.replace(/^\+/, ''))) return `lark-cli ${p} 写飞书内容（破坏性）`;
  }
  return null;
}

// ── 对外投递识别（S04 投递档 · G74）─────────────────────────────────────────
// 口径：凡「向环境之外的人或服务送出内容」的段标 delivery——纯网络客户端按基命令、
// 双面命令（git/gh/npm）按联网子命令＋参数地址形态、渠道 CLI 复用 larkWriteCommand。
// 与破坏性判定同一份保守精神：网络客户端提不出地址也照标（recipient=null，宁可误拦）；
// 长尾（解释器内联、看不透结构）由第 0 层与解释器判定承接，不另建第二套兜底。

/** 纯网络客户端——基命令本身就是把数据送出这台机器的通道。 */
const NETWORK_CLIENT_BASES = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'ftp', 'lftp', 'telnet', 'rsync',
]);
/** 邮件客户端——channel='email'，收件人即邮箱。 */
const EMAIL_CLIENT_BASES = new Set(['mail', 'sendmail']);

/** 从 token 中提取地址形态：URL / user@host(:path) / host.tld:path / scp 裸主机与 IP（host:/path）。
 *  scp 形态要求冒号后紧跟 / 或 ~（路径起始）——避开 git refspec（HEAD:main）这类冒号误伤。 */
function extractAddresses(toks: string[]): string[] {
  const out: string[] = [];
  for (const t of toks) {
    if (t.startsWith('-')) continue;
    if (/^https?:\/\//i.test(t)) out.push(t);
    else if (/^[\w.+-]+@[\w][\w.-]*(:|$)/.test(t)) out.push(t);
    else if (/^[\w][\w.-]*\.[a-zA-Z]{2,}:/.test(t)) out.push(t);
    else if (/^[\w][\w.-]*:[/~]/.test(t)) out.push(t);
  }
  return out;
}

/** 地址 → host（S24 授权键的收件人粒度）：剥 scheme、剥 user@、截到首个分隔符。 */
function hostOfAddress(a: string): string | null {
  let s = a.replace(/^https?:\/\//i, '');
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  const m = s.match(/^[\w][\w.-]*/);
  return m ? m[0]! : null;
}

/** git：push/fetch/pull/clone 参数含地址形态、remote add/set-url 写入自拟地址 → 投递；
 *  对既有 remote 名操作不标（地址来自仓库配置，非模型自拟）。 */
function gitDelivery(toks: string[]): BashSegment['delivery'] {
  let i = 1;
  while (i < toks.length) {
    const t = toks[i]!;
    if (GIT_ARG_FLAGS.has(t)) { i += 2; continue; }
    if (t.startsWith('-')) { i += 1; continue; }
    break;
  }
  const sub = toks[i];
  const rest = toks.slice(i + 1);
  const networked =
    sub === 'push' || sub === 'fetch' || sub === 'pull' || sub === 'clone' ||
    (sub === 'remote' && (rest[0] === 'add' || rest[0] === 'set-url'));
  if (!networked) return undefined;
  const addresses = extractAddresses(rest);
  if (addresses.length > 0) {
    return { channel: 'web', recipient: hostOfAddress(addresses[0]!), addresses };
  }
  // 提不出规范地址但参数含变量展开（git push $E）——静态看不透目的地，照标投递（宁可误拦，
  // 不给「先赋值再 push」留 fail-open 侧门）；纯 remote 名 / 本地路径（无 $ 无地址形态）不标。
  if (rest.some((t) => !t.startsWith('-') && t.includes('$'))) {
    return { channel: 'web', recipient: null, addresses: [] };
  }
  return undefined;
}

/** gh 全局吃参 flag——跳过它们才能定位子命令（gh -R owner/repo release upload）。 */
const GH_ARG_FLAGS = new Set(['-R', '--repo', '--hostname']);

/** gh：gist create / release create|upload / api 写方法（-X 非 GET/HEAD 或带 field/input）→ 投递。 */
function ghDelivery(toks: string[]): BashSegment['delivery'] {
  const positionals: string[] = [];
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]!;
    if (GH_ARG_FLAGS.has(t)) { i += 1; continue; }
    if (t.startsWith('-')) continue;
    positionals.push(t);
  }
  const [p0, p1] = positionals;
  const hit =
    (p0 === 'gist' && p1 === 'create') ||
    (p0 === 'release' && (p1 === 'create' || p1 === 'upload')) ||
    (p0 === 'api' && ghApiWrites(toks));
  if (!hit) return undefined;
  return { channel: 'web', recipient: 'github.com', addresses: [] };
}

function ghApiWrites(toks: string[]): boolean {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === '-X' || t === '--method') {
      const m = (toks[i + 1] ?? '').toUpperCase();
      if (m && m !== 'GET' && m !== 'HEAD') return true;
    }
    if (t.startsWith('--method=') || (t.startsWith('-X') && t.length > 2)) {
      // 兼容 --method=POST 与连写 -XPOST / -X=POST
      const m = (t.startsWith('--method=') ? t.slice('--method='.length) : t.slice(2).replace(/^=/, '')).toUpperCase();
      if (m && m !== 'GET' && m !== 'HEAD') return true;
    }
    if (t === '-f' || t === '-F' || t === '--field' || t === '--raw-field' || t === '--input' ||
        t.startsWith('--field=') || t.startsWith('--raw-field=') || t.startsWith('--input=')) {
      return true; // 带请求体即写（gh api 有 field 默认 POST）
    }
  }
  return false;
}

/** npm/pnpm/yarn publish：内容公开外发，目的地固定也算投递；--registry 自拟时按其 host。 */
function npmPublishDelivery(toks: string[]): BashSegment['delivery'] {
  // 子命令取首个非 flag 位置参数（npm --registry=X publish 这类前置全局 flag 不挡判定）
  const sub = toks.slice(1).find((t) => !t.startsWith('-'));
  if (sub !== 'publish') return undefined;
  let registry: string | null = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === '--registry') registry = toks[i + 1] ?? null;
    else if (t.startsWith('--registry=')) registry = t.slice('--registry='.length);
  }
  const recipient = registry ? hostOfAddress(registry) : 'registry.npmjs.org';
  return { channel: 'web', recipient, addresses: registry ? [registry] : [] };
}

/** lark-cli 写命令的收件人（尽力提取：--chat-id/--receive-id/--user-id/--open-id/--email）。 */
function larkRecipient(text: string): string | null {
  const toks = stripWrappersAndEnv(text).trim().split(/\s+/);
  const FLAGS = ['--chat-id', '--receive-id', '--user-id', '--open-id', '--email'];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    for (const f of FLAGS) {
      if (t === f) return (toks[i + 1] ?? '').replace(/['"]/g, '') || null;
      if (t.startsWith(f + '=')) return t.slice(f.length + 1).replace(/['"]/g, '') || null;
    }
  }
  return null;
}

/** 单段投递识别入口。返回 undefined = 非投递段。 */
function detectSegmentDelivery(text: string): BashSegment['delivery'] {
  // 渠道 CLI：写命令识别复用 larkWriteCommand（在 raw text 上跑，抗引号绕过）
  if (larkWriteCommand(text)) {
    return { channel: 'feishu', recipient: larkRecipient(text), addresses: [] };
  }

  // 逐 token 去引号字符而非 stripQuotes 整段清空——引号里正是地址本体（curl 'https://…'），
  // 清空会让地址提取失败、recipient 恒 null（会话级授权与 S24 持久授权都对不上键）。
  const toks = stripWrappersAndEnv(text)
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/['"]/g, ''))
    .filter(Boolean);
  const baseTok = toks[0] ?? '';
  const baseName = baseTok.split('/').pop() ?? baseTok;

  if (EMAIL_CLIENT_BASES.has(baseName)) {
    const addr = toks.slice(1).find((t) => !t.startsWith('-') && /^[\w.+-]+@[\w][\w.-]*$/.test(t)) ?? null;
    return { channel: 'email', recipient: addr, addresses: addr ? [addr] : [] };
  }
  if (NETWORK_CLIENT_BASES.has(baseName)) {
    const addresses = extractAddresses(toks.slice(1));
    // rsync 本地形态维持破坏表现状、不标投递；其余网络客户端提不出地址也照标（宁可误拦）
    if (baseName === 'rsync' && addresses.length === 0) return undefined;
    return { channel: 'web', recipient: addresses[0] ? hostOfAddress(addresses[0]) : null, addresses };
  }
  if (baseName === 'git') return gitDelivery(toks);
  if (baseName === 'gh') return ghDelivery(toks);
  if (baseName === 'npm' || baseName === 'pnpm' || baseName === 'yarn') return npmPublishDelivery(toks);
  return undefined;
}

/** 聚合段级投递为 proposal 级目标与地址（bash.ts 填 proposal.delivery / 判用户逐字地址用）。 */
export function collectDelivery(segments: BashSegment[]): {
  targets: DeliveryTarget[];
  addresses: string[];
} {
  const targets: DeliveryTarget[] = [];
  const addresses: string[] = [];
  for (const s of segments) {
    if (!s.delivery) continue;
    targets.push({
      channel: s.delivery.channel,
      recipient: s.delivery.recipient,
      label: s.text.length > 120 ? s.text.slice(0, 120) + '…' : s.text,
    });
    addresses.push(...s.delivery.addresses);
  }
  return { targets, addresses };
}

/**
 * 去引号骨架上是否含「写文件」重定向：剥掉 fd 复制（2>&1 / >&2）和丢弃到 /dev/null（无害且高频）
 * 后仍有 > / >> → 写文件。破坏性判定与只读判定共用此一处（单源，决策 6.4）。
 */
export function hasWriteRedirect(bare: string): boolean {
  let noFd = bare.replace(/\d*>&\d*/g, ' '); // fd 复制 2>&1 / >&2
  noFd = noFd.replace(/(?:&|\d*)>>?\s*\/dev\/null\b/g, ' '); // 丢弃到 /dev/null
  return />/.test(noFd);
}

/** 剥离前导包装命令（timeout/nice/nohup/stdbuf/time）与前导 env 变量赋值，取真实命令。 */
function stripWrappersAndEnv(text: string): string {
  let toks = text.trim().split(/\s+/);
  for (;;) {
    // 前导 env var 赋值 FOO=bar
    if (toks[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) {
      toks = toks.slice(1);
      continue;
    }
    const head = toks[0];
    if (head === 'nohup' || head === 'time') {
      toks = toks.slice(1);
      continue;
    }
    if (head === 'timeout') {
      // timeout [flags] DURATION cmd...：跳到 DURATION 之后
      let i = 1;
      while (toks[i] && toks[i]!.startsWith('-')) i++;
      if (toks[i]) i++; // 跳过 DURATION
      toks = toks.slice(i);
      continue;
    }
    if (head === 'nice' || head === 'stdbuf') {
      let i = 1;
      while (toks[i] && toks[i]!.startsWith('-')) {
        // -n N 这种带值的多跳一个
        if ((toks[i] === '-n') && toks[i + 1]) i += 2;
        else i++;
      }
      toks = toks.slice(i);
      continue;
    }
    break;
  }
  return toks.join(' ');
}

/** 去掉成对引号内的内容（保留引号外），用于破坏性 pattern 匹配——避免字符串里的危险词误判。 */
function stripQuotes(text: string): string {
  let out = '';
  let inS = false;
  let inD = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inS) {
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === '"') inD = false;
      continue;
    }
    if (c === "'") {
      inS = true;
      continue;
    }
    if (c === '"') {
      inD = true;
      continue;
    }
    out += c;
  }
  return out;
}

/** rm/mv 段的目标路径（相对按 cwd 解析成绝对）是否命中关键系统路径或 home 根。 */
function hitsCriticalPath(bare: string, cwd: string): boolean {
  const toks = bare.split(/\s+/).slice(1); // 去掉基命令
  const home = homedir();
  for (const t of toks) {
    if (t.startsWith('-')) continue; // flag
    let p = t;
    if (p === '~' || p.startsWith('~/')) p = p.replace(/^~/, home);
    if (p === '$HOME') p = home;
    const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
    // 临时目录非系统关键，跳过该 token（防 /var/folders、/var/tmp 等被 /var 前缀误判）。
    if (SAFE_TEMP_PREFIXES.some((pre) => abs === pre || abs.startsWith(pre + '/'))) continue;
    if (abs === home) return true;
    for (const pre of CRITICAL_PREFIXES) {
      if (abs === pre) return true;
      // /etc 本身或其直接挂在根的关键目录
      if (pre !== '/' && abs.startsWith(pre + '/')) return true;
    }
    if (abs === '/') return true;
  }
  return false;
}

/**
 * 火灰断路器（审批模式 PRD）：判定命令是否「绝对灾难」——删根 / 家、抹盘、格式化。
 * 危险模式下也硬拦的唯一窄子集。
 *
 * 与 classifySegment 方向相反：那里在「去引号骨架」上判破坏性；这里要**穿透**命令替换 $()、
 * 反引号、单层变量赋值,看到真实毁灭意图（`$(rm -rf /)` / `X=rm; $X -rf /` 都当 `rm -rf /` 看）。
 * rm 必须目标是根 / 家才算（`rm -rf ./build` 不算,守住「零打扰」）。多层间接 / 编码混淆扫不全,
 * 属已知接受的长尾——这种形态出现在文档工作流里几乎必是注入攻击,与现有破坏性判定同立场。
 */
export function isCatastrophic(command: string): boolean {
  const flat = flattenForCatastrophic(command);
  if (/\bdd\b[^|;&]*\bof=\/dev\//.test(flat)) return true; // dd 直写整盘
  if (/\bmkfs\S*/.test(flat)) return true; // 格式化
  if (/\bdiskutil\s+(erase|reformat|partition|apfs)/i.test(flat)) return true; // 抹盘/改分区（apfs 与 DESTRUCTIVE_PATTERNS 对齐）
  return hasRmRootWipe(flat); // rm 递归删根/家/系统目录本身
}

/**
 * 递归删除即系统报废 / 家目录尽毁的目标——必须是目录**本身**(不含其下子路径),
 * 这样 `rm -rf /usr` 拦、`rm -rf /usr/local/foo` 放行,既守灾难又不破坏「零打扰」。
 */
const ROOT_WIPE_TARGETS = new Set([
  '/', '/*', '/.', '~', '$HOME',
  '/usr', '/etc', '/bin', '/sbin', '/var', '/Library', '/System', '/boot', '/tmp',
  // macOS：/etc /var /tmp 是符号链接，真身在 /private 下——写真身路径是同一灾难的等价写法
  '/private', '/private/etc', '/private/var', '/private/tmp',
]);

/** 拍平：单层变量内联 + `${X}`→`$X` 归一 + 剥命令替换 / 反引号 / 引号包裹符,保留内部文本供毁灭特征匹配。 */
function flattenForCatastrophic(command: string): string {
  const vars: Record<string, string> = {};
  for (const m of command.matchAll(/(?:^|[\s;|&])(\w+)=([^\s;|&]+)/g)) vars[m[1]!] = m[2]!;
  // $VAR / ${VAR}：已知赋值则内联,否则去括号归一(${HOME}→$HOME),让带括号/不带括号走同一判定
  const s = command.replace(/\$\{?(\w+)\}?/g, (_whole, name) => (name in vars ? vars[name]! : '$' + name));
  return s.replace(/\$\(/g, ' ').replace(/[`()'"]/g, ' ');
}

/**
 * 只读命令白名单（只读重构 PRD §2.2）——基命令本身纯查询、不写盘、不改环境。
 *
 * 方向与破坏性判定一致但更严：不是 `!isDestructive`（存在「既不破坏也不只读」的第三态——
 * make / 任意 `> file` / `git log --output=f`），而是**正向举证**：基命令在册 AND 无写重定向
 * AND 无该命令已知写选项，三重与才算只读。不在册或看不透 → 判非只读（fail-closed，只误拒不误放）。
 *
 * 刻意排除：解释器（node/python/sh…，能跑任意代码）、装卸（npm/brew…）、构建（make）、
 * 带 `-o file` 写选项的 sort/tee 等——它们误拒可切 work，但绝不能在只读挡放行。
 */
const READONLY_BASE = new Set([
  // 文件查看 / 列目录 / 元信息
  'ls', 'cat', 'head', 'tail', 'pwd', 'stat', 'file', 'wc', 'du', 'df', 'tree',
  'realpath', 'dirname', 'basename', 'readlink',
  // 搜索（find 带 -exec/-delete 已被第 0 层兜底判非只读）
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find',
  // 文本流处理（只写 stdout；写 file 必经重定向，已被 hasWriteRedirect 拦）
  'echo', 'printf', 'uniq', 'cut', 'tr', 'column', 'comm', 'diff', 'cmp', 'nl', 'fold',
  // 环境/定位查询
  'which', 'type', 'whereis', 'date', 'whoami', 'id', 'hostname', 'uname',
]);

/** git 只读子命令（写子命令如 commit/add/push、以及任何带 --output/-o 写 flag 的段一律判非只读）。 */
const GIT_READONLY_SUBCMDS = new Set([
  'log', 'status', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file',
  'describe', 'blame', 'shortlog', 'grep', 'name-rev', 'whatchanged', 'count-objects', 'var',
]);

/** git 全局前置 flag 中「吃下一个 token 作参数」的——跳过它们才能定位真正的子命令。 */
const GIT_ARG_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/**
 * 只读命令判定（白名单 fail-closed）：复用第 0 层兜底 + 拆段 + 逐段判，任一段非只读则整条非只读。
 * 用于审批挡位「只读」硬约束——只读命令放行、写类及看不透的直接拒。
 */
export function isReadOnlyCommand(command: string): { ok: boolean; reason?: string } {
  // 第 0 层：看不透的结构（命令替换/后台/eval/sh -c…）一律判非只读（与破坏性判定同口径）
  const suspicious = findSuspiciousStructure(command);
  if (suspicious) return { ok: false, reason: suspicious };

  const parts = splitCommand(command);
  if (parts.length === 0) return { ok: false, reason: '空命令' };
  for (const text of parts) {
    if (!isSegmentReadOnly(text)) return { ok: false, reason: `非只读命令段：${text}` };
  }
  return { ok: true };
}

/** 单段是否只读：基命令在白名单 AND 无写重定向 AND 无该命令已知写选项（git 特判）。 */
function isSegmentReadOnly(text: string): boolean {
  const bare = stripQuotes(stripWrappersAndEnv(text));
  const toks = bare.trim().split(/\s+/).filter(Boolean);
  const baseTok = toks[0] ?? '';
  const baseName = baseTok.split('/').pop() ?? baseTok; // 剥 /bin/ls → ls

  // 动态命令名（变量展开/命令替换）——看不透
  if (baseTok.includes('$') || baseTok.includes('`')) return false;
  // 写重定向 → 写文件
  if (hasWriteRedirect(bare)) return false;
  // git：仅只读子命令，且无 --output/-o 写 flag
  if (baseName === 'git') return isGitReadOnly(toks);
  return READONLY_BASE.has(baseName);
}

/** git 段是否只读：跳过吃参全局 flag 定位子命令；子命令在只读集 AND 无 --output/-o 写 flag。 */
function isGitReadOnly(toks: string[]): boolean {
  // --output=f / --output f / -o f 都是写文件 flag（git log --output 写盘）→ 判非只读
  if (toks.some((t) => t === '--output' || t.startsWith('--output=') || t === '-o')) return false;
  let i = 1; // 跳过 'git'
  while (i < toks.length) {
    const t = toks[i]!;
    if (GIT_ARG_FLAGS.has(t)) { i += 2; continue; } // 吃下一个 token 作参数
    if (t.startsWith('-')) { i += 1; continue; } // 其余前置 flag
    break;
  }
  const sub = toks[i];
  return sub != null && GIT_READONLY_SUBCMDS.has(sub);
}

/** 拍平文本里是否有 `rm` 同时带 -r 与 -f、且目标命中根 / 家 / 系统目录本身（尾斜杠归一）。 */
function hasRmRootWipe(flat: string): boolean {
  for (const m of flat.matchAll(/(?:^|[\s;|&])rm\b([^;|&]*)/g)) {
    const toks = m[1]!.trim().split(/\s+/).filter(Boolean);
    const flagToks = toks.filter((t) => t.startsWith('-'));
    // 短 flag 看字母袋(-rf/-fr)，长 flag 精确匹配——否则 `--force` 自带的 r/f 字母会被误当成递归+强制
    const shortFlags = flagToks.filter((t) => !t.startsWith('--')).join('');
    // 大小写不敏感：rm 的 -R 与 -r 都是递归；force 侧同理放宽（-F 非法命令本就不执行，多认无误伤）
    const recursive = /r/i.test(shortFlags) || flagToks.includes('--recursive');
    const force = /f/i.test(shortFlags) || flagToks.includes('--force');
    if (!(recursive && force)) continue; // 必须递归 + 强制
    for (let t of toks.filter((t) => !t.startsWith('-'))) {
      if (t.length > 1 && t.endsWith('/')) t = t.slice(0, -1); // 尾斜杠归一：/usr/ → /usr、$HOME/ → $HOME
      if (ROOT_WIPE_TARGETS.has(t)) return true;
    }
  }
  return false;
}
