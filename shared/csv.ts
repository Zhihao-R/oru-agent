/**
 * CSV 数据内核 —— 解析 / 序列化 / 编码探测 / 规范判定（main 与 renderer 共用的纯函数）。
 *
 * 放 shared/ 的原因：main 进程 import 不到 src/（tsconfig.node 只含 electron/+shared/）。
 *
 * 两个承重承诺（tech design「数据内核」节）：
 *   - serializeCsv 是「规范格式」的定义本体：UTF-8 无 BOM、LF 行尾、仅必要引号、末尾单个换行。
 *     xlsx 转换确定性、导入 diff 冲突判定都建立在它之上。
 *   - isEncodingSafe 入参是字节不是字符串：GBK / BOM 文件在字符串层等式可能为真，
 *     ⌘S 以 UTF-8 写回会静默改写全文件字节——"确认之前原件逐字节不变"只有字节层守得住。
 */
import Papa from 'papaparse';
import iconv from 'iconv-lite';

export type CsvTable = { headers: string[]; rows: string[][] };

export type DecodedCsv = {
  text: string;
  /** 当且仅当字节流是无 BOM 的合法 UTF-8（解码经过 GBK 或剥过 BOM 都为假） */
  verbatim: boolean;
  encoding: 'utf-8' | 'gbk';
};

/**
 * 分词单点：papaparse 仅作底层分词，配置钉死不依赖默认——header:false（数组模型，
 * 重复列名不被改写）、不开 skipEmptyLines（中部空行是合法数据）。
 * errors 一并带出，供 canonicalizeCsvText 判「这份文本 papaparse 到底有没有看懂」。
 *
 * 分隔符是参数：文件走逗号、剪贴板走制表符，断句与引号扫描的规则本体只有这一份。
 */
function tokenizeRecords(text: string, delimiter: string): { records: string[][]; errors: unknown[] } {
  if (text === '') return { records: [], errors: [] };
  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: false,
    delimiter,
    quoteChar: '"',
    escapeChar: '"',
    dynamicTyping: false,
  });
  const records = result.data;
  // 尾部空行剥离要认全部三种行尾：papaparse 按它探测到的行尾断句，只认 \n 会让纯 CR 行尾的
  // 老 Mac 文件多留一条空记录（表格里凭空多一个空行）。`last[0] === ''` 的守卫保证探测结果
  // 与文件结尾不一致时（结尾那个字符成了字段内容）不会误删真数据。
  if (/[\r\n]$/.test(text)) {
    const last = records[records.length - 1];
    if (last && last.length === 1 && last[0] === '') records.pop();
  }
  return { records, errors: result.errors ?? [] };
}

/** CSV 视角：首条记录是表头，其余是数据行。 */
function tokenize(text: string): { table: CsvTable; errors: unknown[] } {
  const { records, errors } = tokenizeRecords(text, ',');
  const [headers = [], ...rows] = records;
  return { table: { headers, rows }, errors };
}

/** 与 serializeCsv 严格互逆：原文以行尾结尾时剥恰好一个尾部空行记录。 */
export function parseCsv(text: string): CsvTable {
  return tokenize(text).table;
}

/** 含分隔符 / 引号 / 换行 / 回车（混合行尾解析后字段内可能残留裸 \r）的格子裹引号，引号转义双引号。 */
function serializeField(field: string, delimiter: string): string {
  if (field.includes(delimiter) || /["\n\r]/.test(field)) return `"${field.replaceAll('"', '""')}"`;
  return field;
}

/** 序列化（规范格式的定义本体）：LF 行尾、仅必要引号、文件末尾单个换行；空表 → 空字符串。 */
export function serializeCsv(table: CsvTable): string {
  const records = [table.headers, ...table.rows];
  if (records.length === 1 && table.headers.length === 0) return '';
  return records.map((row) => row.map((f) => serializeField(f, ',')).join(',') + '\n').join('');
}

/**
 * 剪贴板载荷（TSV）—— 与 Excel / Sheets / 飞书互通的形态。
 *
 * 复用 serializeField 是因为引号规则恰好重合（一份实现不会漂），**不是依据**：
 * 剪贴板序列化的正确性由三方软件的实际读写定义，规则变了以三方为准。
 *
 * 与 serializeCsv 的两处契约差异：
 *   - 不分表头——剪贴板上只是一块格子，没有「首行是表头」这回事。
 *   - 末尾不补换行——尾换行是*文件*规范，粘进别处会凭空多一行。
 */
export function serializeTsv(rows: string[][]): string {
  return rows.map((row) => row.map((f) => serializeField(f, '\t')).join('\t')).join('\n');
}

/**
 * 解析剪贴板 TSV。沿用尾部空行剥离——Excel 复制 N 行产出的文本以 CRLF 结尾，
 * 不剥会让每次粘贴凭空多一个空行；剥离自带的守卫保证无尾随换行的文本不被误伤。
 */
export function parseTsv(text: string): string[][] {
  return tokenizeRecords(text, '\t').records;
}

/** 可疑字符（替换字符 / 除 \t\n\r 外的控制字符）占比阈值——超过即判"无法识别编码"。 */
const SUSPICIOUS_RATIO = 0.02;

function suspiciousRatio(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) n++;
  }
  return n / text.length;
}

/**
 * 编码探测：先严格 UTF-8（fatal），失败再 iconv-lite GBK。
 * GBK 对任意字节几乎不报错——两条路径的解码结果都过可疑字符占比启发，
 * 超阈值抛"无法识别编码"，不把 Latin1/UTF-16 静默当 GBK。
 * 内核只解码不落盘；转换确认（含"另存副本"出口）由上层对话框负责。
 */
export function decodeCsvBytes(bytes: Uint8Array): DecodedCsv {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let utf8Text: string | null = null;
  try {
    utf8Text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    utf8Text = null;
  }
  if (utf8Text !== null) {
    const text = hasBom ? utf8Text.slice(1) : utf8Text;
    if (suspiciousRatio(text) > SUSPICIOUS_RATIO) throw new Error('无法识别编码：文件不是 UTF-8 或 GBK 文本');
    return { text, verbatim: !hasBom, encoding: 'utf-8' };
  }
  const gbkText = iconv.decode(Buffer.from(bytes), 'gbk');
  if (suspiciousRatio(gbkText) > SUSPICIOUS_RATIO) throw new Error('无法识别编码：文件不是 UTF-8 或 GBK 文本');
  return { text: gbkText, verbatim: false, encoding: 'gbk' };
}

const countQuotes = (text: string): number => {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x22) n++;
  return n;
};

/** 剥掉引号与行尾后剩下的字符——规范化被授权改动的就只有这两类，其余必须一字不差。 */
const dataBytes = (text: string): string => text.replace(/["\r\n]/g, '');

/**
 * 规范化（只做减法）：摘掉不必要的引号、把整份文件的行尾归一为 LF、补齐尾换行。
 * **只要拿不准就原样退回**——一个字节都不动。
 *
 * 为什么需要"拿不准就退回"：分隔符钉死为逗号，但 .csv 在真实世界里有分号（德/法语区 Excel
 * 的默认导出）、tab 等变体，还可能有破损引号或压根不是表格的内容。对这些文件按逗号模型
 * parse 再 serialize，做的不是"重排引号"而是"按错误的结构重新断句"——整行被裹进一个字段、
 * 行数都会变，是实打实的数据损坏。
 *
 * 三道判据都得过，各挡一类实测存在的损坏，缺一不可：
 *  - **数据字节不变**：直接检查授权边界——除引号与行尾，其余字符必须一字不差。papaparse 会
 *    静默丢弃"引号闭合后的尾随字符"（部分字段带引号的 tab 表就长这样）且不报错，只有这条能抓。
 *  - **引号只减不增**：摘冗余引号必然让引号变少，重新断句只能靠新增引号才表达得出来。
 *    分号表被裹成单字段时数据字节恰好不变，只有这条能抓。
 *  - **parse 无错**：papaparse 的引号扫描一报错就说明它没看懂原文。前两条会被"跨位置补贴"
 *    骗过——一处合法冗余引号摘掉省下的额度替另一处引号错乱买单，而那处错乱已经把两条记录
 *    揉成了一条。
 *
 * 注意行尾归一只能由 serializeCsv 在重建时完成，不能在入口对原文做 replace：字段内的换行
 * 是**数据**（用户从 Excel 粘进单元格的多行备注），动它就是删字节。
 */
export function canonicalizeCsvText(text: string): string {
  const { table, errors } = tokenize(text);
  if (errors.length > 0) return text;
  const out = serializeCsv(table);
  if (dataBytes(out) !== dataBytes(text)) return text;
  return countQuotes(out) <= countQuotes(text) ? out : text;
}

/**
 * 编码安全（字节层）：无 BOM 的合法 UTF-8 且能解出文本。
 *
 * 这是"要不要让用户拍板"的唯一判据：GBK / BOM 转换要重写全文件字节、探测还可能误判，
 * 毁了原件回不来，必须有人确认且必须留"另存副本"出口；风格差异（多余引号 / CRLF /
 * 缺尾换行）重写无损，用户没有可判之处——把它也算作需确认，只会拦住无害操作。
 */
export function isEncodingSafe(bytes: Uint8Array): boolean {
  try {
    return decodeCsvBytes(bytes).verbatim; // 空字节即合法空 UTF-8，无需特判
  } catch {
    return false;
  }
}

// 曾有一个 isCanonical（编码 && 风格都规范）作为「要不要弹转换确认」的判据，2026-07-28 撤掉：
// 风格重写无损、用户没有可判之处，拿它拦保存/导出只是问一句他答不上来的话。判据统一为
// isEncodingSafe，风格由 canonicalizeCsvText 在写出时顺手理平，不再作为拦截理由。
