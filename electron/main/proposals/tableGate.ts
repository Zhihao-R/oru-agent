/**
 * tableGate —— AI 出口闸门：动手前查草稿与编码（PRD 场景四「AI 与草稿的分工」/ 验收 7、8）。
 *
 * "动手"按定义算：凡以文件为输入或输出、发生在视图之外的动作（bash 脚本、write/edit 代改、
 * 导出）都过这道闸。两条检查：
 *   - 脏文件：执行前**同步** rendererQuery 拉脏集（md+表格并集），提案文本命中脏文件名
 *     （相对/绝对/裸文件名形态）→ 拦截。超时**保守拦截**不放行——眼睛读草稿可降级读磁盘，
 *     手闸降级放行就是事故。
 *   - 编码：提案文本引用的已存在 CSV 编码不安全（GBK/BOM/无法识别）→ 拦截。
 *     **只拦编码、不拦风格**（判据分层的论证见 @shared/csv 的 isEncodingSafe）：拦风格
 *     只会把 AI 锁在自己刚写的文件外——它给长文本裹一对多余引号即可触发，此后连 cat 都
 *     被拦、只能删文件重建。引号风格改由 write_file / append_file 在产出时定型。
 *
 * **被拦的一方必须有一条它自己能走的路。** 2026-07-26 那次事故的病根不是拦错了，是文案给的
 * 出路（"选『转为规范格式』或『另存规范副本』后再继续"）是用户侧 UI 操作、agent 按不了，
 * 于是它 delete 原文件再 write_file 重建，内容缩水且用户不知情。所以两支各有各的出路：
 * 草稿支只能转告用户去保存，编码支指向 convert_csv_encoding（AI 能发起、用户一键确认的转换提案）。
 *
 * 编码检查的适用面按**不可逆性**划，不按"这算不算动手"：只有会把解码后的内容写回文件的动作
 * 才可能产出混合编码的坏文件且原字节回不来。只读命令（cat / wc）、delete / move / rename
 * 都不消费也不产出内容，一律 skipEncodingCheck。不要另起"命令是读还是写"的新文本判据——
 * 下面的匹配已是一层公开承认不完备的近似，在它上面叠第二层同类近似只会更糟。
 *
 * 诚实声明：文本匹配判定"以哪个文件为输入"不可能完备——两层近似（文本匹配 + prompt
 * 注入脏清单）+ 执行后校验兜底，不做 fs 层拦截。
 */
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { isEncodingSafe } from '@shared/csv';
import { textsReferenceFile } from '@shared/fileRefMatch';
import { rendererQuery, type DirtySetResult } from '../agent/rendererQuery';
import { getSettings } from '../projects/store';
import { resolveEffectiveLang } from '../i18n/effectiveLang';
import { t } from '../i18n/t';

// 超过此尺寸跳过编码检查（要整读；超大 CSV 本就走超限只读动线）
const ENCODING_CHECK_MAX_BYTES = 64 * 1024 * 1024;
const CSV_TOKEN_RE = /[^\s"'`;|&()<>]+\.csv\b/gi;

/** 闸门文案按 owner 语言取词。只在真要抛错时解析——放行路径不为它多读一次设置。 */
async function gateText(key: string, params: Record<string, unknown>): Promise<string> {
  const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
  return t(`main:tableGate.${key}`, lang, params);
}

export async function assertTableGate(
  texts: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    /** 这次动作不会把解码后的内容写回文件（只读命令 / delete / move / rename）→ 不可逆性为零，跳过编码检查 */
    skipEncodingCheck?: boolean;
  },
): Promise<void> {
  // ── 脏文件检查 ──
  let dirty: DirtySetResult;
  try {
    dirty = await rendererQuery<DirtySetResult>('dirtySet', {}, opts.timeoutMs);
  } catch {
    throw new Error(await gateText('editorUnreachable', {}));
  }
  for (const path of dirty.paths) {
    if (textsReferenceFile(texts, path)) {
      throw new Error(await gateText('draftUnsaved', { name: basename(path) }));
    }
  }

  // ── 编码检查（已存在的 CSV）──
  if (!opts.cwd || opts.skipEncodingCheck) return;
  const seen = new Set<string>();
  for (const text of texts) {
    for (const token of text.match(CSV_TOKEN_RE) ?? []) {
      const abs = isAbsolute(token) ? token : join(opts.cwd, token);
      if (seen.has(abs)) continue;
      seen.add(abs);
      let bytes: Buffer;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > ENCODING_CHECK_MAX_BYTES) continue;
        bytes = await fs.readFile(abs);
      } catch {
        continue; // 不存在 = 脚本的新输出，放行
      }
      if (isEncodingSafe(new Uint8Array(bytes))) continue;
      throw new Error(await gateText('encodingNotUtf8', { path: abs }));
    }
  }
}
