/**
 * CSV 数据内核合约测试 —— 解析/序列化互逆、规范判定下沉字节层、编码探测。
 *
 * 承重承诺（tech design「数据内核」节）：
 *   - isEncodingSafe 的入参是字节：GBK / BOM 文件在字符串层等式可能为真，字节层必须为假，
 *     否则 ⌘S 会以 UTF-8 静默改写全文件字节（PRD 验收 7 的反例）。
 *   - serialize(parse(text)) === text 当且仅当 text 已是规范格式。
 *   - 空内容特判为规范（新建空表第一次保存不弹"转规范"确认）。
 */
import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import {
  canonicalizeCsvText,
  decodeCsvBytes,
  isEncodingSafe,
  parseCsv,
  parseTsv,
  serializeCsv,
  serializeTsv,
} from '@shared/csv';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('parseCsv', () => {
  it('首行为表头，其余为数据行，全字符串', () => {
    const t = parseCsv('名称,金额\n张三,100\n李四,200\n');
    expect(t.headers).toEqual(['名称', '金额']);
    expect(t.rows).toEqual([
      ['张三', '100'],
      ['李四', '200'],
    ]);
  });

  it('空内容 → 空表', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });

  it('仅表头一行', () => {
    expect(parseCsv('a,b\n')).toEqual({ headers: ['a', 'b'], rows: [] });
  });

  it('尾部恰好一个换行只剥一个空行记录：两个换行时尾空行是数据', () => {
    expect(parseCsv('a,b\n\n').rows).toEqual([['']]);
  });

  it('中部空行是合法数据，不吞', () => {
    expect(parseCsv('a,b\n\nc,d\n').rows).toEqual([[''], ['c', 'd']]);
  });

  it('引号包裹的逗号/换行/转义引号', () => {
    const t = parseCsv('a,b\n"x,1","说 ""hi""\n第二行"\n');
    expect(t.rows).toEqual([['x,1', '说 "hi"\n第二行']]);
  });

  it('重复列名不被改写（数组模型）', () => {
    expect(parseCsv('金额,金额\n1,2\n').headers).toEqual(['金额', '金额']);
  });

  it('混合行尾：以 LF 为主的文件里 CRLF 行的 \\r 残留在字段内', () => {
    const t = parseCsv('a,b\nc,d\r\n');
    expect(t.rows).toEqual([['c', 'd\r']]);
  });
});

describe('serializeCsv', () => {
  it('规范序列化：LF 行尾、末尾单个换行', () => {
    expect(serializeCsv({ headers: ['a', 'b'], rows: [['1', '2']] })).toBe('a,b\n1,2\n');
  });

  it('空表 → 空字符串', () => {
    expect(serializeCsv({ headers: [], rows: [] })).toBe('');
  });

  it('含逗号/引号/换行/回车的格子裹引号，引号转义为双引号', () => {
    expect(serializeCsv({ headers: ['h'], rows: [['x,1'], ['说"hi"'], ['两\n行'], ['残留\r']] })).toBe(
      'h\n"x,1"\n"说""hi"""\n"两\n行"\n"残留\r"\n',
    );
  });

  it('与 parse 互逆：规范文本 serialize(parse(text)) === text', () => {
    for (const text of [
      'a,b\n1,2\n',
      'a,b\n',
      'a,b\n\n',
      'a,b\n\nc,d\n',
      'h\n"x,1"\n"说""hi"""\n"两\n行"\n',
      '\n',
    ]) {
      expect(serializeCsv(parseCsv(text))).toBe(text);
    }
  });
});

describe('decodeCsvBytes', () => {
  it('无 BOM 合法 UTF-8 → verbatim true', () => {
    const r = decodeCsvBytes(utf8('名,值\n张三,1\n'));
    expect(r.text).toBe('名,值\n张三,1\n');
    expect(r.verbatim).toBe(true);
  });

  it('带 BOM 的 UTF-8 → 剥 BOM，verbatim false', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('a,b\n')]);
    const r = decodeCsvBytes(bytes);
    expect(r.text).toBe('a,b\n');
    expect(r.verbatim).toBe(false);
  });

  it('GBK 字节 → 正确解码为中文，verbatim false', () => {
    const bytes = new Uint8Array(iconv.encode('名,值\n张三,1\n', 'gbk'));
    const r = decodeCsvBytes(bytes);
    expect(r.text).toBe('名,值\n张三,1\n');
    expect(r.verbatim).toBe(false);
  });

  it('非文本字节（UTF-16 BOM 开头的二进制）→ 报无法识别编码，不静默当 GBK', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00, 0x43, 0x00, 0x0a, 0x00]);
    expect(() => decodeCsvBytes(bytes)).toThrow(/无法识别编码/);
  });
});

/**
 * isEncodingSafe 是「要不要让用户拍板」的唯一判据（保存 / 导出 / AI 出口闸门共用）：
 * GBK/BOM/无法识别的转换会重写全文件字节且探测可能误判，必须有人确认；风格差异（多余引号 /
 * CRLF / 缺尾换行）重写无损，用户无可判之处，不该成为拦截理由——旧的 isCanonical（编码 && 风格）
 * 正是因此在 2026-07-28 退场。
 */
describe('isEncodingSafe（字节层，只问编码不问风格）', () => {
  it('风格不规范但编码干净 → 安全', () => {
    expect(isEncodingSafe(utf8('"a","b"\n'))).toBe(true); // 多余引号
    expect(isEncodingSafe(utf8('a,b\r\n1,2\r\n'))).toBe(true); // CRLF
    expect(isEncodingSafe(utf8('a,b'))).toBe(true); // 缺尾换行
  });

  it('空内容 → 安全', () => {
    expect(isEncodingSafe(new Uint8Array(0))).toBe(true);
  });

  it('GBK / BOM / 无法识别 → 不安全', () => {
    expect(isEncodingSafe(new Uint8Array(iconv.encode('名,值\n张三,1\n', 'gbk')))).toBe(false);
    expect(isEncodingSafe(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('a,b\n')]))).toBe(false);
    expect(isEncodingSafe(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00]))).toBe(false);
  });
});

describe('canonicalizeCsvText（只做减法的规范化）', () => {
  it('摘掉不必要的引号，数据一字不变', () => {
    expect(canonicalizeCsvText('a,b\n"全角；标点，无需引号",2\n')).toBe('a,b\n全角；标点，无需引号,2\n');
  });

  it('必要引号保留', () => {
    expect(canonicalizeCsvText('h,i\n"含,逗号",2\n')).toBe('h,i\n"含,逗号",2\n');
  });

  it('已规范文本原样返回（幂等）', () => {
    const text = '名,值\n张三,1\n';
    expect(canonicalizeCsvText(text)).toBe(text);
  });

  it('整份文件的 CRLF 行尾归一为 LF、补齐尾换行', () => {
    expect(canonicalizeCsvText('a,b\r\n1,2')).toBe('a,b\n1,2\n');
  });

  it('空内容原样返回（不产出无端换行）', () => {
    expect(canonicalizeCsvText('')).toBe('');
  });
});

/**
 * 安全阀：规范化只被授权做减法（摘冗余引号、归一行尾、补尾换行），无权重新断句。
 *
 * parseCsv 的分隔符钉死为逗号，但 .csv 在真实世界里有分号（德/法语区 Excel 默认导出）、
 * tab 等变体，还可能有破损引号或压根不是表格的内容。对这些文件按逗号模型 parse 再
 * serialize，不是"重排引号"而是"按错误的结构重新解释"——整行会被裹进一个字段、行数会变。
 * 判据取"引号只减不增"：摘冗余引号必然减少引号，而任何重新断句都要靠新增引号才能表达，
 * 一增即证明 parse 没能忠实理解原文，此时放弃规范化、原样返回。
 */
describe('canonicalizeCsvText 安全阀（引号只减不增，否则原样退回）', () => {
  const untouched = (text: string) => expect(canonicalizeCsvText(text)).toBe(text);

  it('分号分隔的表（德/法语区 Excel 默认导出）原样退回', () => {
    untouched('Name;Betrag;Notiz\nMüller;1.234,56;"Zahlung; Rest offen"\n');
  });

  it('tab 分隔的表原样退回', () => {
    untouched('Name\tNote\nA\t"x, y"\n');
  });

  it('引号后带尾随字符的破损行原样退回', () => {
    untouched('a,"b"c,d\n');
  });

  it('被误写进 .csv 的非表格内容原样退回', () => {
    untouched('{"rows": [{"a": 1, "b": "x,y"}]}\n');
  });

  it('混合行尾原样退回——papaparse 只按猜中的那种断句，另一种会被吞进单元格', () => {
    untouched('a,b\r\nc,d\ne,f\r\n');
    untouched('h1,h2\na,b\r\nc,d\n');
  });

  // 老 Mac（OS 9 时代）行尾是裸 CR，papaparse 认得。这里能规范化，是因为整份文件行尾一致、
  // 断句没有歧义；文末那条空记录由 parseCsv 的尾行剥离处理（它认全部三种行尾）。
  it('纯裸 CR 行尾整份归一，且文末不多出空行', () => {
    expect(canonicalizeCsvText('a,b\rc,d\r')).toBe('a,b\nc,d\n');
  });

  /**
   * 字段内的换行是**数据**，不是行尾。曾经在入口无条件 `replaceAll('\r\n','\n')`，
   * 把用户从 Excel 粘进单元格的多行备注里的 CRLF 静默删成 LF——字节被改、且因为
   * replaceAll 单趟非重叠匹配，连续多个 \r 每调用一次只吃掉一个，函数还因此不幂等。
   */
  it('字段内的 CRLF 是数据，一个字节都不动', () => {
    untouched('a,b\n"含\r\n换行的备注",2\n');
    untouched('"a\r\nb",c\n');
  });

  it('字段内的裸 \\r 同样不动', () => {
    untouched('a,b\n"含\r回车",2\n');
  });

  it('幂等：施加两次与一次结果相同', () => {
    for (const input of ['"a\r\r\nb",c\n', '"a","b"\n', 'a,b\r\nc,d\ne,f\r\n', 'a,b\rc,d\r', '名,值\n张三,1\n']) {
      const once = canonicalizeCsvText(input);
      expect(canonicalizeCsvText(once)).toBe(once);
    }
  });

  /**
   * 只数引号总数会被"跨位置补贴"骗过：一处合法的冗余引号（表头 `"h1","h2","h3"` 摘掉省 6 个）
   * 可以替另一处的引号错乱买单（裸引号转义成 `""` 多花 2 个），净减 4 个即通过判据，
   * 而那处错乱已经让 papaparse 把两条记录揉成了一条。所以还要看 parse 有没有报错：
   * 引号扫描出错就是"没看懂原文"的直接证据，此时一律不动。
   */
  it('引号总数不增但 parse 报错的输入原样退回（跨位置补贴攻击）', () => {
    untouched('"h1","h2","h3"\na,"p\nx"y"z",b\n');
  });

  /**
   * papaparse 会静默丢弃"引号闭合后的尾随字符"且不报错（tab 分隔表里只有部分字段带引号时
   * 就长这样）。引号数因为摘掉了那对引号而净减、errors 也是空的——前两道判据都拦不住，
   * 只有直接比对"数据字节"能抓到：规范化只许动引号和行尾，其余字符必须一个不差。
   */
  it('引号闭合后的尾随字符不被静默丢弃', () => {
    untouched('"1"\t\r中中\t');
    untouched('"a"\t"b"\n');
  });
});

/**
 * TSV 剪贴板载荷 —— 与 Excel / Sheets / 飞书 互通的序列化。
 *
 * 承重承诺：
 *   - 正确性由三方软件的实际读写定义，不由「与我们的 CSV 内核一致」定义。
 *     复用 serializeField 只是因为规则恰好重合（避免两份实现漂移），不是依据。
 *   - serializeTsv 末尾不补换行：文件规范要求尾换行，剪贴板载荷不是文件。
 *   - parseTsv 沿用尾部空行剥离：Excel 复制 N 行产出的文本以行尾结尾，
 *     不剥会让每次粘贴凭空多一个空行。
 */
describe('TSV 剪贴板序列化', () => {
  it('普通内容不加引号，制表符分隔、LF 断行、末尾不补换行', () => {
    expect(serializeTsv([['a', 'b'], ['c', 'd']])).toBe('a\tb\nc\td');
  });

  it('空输入 → 空字符串', () => {
    expect(serializeTsv([])).toBe('');
    expect(parseTsv('')).toEqual([]);
  });

  it('含制表符的字段裹引号——逗号不再触发（分隔符已换）', () => {
    expect(serializeTsv([['a\tb', 'x,y']])).toBe('"a\tb"\tx,y');
  });

  it('含换行/引号的字段裹引号，引号转义为双引号', () => {
    expect(serializeTsv([['多行\n文本', '他说"好"']])).toBe('"多行\n文本"\t"他说""好"""');
  });

  it('Excel 口径：复制 3 行产出的尾随 CRLF 不解出第 4 个空行', () => {
    expect(parseTsv('a\tb\r\nc\td\r\ne\tf\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('无尾随换行的文本不被误剥', () => {
    expect(parseTsv('a\tb\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('中部空行是合法数据，不吞', () => {
    expect(parseTsv('a\n\nb\n')).toEqual([['a'], [''], ['b']]);
  });

  it('往返一致：制表符 / 换行 / 引号 / 三者混合', () => {
    const rows = [
      ['纯文本', '含\t制表符'],
      ['含\n换行', '含"引号"'],
      ['三者\t混\n合"了"', ''],
    ];
    expect(parseTsv(serializeTsv(rows))).toEqual(rows);
  });

  it('单个单元格往返（单值铺满的载荷形态）', () => {
    expect(parseTsv(serializeTsv([['已完成']]))).toEqual([['已完成']]);
  });
});

/**
 * 参数化分隔符后 serializeCsv 的既有行为必须一字不变——
 * 它是「规范格式」的定义本体，xlsx 转换确定性与导入 diff 判定都建立在它之上。
 */
describe('serializeCsv 回归（分隔符参数化后）', () => {
  it('逗号仍触发裹引号，制表符不触发', () => {
    expect(serializeCsv({ headers: ['a,b', 'c\td'], rows: [] })).toBe('"a,b",c\td\n');
  });
});
